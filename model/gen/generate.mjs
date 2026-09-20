// Node driver for the synthetic data generator (M3).
//
// Serves this directory (plus three from node_modules and any images dropped
// into model/backgrounds/) over a loopback HTTP server, opens scene.html in
// headless Chrome via puppeteer, and pulls one rendered PNG + label JSON per
// sample out of window.renderSample.
//
// DECISION: puppeteer/headless-Chrome over the `gl` native module — it renders
// with the exact WebGL stack the web app uses, needs no native build on
// Windows, and 20k images at ~10-20/s is an overnight-at-worst job.
//
//   node generate.mjs --count 20000 --out ../data [--seed 1] [--style mix]
//     [--cornerBias 0.3]   (or env var CORNER_BIAS=0.3; see scene.mjs)
//     [--twist 0.3] [--rest 0.12]   fraction of cubes with a layer mid-turn
//                          (0-90 deg, blur, hand on the layer) / left slightly
//                          misaligned at rest (M13, scene.mjs buildCube)
//
// Resumes by default: existing images in the output dir are kept and numbering
// continues after them. Use a fresh --out (or delete the dir) to start over.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const genDir = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean),
);
const COUNT = parseInt(args.count ?? '100', 10);
const OUT = resolve(genDir, args.out ?? '../data');
const BASE_SEED = parseInt(args.seed ?? '1', 10);
const STYLE = args.style ?? 'mix'; // mix | stickered | stickerless
const WIDTH = parseInt(args.width ?? '640', 10);
const HEIGHT = parseInt(args.height ?? '480', 10);
// M4: fraction of scenes forced near-corner-on (see scene.mjs). CLI flag
// wins over the env var; both default to 0 = current behavior unchanged.
const CORNER_BIAS = Number(args.cornerBias ?? process.env.CORNER_BIAS ?? 0);
// M13: layer twist fractions. Defaults are the data_v6 recipe; --twist 0
// --rest 0.22 reproduces the pre-twist distribution (rest misalignment only).
const TWIST_FRAC = Number(args.twist ?? process.env.TWIST_FRAC ?? 0.3);
const REST_FRAC = Number(args.rest ?? process.env.REST_FRAC ?? 0.12);

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const bgDir = resolve(genDir, '../backgrounds');

function safeJoin(root, rel) {
  const p = resolve(root, '.' + rel.replaceAll('..', ''));
  return p.startsWith(root) ? p : null;
}

async function main() {
  // Real photo backgrounds are optional: drop COCO (or any) images into
  // model/backgrounds/ and 40% of samples will use them.
  let photoUrls = [];
  if (existsSync(bgDir)) {
    const files = (await readdir(bgDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    photoUrls = files.map((f) => '/backgrounds/' + encodeURIComponent(f));
  }
  // HDRI environments (model/backgrounds/hdri/*.hdr): image-based lighting +
  // real-room backgrounds. Optional like the photos, but strongly recommended.
  let hdriUrls = [];
  const hdriDir = join(bgDir, 'hdri');
  if (existsSync(hdriDir) && !process.env.DEBUG_NO_HDRI_URLS) {
    hdriUrls = (await readdir(hdriDir)).filter((f) => /\.hdr$/i.test(f))
      .map((f) => '/backgrounds/hdri/' + encodeURIComponent(f));
  }
  if (!hdriUrls.length) console.warn('no HDRIs in model/backgrounds/hdri/ - falling back to analytic lights only');
  if (CORNER_BIAS > 0) console.log(`cornerBias=${CORNER_BIAS}: forcing that fraction of scenes near-corner-on`);
  console.log(`twist=${TWIST_FRAC} (layer mid-turn, 0-90 deg) rest=${REST_FRAC} (layer misaligned at rest)`);

  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (url === '/' || url === '/index.html') file = join(genDir, 'scene.html');
    else if (url.startsWith('/backgrounds/')) file = safeJoin(bgDir, url.slice('/backgrounds'.length));
    else file = safeJoin(genDir, url);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found: ' + url);
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    // Linux: 'shell' = chrome-headless-shell, not full Chrome, because full
    // Chrome cannot start inside the WSL sandbox (crashpad, AF_UNIX sockets -
    // docs/wsl-sandbox.md "Chrome and torch inside the sandbox"); the shell
    // renders over SwiftShader at ~1.5/s. Windows: full headless Chrome, which
    // gets the GPU and did data_v5 at 12.8/s. GEN_HEADLESS=shell|chrome overrides.
    headless: (process.env.GEN_HEADLESS ?? (process.platform === 'win32' ? 'chrome' : 'shell')) === 'chrome' ? true : 'shell',
    // --no-sandbox: Chrome refuses to start as root ("Running as root without
    // --no-sandbox is not supported"), which is every container, including
    // the rented boxes in model/cloud/RUNBOOK.md. It costs nothing here: the
    // page we load is our own local scene, never untrusted web content.
    // --disable-dev-shm-usage: containers often ship a 64 MB /dev/shm and
    // Chrome dies part-way through a long render when it fills.
    args: ['--force-color-profile=srgb', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || process.env.DEBUG_LOG_SHADOW) console.error('[page]', m.text()); });
  if (process.env.DEBUG_SHADOW_TYPE) {
    const t = Number(process.env.DEBUG_SHADOW_TYPE);
    await page.evaluateOnNewDocument((v) => { window.DEBUG_SHADOW_TYPE = v; }, t);
  }
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.ready === true', { timeout: 30000 });
  if (process.env.DEBUG_FORCE_SHADOW) await page.evaluate(() => { window.DEBUG_FORCE_SHADOW = true; });
  if (process.env.DEBUG_SHADOW_MAX) await page.evaluate(() => { window.DEBUG_SHADOW_MAX = true; });
  if (process.env.DEBUG_NO_ENV) await page.evaluate(() => { window.DEBUG_NO_ENV = true; });
  if (process.env.DEBUG_LOG_SHADOW) await page.evaluate(() => { window.DEBUG_LOG_SHADOW = true; });
  if (process.env.DEBUG_SIMPLE_CUBE) await page.evaluate(() => { window.DEBUG_SIMPLE_CUBE = true; });
  if (process.env.DEBUG_FORCE_TABLE) await page.evaluate(() => { window.DEBUG_FORCE_TABLE = true; });
  if (process.env.DEBUG_MINIMAL) await page.evaluate(() => { window.DEBUG_MINIMAL = true; });
  if (process.env.DEBUG_MINIMAL_TABLE) await page.evaluate(() => { window.DEBUG_MINIMAL_TABLE = true; });
  if (process.env.DEBUG_MINIMAL_2LIGHT) await page.evaluate(() => { window.DEBUG_MINIMAL_2LIGHT = true; });
  if (process.env.DEBUG_MINIMAL_RANDCAM) await page.evaluate(() => { window.DEBUG_MINIMAL_RANDCAM = true; });

  const imgDir = join(OUT, 'images');
  const lblDir = join(OUT, 'labels');
  await mkdir(imgDir, { recursive: true });
  await mkdir(lblDir, { recursive: true });
  const existing = (await readdir(imgDir)).filter((f) => /^img_\d+\.png$/.test(f));
  let next = existing.length ? Math.max(...existing.map((f) => parseInt(f.slice(4, -4), 10))) + 1 : 1;
  if (existing.length) console.log(`resuming: ${existing.length} images already in ${imgDir}, continuing at ${next}`);

  const t0 = Date.now();
  for (let i = 0; i < COUNT; i++, next++) {
    const seed = BASE_SEED * 1_000_003 + next;
    // hash, not modulo: seed increments by 1, so `seed % 10` cycles with
    // period 10 and can alias with any periodic train/val split
    const styleHash = (Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0) % 10;
    const style = STYLE === 'mix' ? (styleHash < 7 ? 'stickered' : 'stickerless') : STYLE;
    const res = await page.evaluate(
      (opts) => window.renderSample(opts),
      { seed, style, width: WIDTH, height: HEIGHT, photoUrls, hdriUrls, cornerBias: CORNER_BIAS,
        twistFrac: TWIST_FRAC, restFrac: REST_FRAC },
    );
    const id = `img_${String(next).padStart(6, '0')}`;
    const png = Buffer.from(res.dataUrl.slice('data:image/png;base64,'.length), 'base64');
    await writeFile(join(imgDir, id + '.png'), png);
    await writeFile(join(lblDir, id + '.json'), JSON.stringify({ image: `images/${id}.png`, ...res.label }, null, 1));
    if ((i + 1) % 100 === 0 || i + 1 === COUNT) {
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`${i + 1}/${COUNT}  (${rate}/s)`);
    }
  }

  await browser.close();
  server.close();
  console.log(`done: ${COUNT} samples in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

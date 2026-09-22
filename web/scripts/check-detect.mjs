// Headless verification that the built app loads facekp.onnx in
// onnxruntime-web and runs inference (the browser half of the M4 export
// sanity check). Serves web/dist over loopback, opens the scan tab in
// headless Chrome (puppeteer borrowed from model/gen), and calls the page's
// __detectSelfTest hook.
//
//   node scripts/check-detect.mjs        (run `npm run build` first)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(webDir, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('web/dist/index.html missing - run `npm run build` first');
  process.exit(1);
}
const puppeteerPkg = resolve(webDir, '..', 'model', 'gen', 'node_modules', 'puppeteer');
const { default: puppeteer } = await import(pathToFileURL(join(puppeteerPkg, 'lib', 'esm', 'puppeteer', 'puppeteer.js')).href);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(dist, url === '/' ? 'index.html' : url.replaceAll('..', ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const browser = await puppeteer.launch({ headless: process.env.PUPPETEER_SHELL ? 'shell' : true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
// every wasm the page fetches, so a runtime that is not in ort/ (or is fetched twice) shows up
const wasmFetches = [];
page.on('response', (r) => { if (r.url().endsWith('.wasm')) wasmFetches.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/?tab=scan`);
for (const ep of ['webgpu', 'wasm']) {
  try {
    const img = process.env.CHECK_FRAME || '';
    if (img) {
      const probe = await page.evaluate(async (u) => {
        const out = {};
        for (const target of ['index.html', u, location.origin + u]) {
          try {
            const r = await fetch(target);
            out[target] = `${r.status} ${r.headers.get('content-type')} ${(await r.blob()).size}b`;
          } catch (e) { out[target] = 'THREW ' + e.message; }
        }
        out.origin = location.origin;
        return out;
      }, img);
      console.log(`    frame probe ${img}: ${JSON.stringify(probe)}`);
    }
    const result = await page.evaluate((e, u) => window.__detectSelfTest(30, e, u || undefined), ep, img);
    if (!result?.ok) {
      console.error(`self-test (${ep}) failed:`, JSON.stringify(result));
      process.exitCode = 1;
    } else {
      // Anonymous (center-v1) models report decoded quads as well as named
      // faces: on the synthetic self-test frame naming usually rejects
      // everything (a flat red square is not a cube face), so `faces` alone
      // would read as a failure when the model is in fact fine.
      const found = (result.anonymous ? `quads=${result.quads} named=${result.faces}` : `faces=${result.faces}`)
        + `  stage1=${result.stage1 ? (result.stage1.box ? `box obj ${result.stage1.obj}` : `miss obj ${result.stage1.obj}`) : 'n/a'}`;
      console.log(`OK  ep=${result.ep}${result.offThread ? " (worker)" : ""} x${result.threads}  avg ${result.avgMs.toFixed(1)} ms/inference  (${result.fps.toFixed(1)}/s desktop-headless)  ${found}  [${result.model}${result.anonymous ? ', anonymous' : ''}]`);
      if (process.env.CHECK_FRAME) {
        console.log(`    scores ${JSON.stringify(result.scores)}  names ${JSON.stringify(result.names)}`);
        console.log(`    first quad corners ${JSON.stringify(result.corner0)}`);
      }
    }
  } catch (e) {
    console.error(`self-test (${ep}) threw:`, e.message);
    process.exitCode = 1;
  }
}
console.log(`wasm fetched: ${wasmFetches.length ? wasmFetches.join(', ') : 'none'}`);
if (wasmFetches.some((f) => !f.startsWith('200 /ort/'))) { console.error('a wasm was fetched from outside ort/ or failed'); process.exitCode = 1; }
await browser.close();
server.close();

// Headless verification that the built app loads facekp.onnx in
// onnxruntime-web and runs inference (the browser half of the M4 export
// sanity check). Serves web/dist over loopback, opens detect.html in
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
if (!existsSync(join(dist, 'detect.html'))) {
  console.error('web/dist/detect.html missing - run `npm run build` first');
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

const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/detect.html`);
for (const ep of ['webgpu', 'wasm']) {
  try {
    const result = await page.evaluate((e) => window.__detectSelfTest(30, e), ep);
    if (!result?.ok) {
      console.error(`self-test (${ep}) failed:`, JSON.stringify(result));
      process.exitCode = 1;
    } else {
      console.log(`OK  ep=${result.ep}  avg ${result.avgMs.toFixed(1)} ms/inference  (${result.fps.toFixed(1)}/s desktop-headless)  faces=${result.faces}`);
    }
  } catch (e) {
    console.error(`self-test (${ep}) threw:`, e.message);
    process.exitCode = 1;
  }
}
await browser.close();
server.close();

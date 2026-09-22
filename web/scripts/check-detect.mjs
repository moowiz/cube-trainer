// Headless verification that the built app loads facekp.onnx in
// onnxruntime-web and runs inference (the browser half of the M4 export
// sanity check). Serves web/dist over loopback, opens the scan tab in
// headless Chrome, and calls the page's __detectSelfTest hook.
//
//   npm run check:detect        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';

const server = await serveDist();
const browser = await launchBrowser({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
// every wasm the page fetches, so a runtime that is not in ort/ (or is fetched twice) shows up
const wasmFetches = [];
page.on('response', (r) => { if (r.url().endsWith('.wasm')) wasmFetches.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${server.origin}/?tab=scan`);
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
      const found = `quads=${result.quads} refused=${result.refused}`
        + `  stage1=${result.stage1 ? (result.stage1.box ? `box obj ${result.stage1.obj}` : `miss obj ${result.stage1.obj}`) : 'n/a'}`;
      console.log(`OK  ep=${result.ep}${result.offThread ? " (worker)" : ""} x${result.threads}  avg ${result.avgMs.toFixed(1)} ms/inference  (${result.fps.toFixed(1)}/s desktop-headless)  ${found}  [${result.model}${result.anonymous ? ', anonymous' : ''}]`);
      if (process.env.CHECK_FRAME) {
        console.log(`    scores ${JSON.stringify(result.scores)}  refusals ${JSON.stringify(result.reasons)}`);
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

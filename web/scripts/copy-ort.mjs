// Copy onnxruntime-web's wasm binaries into public/ort/ so the app serves
// them itself (client-side only — no CDN fetch at runtime). Runs before dev
// and build via package.json pre-scripts; public/ort/ is gitignored.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(webDir, 'node_modules', 'onnxruntime-web', 'dist');
const dst = join(webDir, 'public', 'ort');
mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  // ort.min.mjs is the full ESM library: public/label.html (a no-build page)
  // imports it directly for its model-suggestion button.
  if (f.endsWith('.wasm') || f.endsWith('.jsep.mjs') || f === 'ort-wasm-simd-threaded.mjs' || f === 'ort.min.mjs') {
    copyFileSync(join(src, f), join(dst, f));
    n++;
  }
}
console.log(`copied ${n} onnxruntime-web runtime files -> public/ort/`);

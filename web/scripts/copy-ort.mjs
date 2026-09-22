// Copy onnxruntime-web's runtime files into public/ort/ so the app serves
// them itself (client-side only — no CDN fetch at runtime). Runs before dev
// and build via package.json pre-scripts; public/ort/ is gitignored.
//
// Only the files something actually loads (docs/maintenance-plan.md 2.1):
//   ort-wasm-simd-threaded.jsep.wasm  the one runtime the app's sessions load
//                                     (session.ts / ort.worker.ts set wasmPaths
//                                     to /ort/; the webgpu and wasm EPs share it)
//   ort-wasm-simd-threaded.jsep.mjs   its emscripten glue, needed by ort.min.mjs
//   ort.min.mjs                       the full ESM library: public/label.html (a
//                                     no-build page) imports it directly
// The asyncify / jspi / non-jsep wasm builds (56 MB) are never referenced by
// either entry point; copying them tripled the deploy.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(webDir, 'node_modules', 'onnxruntime-web', 'dist');
const dst = join(webDir, 'public', 'ort');
mkdirSync(dst, { recursive: true });
const FILES = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort.min.mjs'];
for (const f of FILES) copyFileSync(join(src, f), join(dst, f));
console.log(`copied ${FILES.length} onnxruntime-web runtime files -> public/ort/`);

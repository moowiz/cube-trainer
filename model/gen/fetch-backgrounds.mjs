// Downloads the real-photo background pool into model/backgrounds/ (which is
// gitignored - photos are fetched, never committed). Deterministic seeds so
// every machine gets the same pool. Run once:  node fetch-backgrounds.mjs
// generate.mjs picks these up automatically (photo scene backgrounds plus
// the backdrop/table planes that cover the scene background when in view).
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../backgrounds');
mkdirSync(outDir, { recursive: true });

function fetchTo(url, file, redirects = 5) {
  return new Promise((ok, err) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return fetchTo(new URL(res.headers.location, url).href, file, redirects - 1).then(ok, err);
      }
      if (res.statusCode !== 200) { res.resume(); return err(new Error(`${res.statusCode} for ${url}`)); }
      const w = createWriteStream(file);
      res.pipe(w);
      w.on('finish', ok);
      w.on('error', err);
    }).on('error', err);
  });
}

let done = 0;
for (let i = 1; i <= 80; i++) {
  const name = `photo_${String(i).padStart(3, '0')}.jpg`;
  const file = join(outDir, name);
  if (existsSync(file)) { done++; continue; }
  try {
    await fetchTo(`https://picsum.photos/seed/cube${i}/640/480`, file);
    done++;
  } catch (e) {
    console.warn(`skip ${name}: ${e.message}`);
  }
}
console.log(`${done}/80 photo backgrounds in ${outDir}`);

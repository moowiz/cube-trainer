// The PWA icons: a scrambled 3x3 face in the trainer's palette on the ink
// background, written as PNGs with pngjs (no image tooling needed).
//
//   node scripts/make-icons.mjs      -> public/icons/icon-{192,512}.png, icon-512-maskable.png
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'public', 'icons');
mkdirSync(out, { recursive: true });

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const INK = hex('#1B222C');
const TILES = ['#2E6CE0', '#E2433C', '#33B15D', '#F58F2A', '#FBFBF9', '#F5D63D', '#33B15D', '#2E6CE0', '#E2433C'].map(hex);

/** A face of `size` px: tiles inside a margin of `inset` (fraction of size), gaps between them, corners lightly rounded. */
function face(size, inset) {
  const png = new PNG({ width: size, height: size });
  const d = png.data;
  const put = (x, y, [r, g, b]) => { const i = (y * size + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, INK);
  const m = Math.round(size * inset);
  const span = size - 2 * m;
  const gap = Math.max(2, Math.round(span * 0.035));
  const tile = (span - 2 * gap) / 3;
  const radius = tile * 0.16;
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) {
    const colour = TILES[ty * 3 + tx];
    const x0 = m + tx * (tile + gap), y0 = m + ty * (tile + gap);
    for (let y = Math.floor(y0); y < Math.ceil(y0 + tile); y++) for (let x = Math.floor(x0); x < Math.ceil(x0 + tile); x++) {
      // rounded corners: outside the corner circles is background
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x0 + tile - radius), cy = Math.min(Math.max(y + 0.5, y0 + radius), y0 + tile - radius);
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > radius * radius) continue;
      if (x >= 0 && y >= 0 && x < size && y < size) put(x, y, colour);
    }
  }
  return PNG.sync.write(png);
}

writeFileSync(join(out, 'icon-192.png'), face(192, 0.1));
writeFileSync(join(out, 'icon-512.png'), face(512, 0.1));
// maskable: the launcher may crop to a circle, so keep the face inside the central 80%
writeFileSync(join(out, 'icon-512-maskable.png'), face(512, 0.2));
console.log(`wrote 3 icons to ${out}`);

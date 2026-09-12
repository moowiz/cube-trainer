// Fetch the HDRI environment maps the generator lights scenes with.
//
// `model/backgrounds/` is gitignored (it also holds personal photo
// backgrounds), so a fresh checkout - above all a rented cloud box, see
// model/cloud/RUNBOOK.md - has no HDRIs at all. generate.mjs then prints
// "no HDRIs ... falling back to analytic lights only" and renders a WHOLE
// DATASET under flat analytic lighting, which is a quietly different
// distribution from the one that was signed off. That failure is a warning
// on stderr, not an error, which is exactly how it goes unnoticed; this
// script exists so the runbook never has to rely on spotting it.
//
// The 16 slugs below are the set the local machine has. All are CC0 from
// polyhaven.com. Files are saved WITHOUT Poly Haven's `_1k` suffix, matching
// the local naming (the generator just globs *.hdr, so this is only for
// byte-for-byte parity with the machine the previews were reviewed on).
//
//   node fetch-hdris.mjs            # skips anything already present
//   node fetch-hdris.mjs --force    # re-download everything
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HDRIS = [
  'adams_place_bridge', 'artist_workshop', 'autoshop_01', 'brown_photostudio_02',
  'colorful_studio', 'courtyard', 'dikhololo_night', 'empty_warehouse_01',
  'hotel_room', 'lebombo', 'moonless_golf', 'peppermint_powerplant',
  'small_empty_house', 'st_fagans_interior', 'surgery', 'wooden_lounge',
];
const RES = '1k'; // ~1.6 MB each; the generator only needs it for lighting, not as a backdrop

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backgrounds', 'hdri');
const force = process.argv.includes('--force');

await mkdir(outDir, { recursive: true });

let fetched = 0;
let skipped = 0;
const failed = [];

for (const slug of HDRIS) {
  const dst = join(outDir, `${slug}.hdr`);
  if (!force && existsSync(dst)) {
    skipped++;
    continue;
  }
  try {
    // Ask the API rather than guessing the CDN path: the real filename
    // carries a resolution suffix (autoshop_01_1k.hdr), so the obvious
    // guess 404s.
    const metaRes = await fetch(`https://api.polyhaven.com/files/${slug}`);
    if (!metaRes.ok) throw new Error(`api ${metaRes.status}`);
    const meta = await metaRes.json();
    const url = meta?.hdri?.[RES]?.hdr?.url;
    if (!url) throw new Error(`no ${RES} hdr in api response`);
    const fileRes = await fetch(url);
    if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    await writeFile(dst, buf);
    fetched++;
    console.log(`  ${slug}.hdr  ${(buf.length / 1e6).toFixed(2)} MB`);
  } catch (err) {
    failed.push(`${slug}: ${err.message}`);
  }
}

const have = (await readdir(outDir)).filter((f) => /\.hdr$/i.test(f)).length;
console.log(`hdri: ${fetched} fetched, ${skipped} already present, ${have}/${HDRIS.length} on disk -> ${outDir}`);
if (failed.length) {
  console.error('FAILED:\n  ' + failed.join('\n  '));
  process.exit(1);
}
if (have < HDRIS.length) {
  console.error(`only ${have} of ${HDRIS.length} HDRIs present - generate.mjs would fall back to analytic lighting`);
  process.exit(1);
}

// Cut a recording session's video into one clip per timed solve
// (docs/smart-cube-design.md 4.2): for each line of solves.jsonl, the video
// from LEAD_S before the first turn to TAIL_S after the last, re-encoded so
// the cut is exact (MediaRecorder keyframes are seconds apart), into
// <session>/solves/NN-<id>.webm, with NN-<id>.json beside it: the solve's
// record, the cube events inside the clip (both clocks) and the offset that
// maps the session's host clock onto clip time. The dev server runs this when
// a session closes (vite.config.ts recordingSink); by hand:
//
//   node scripts/cut-solves.mjs ../recordings/<session> [--force]
//
// The session's video.webm stays: it is the continuous take the scramble
// following and the calibrations need. Needs ffmpeg on PATH.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// DECISION: three seconds before the first turn (the end of inspection, hands settling on the cube)
// and one after the last (the cube coming to rest, the timer stopping).
export const LEAD_S = 3, TAIL_S = 1;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** Cut every solve of `dir`; resolves with the clips written (skips ones that exist unless `force`). */
export async function cutSolves(dir, { force = false, log = () => undefined } = {}) {
  const metaFile = join(dir, 'meta.json'), solvesFile = join(dir, 'solves.jsonl'), video = join(dir, 'video.webm');
  if (!existsSync(metaFile) || !existsSync(solvesFile) || !existsSync(video)) return [];
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const solves = readFileSync(solvesFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cube = existsSync(join(dir, 'cube.jsonl'))
    ? readFileSync(join(dir, 'cube.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.kind)
    : [];
  const out = join(dir, 'solves');
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const [i, s] of solves.entries()) {
    const stem = `${String(i + 1).padStart(2, '0')}-${s.id}`;
    const clip = join(out, `${stem}.webm`);
    if (existsSync(clip) && !force) continue;
    // video time = host time - meta.t0 (the recorder started right after the session's meta was written)
    const from = Math.max(0, (s.t0 - meta.t0) / 1000 - LEAD_S);
    const to = (s.t1 - meta.t0) / 1000 + TAIL_S;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', from.toFixed(3), '-i', video, '-t', (to - from).toFixed(3),
      '-c:v', 'libvpx-vp9', '-b:v', '2500k', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-an', clip];
    log(`${basename(dir)}: ${stem} ${from.toFixed(1)}-${to.toFixed(1)} s`);
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`))));
    });
    const fromHost = meta.t0 + from * 1000, toHost = meta.t0 + to * 1000;
    const side = {
      session: meta.session, solve: s, clip: `${stem}.webm`,
      /** host ms of the clip's first frame: clip time = t - clipT0 */
      clipT0: fromHost, leadS: LEAD_S, tailS: TAIL_S,
      cube: cube.filter((e) => e.t >= fromHost && e.t <= toHost),
      scheme: meta.cube?.scheme ?? null,
    };
    writeFileSync(join(out, `${stem}.json`), JSON.stringify(side));
    written.push(clip);
  }
  return written;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: node scripts/cut-solves.mjs <session dir> [--force]'); process.exit(2); }
  cutSolves(dir, { force, log: console.log }).then((w) => console.log(`${w.length} clip(s) written`), (e) => { console.error(e.message); process.exit(1); });
}

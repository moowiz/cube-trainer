// Does gridfit's seam refinement make the detector's corners better or
// worse on real photos? Reads the dump `model/train/diagnose.py --dump`
// writes (every model input as PNG, predicted and ground-truth quads in
// input px, corner-aligned) and refines every prediction. Skipped when the
// dump is absent - it holds personal photos and is never committed.
//
//   cd model && .venv/Scripts/python train/diagnose.py --ckpt train/runs/<run>/best.pt \
//       --data data_real_val --split all --dump data_real_val/refine-dump
//   cd web && npx vitest run test/refine-bench.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { BENCH, loadPng, TEST_DIR } from './helpers';
import { refineQuad } from '../src/detect/gridfit';
import type { ImageDataLike, Quad } from '../src/rectify';

const dir = join(TEST_DIR, '..', '..', 'model', 'data_real_val', 'refine-dump');
const present = existsSync(join(dir, 'dump.json'));

interface Face { image: string; range: string; far: boolean; src: number; err: number; pred: [number, number][]; gt: [number, number][] }

const meanErr = (a: Quad, b: Quad): number => a.reduce((s, p, i) => s + Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1]), 0) / 4;
const stats = (xs: number[]): string => {
  const s = [...xs].sort((p, q) => p - q);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(2)}  median ${s[Math.floor(s.length / 2)]!.toFixed(2)}  p90 ${s[Math.floor(s.length * 0.9)]!.toFixed(2)}`;
};

describe.skipIf(!present || !BENCH)('seam refinement on real-photo detections', () => {
  // k = 1: the model input itself; k = 2: the same window cut from the native
  // photo at twice the size (--dump-scale 2), roughly the phone frame's scale.
  // Errors are reported in model px at every k so the columns compare.
  it.each([1, 2])('reports error before / after refineQuad at %ix the model input', (k) => {
    const dump = JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as { inputWh: number[]; faces: Face[] };
    const name = (f: Face) => (k === 1 ? f.image : f.image.replace('.png', `x${k}.png`));
    const faces = dump.faces.filter((f) => !f.far && existsSync(join(dir, name(f))));
    if (!faces.length) return;
    const images = new Map<string, ImageDataLike>();
    const img = (n: string) => { let i = images.get(n); if (!i) { i = loadPng(join(dir, n)); images.set(n, i); } return i; };
    const up = (q: Quad): Quad => q.map(([x, y]) => [x * k, y * k] as const);

    const rows: { range: string; before: number; after: number; fromGt: number; src: number; ms: number; seamBefore: number; seamAfter: number }[] = [];
    for (const f of faces) {
      const im = img(name(f));
      const pred = up(f.pred);
      const gt = up(f.gt);
      const t0 = performance.now();
      const r = refineQuad(im, pred, { finalSeam: true });
      const ms = performance.now() - t0;
      // refinement started from the truth: how much does it wander on its own?
      const g = refineQuad(im, gt);
      rows.push({
        range: f.range, src: f.src, ms,
        before: meanErr(pred, gt) / k, after: meanErr(r.quad, gt) / k, fromGt: meanErr(g.quad, gt) / k,
        seamBefore: refineQuad(im, pred, { maxEvals: 0, finalSeam: true }).seam.score, seamAfter: r.seam.score,
      });
    }
    const line = (label: string, rs: typeof rows) => {
      const better = rs.filter((r) => r.after < r.before - 0.25).length;
      const worse = rs.filter((r) => r.after > r.before + 0.25).length;
      return `${label.padEnd(6)} n=${String(rs.length).padStart(3)}  before ${stats(rs.map((r) => r.before))}  |  after ${stats(rs.map((r) => r.after))}`
        + `  |  src px ${(rs.reduce((s, r) => s + r.before * r.src, 0) / rs.length).toFixed(1)} -> ${(rs.reduce((s, r) => s + r.after * r.src, 0) / rs.length).toFixed(1)}`
        + `  |  better ${better} worse ${worse}  |  from truth ${stats(rs.map((r) => r.fromGt))}`;
    };
    const out = [
      `refineQuad on ${rows.length} real faces at ${k}x the ${dump.inputWh.join('x')} model input (model px unless stated)`,
      line('all', rows),
      ...['far', 'mid', 'near'].map((rg) => line(rg, rows.filter((r) => r.range === rg))),
      `seam score mean ${(rows.reduce((s, r) => s + r.seamBefore, 0) / rows.length).toFixed(3)} -> ${(rows.reduce((s, r) => s + r.seamAfter, 0) / rows.length).toFixed(3)}`,
      `time per face ${stats(rows.map((r) => r.ms))} ms (node)`,
    ];
    console.log(out.join('\n'));
  }, 120000);
});

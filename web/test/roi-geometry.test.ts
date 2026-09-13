// The two-stage ROI round trip: a labelled 480x640 frame's corners, through
// stage 1's padded box, into the 256x256 letterboxed crop stage 2 sees, out
// through the decoder and back to frame px - within 1 px (PORTRAIT-DESIGN.md
// section 3.5).
//
// The "stub session" is a perfect model: for each visible face the cell that
// contains its centre carries the exact offsets that decode to the label. So
// the arithmetic under test is everything around the network - padBox, the
// ROI letterbox (geometry.ts, mirrored by model/train/dataset.py
// crop_letterbox), decodeMaps and the inverse map - which is where a
// half-cell or a scale slip would otherwise hide until it showed up as a
// phone overlay sitting slightly off the cube.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMaps } from '../src/detect/facekp';
import { hull, letterbox, padBox, type Box } from '../src/detect/geometry';
import { CROP_PAD } from '../src/detect/twostage';

interface Label {
  width: number;
  height: number;
  faces: Record<string, { visible: boolean; corners: [number, number][] | null }>;
}

const label = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'roi-label-480x640.json'), 'utf8')) as Label;
const IW = 256;
const IH = 256;
const STRIDE = 16;
const GH = IH / STRIDE;
const GW = IW / STRIDE;

const visible = Object.values(label.faces).filter((f) => f.visible && f.corners) as { corners: [number, number][] }[];

/** Intersection of the diagonals - the same centre the trainer keys the cell on. */
function centre(q: [number, number][]): [number, number] {
  const [p0, p1, p2, p3] = q;
  const d1 = [p2![0] - p0![0], p2![1] - p0![1]];
  const d2 = [p3![0] - p1![0], p3![1] - p1![1]];
  const den = d1[0]! * d2[1]! - d1[1]! * d2[0]!;
  const t = ((p1![0] - p0![0]) * d2[1]! - (p1![1] - p0![1]) * d2[0]!) / den;
  return [p0![0] + t * d1[0]!, p0![1] + t * d1[1]!];
}

/** A perfect model's maps for the given faces, in the letterboxed crop. */
function stubMaps(lb: ReturnType<typeof letterbox>): Float32Array {
  const n = GH * GW;
  const maps = new Float32Array(9 * n).fill(-8);
  for (const f of visible) {
    const q = f.corners.map(([x, y]) => lb.toModel(x, y));
    const [cx, cy] = centre(q);
    const j = Math.floor(cx / STRIDE);
    const i = Math.floor(cy / STRIDE);
    const cell = i * GW + j;
    maps[cell] = 6;
    q.forEach(([x, y], c) => {
      maps[(1 + 2 * c) * n + cell] = x / STRIDE - (j + 0.5);
      maps[(2 + 2 * c) * n + cell] = y / STRIDE - (i + 0.5);
    });
  }
  return maps;
}

describe('two-stage ROI geometry', () => {
  it('the fixture is a portrait phone frame with labelled faces', () => {
    expect([label.width, label.height]).toEqual([480, 640]);
    expect(visible.length).toBeGreaterThan(0);
  });

  it('padBox pads per side by a fraction of the box and clamps to the frame', () => {
    expect(padBox([100, 200, 200, 300], 0.5, 480, 640)).toEqual([50, 150, 250, 350]);
    expect(padBox([10, 10, 110, 110], 0.5, 480, 640)).toEqual([0, 0, 160, 160]);
    expect(padBox([400, 560, 480, 640], 0.45, 480, 640)).toEqual([364, 524, 480, 640]);
  });

  it('letterbox and its inverse agree, with and without a ROI', () => {
    for (const roi of [undefined, [40, 100, 300, 420] as Box]) {
      const lb = letterbox(480, 640, IW, IH, roi);
      for (const [x, y] of [[0, 0], [123.4, 456.7], [480, 640], [240, 320]] as [number, number][]) {
        const [u, v] = lb.toModel(x, y);
        const [bx, by] = lb.toSource(u, v);
        expect(bx).toBeCloseTo(x, 6);
        expect(by).toBeCloseTo(y, 6);
      }
    }
  });

  it('corners survive stage-1 box -> padded ROI -> crop -> decode -> frame px within 1 px', () => {
    const box = hull(visible.flatMap((f) => f.corners));
    const roi = padBox(box, CROP_PAD, label.width, label.height);
    const lb = letterbox(label.width, label.height, IW, IH, roi);
    // the crop is square, so the padded box letterboxes with at most a thin bar
    expect(Math.min(lb.dx, lb.dy)).toBeCloseTo(0, 6);

    const dets = decodeMaps(stubMaps(lb), GH, GW, STRIDE, IW, IH, 6, 0.5);
    expect(dets.length).toBe(visible.length);
    for (const f of visible) {
      // the decoder's quads are anonymous and cyclic: match by centre
      const want = f.corners;
      const [wx, wy] = centre(want);
      const got = dets
        .map((d) => d.quad.map(([u, v]) => lb.toSource(u * IW, v * IH)) as [number, number][])
        .map((q) => ({ q, d: Math.hypot(centre(q)[0] - wx, centre(q)[1] - wy) }))
        .sort((a, b) => a.d - b.d)[0]!;
      expect(got.d).toBeLessThan(1);
      const err = Math.min(...[0, 1, 2, 3].map((r) =>
        want.reduce((s, [x, y], k) => s + Math.hypot(got.q[(k + r) % 4]![0] - x, got.q[(k + r) % 4]![1] - y), 0) / 4));
      expect(err).toBeLessThan(1);
    }
  });

  it('a face is the same size in the crop wherever the cube is in the frame', () => {
    // The crop scale-normalizes stage 2: the padded silhouette always fills
    // the square input, so a face edge in model px depends only on the
    // face's share of the silhouette, not on how far away the cube is.
    const box = hull(visible.flatMap((f) => f.corners));
    const side = Math.max(box[2] - box[0], box[3] - box[1]);
    const lb = letterbox(label.width, label.height, IW, IH, padBox(box, CROP_PAD, label.width, label.height));
    expect(side * lb.scale).toBeCloseTo(IW / (1 + 2 * CROP_PAD), 0);
  });
});

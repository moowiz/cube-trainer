// The TypeScript decoder must agree with the Python one, number for number.
//
// model/train/model.py::decode_maps is the single source of truth for turning
// the center head's raw maps into quads; web/src/detect/facekp.ts::decodeMaps
// mirrors it. Two implementations of the same arithmetic drift silently — a
// half-cell offset here shows up as a phone overlay that sits slightly off
// the cube and nowhere else — so fixtures pin them together.
//
// Two fixtures, because neither alone is enough:
//   facekp-maps-square.json     real maps from the trained 256x256 crop
//                               checkpoint. The honest end-to-end case, with
//                               the near-tie peaks and out-of-frame corners
//                               a real cube produces.
//   facekp-maps-synthetic.json  fabricated maps carrying the awkward cases a
//                               trained model almost never emits — two cells
//                               drawing the SAME quad (must collapse), two
//                               cells 2 apart drawing DIFFERENT small faces
//                               (must both survive), an exact score tie, a
//                               sub-threshold peak, and corners off-frame.
//
// Regenerate with:
//   cd model/train && python dump_decode_fixture.py --ckpt runs/<run>/best.pt --data ../data_v5
//   cd model/train && python dump_decode_fixture.py --synthetic \
//       --out ../../web/test/fixtures/facekp-maps-synthetic.json
import { describe, expect, it } from 'vitest';
import { decodeMaps } from '../src/detect/facekp';
import { fixtureJson } from './helpers';

interface Fixture {
  source: string;
  shape: number[];      // [1, 9, gh, gw]
  stride: number;
  inputWh: [number, number];
  thresh: number;
  maps: number[];
  expected: { score: number; quad: [number, number][] }[];
}

const load = (name: string) => fixtureJson<Fixture>(name);

const fixtures: [string, Fixture][] = [
  ['trained checkpoint', load('facekp-maps-square.json')],
  ['synthetic edge cases', load('facekp-maps-synthetic.json')],
];

describe.each(fixtures)('decodeMaps vs Python decode_maps (%s)', (_name, fixture) => {
  const [, ch, gh, gw] = fixture.shape;
  const [iw, ih] = fixture.inputWh;
  const run = (k = 6, thresh = fixture.thresh) =>
    decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride, iw, ih, k, thresh);

  it('reads a 9-channel map at the exported square grid size', () => {
    expect(ch).toBe(9);
    expect(iw).toBe(ih);            // stage 2 is square (PORTRAIT-DESIGN.md 0)
    expect(gh).toBe(ih / fixture.stride);
    expect(gw).toBe(iw / fixture.stride);
    expect(fixture.maps.length).toBe(ch * gh * gw);
    expect(fixture.expected.length).toBeGreaterThan(0);
  });

  it('reproduces the Python decode to 1e-4', () => {
    const got = run();
    expect(got.length).toBe(fixture.expected.length);
    got.forEach((d, i) => {
      const want = fixture.expected[i]!;
      expect(d.score).toBeCloseTo(want.score, 4);
      d.quad.forEach(([x, y], k) => {
        expect(x).toBeCloseTo(want.quad[k]![0], 4);
        expect(y).toBeCloseTo(want.quad[k]![1], 4);
      });
    });
  });

  it('returns detections in descending score order', () => {
    const scores = run().map((d) => d.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('drops everything below the threshold', () => {
    const got = run(6, 0.999);
    expect(got.every((d) => d.score >= 0.999)).toBe(true);
    expect(got.length).toBeLessThan(fixture.expected.length);
  });

  it('honours top-k', () => {
    expect(run(1, 0).length).toBe(1);
  });
});

describe('decodeMaps deduplication', () => {
  // Deduplication happens on the decoded quads, with a radius that is a
  // fraction of the kept quad's own mean edge. The property that matters is
  // therefore about geometry, not about heatmap plateaus: two cells that draw
  // the same face collapse, two cells that draw different faces do not — even
  // when those faces are close, which is exactly the small-cube case the old
  // fixed one-cell 3x3 NMS destroyed (63% of all misses on data_v4 val).
  const GRID = 5;
  const STRIDE = 16;

  /** maps where the listed cells are confident and draw the given squares. */
  const build = (faces: { i: number; j: number; logit: number; cx: number; cy: number; half: number }[]) => {
    const n = GRID * GRID;
    const maps = new Float32Array(9 * n).fill(-6);
    for (const { i, j, logit, cx, cy, half } of faces) {
      const cell = i * GRID + j;
      maps[cell] = logit;
      const corners: [number, number][] = [
        [cx - half, cy - half], [cx + half, cy - half],
        [cx + half, cy + half], [cx - half, cy + half],
      ];
      corners.forEach(([x, y], c) => {
        maps[(1 + 2 * c) * n + cell] = x / STRIDE - (j + 0.5);
        maps[(2 + 2 * c) * n + cell] = y / STRIDE - (i + 0.5);
      });
    }
    return maps;
  };
  const run = (maps: Float32Array) =>
    decodeMaps(maps, GRID, GRID, STRIDE, GRID * STRIDE, GRID * STRIDE, 6, 0.5);

  it('collapses two cells that describe the same face', () => {
    const got = run(build([
      { i: 2, j: 2, logit: 4, cx: 40, cy: 40, half: 24 },
      { i: 2, j: 3, logit: 1, cx: 40, cy: 40, half: 24 },   // same quad, weaker
    ]));
    expect(got).toHaveLength(1);
    expect(got[0]!.score).toBeCloseTo(1 / (1 + Math.exp(-4)), 6);
  });

  it('keeps two nearby cells that describe different faces of a small cube', () => {
    // 30 px faces whose centres are 32 px apart: closer together than the old
    // 3x3 window was wide, but further apart than half their own edge.
    const got = run(build([
      { i: 2, j: 2, logit: 4, cx: 36, cy: 40, half: 15 },
      { i: 2, j: 4, logit: 3, cx: 68, cy: 40, half: 15 },
    ]));
    expect(got).toHaveLength(2);
    expect(got[0]!.score).toBeGreaterThan(got[1]!.score);
  });

  it('suppression scales with the face: the same spacing merges for a big face', () => {
    // Identical centres to the test above, but 96 px faces — now 32 px apart
    // is well inside one face, so the weaker detection is a duplicate.
    const got = run(build([
      { i: 2, j: 2, logit: 4, cx: 36, cy: 40, half: 48 },
      { i: 2, j: 4, logit: 3, cx: 68, cy: 40, half: 48 },
    ]));
    expect(got).toHaveLength(1);
  });
});

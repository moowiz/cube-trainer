// The TypeScript decoder must agree with the Python one, number for number.
//
// model/train/model.py::decode_maps is the single source of truth for turning
// the center head's raw maps into quads; web/src/detect/facekp.ts::decodeMaps
// mirrors it. Two implementations of the same arithmetic drift silently — a
// half-cell offset here shows up as a phone overlay that sits slightly off
// the cube and nowhere else — so fixtures pin them together.
//
// Two fixtures, because neither alone is enough:
//   facekp-maps.json            real maps from a trained checkpoint. The
//                               honest end-to-end case, with the near-tie
//                               peaks and out-of-frame corners a real cube
//                               produces.
//   facekp-maps-synthetic.json  fabricated maps carrying the awkward cases a
//                               trained model almost never emits — above all
//                               an EXACT plateau, two adjacent cells with
//                               identical heat, which is what pins the NMS
//                               comparison to `>=` rather than `>`.
//
// Regenerate with:
//   cd model/train && python dump_decode_fixture.py --ckpt runs/<run>/best.pt
//   cd model/train && python dump_decode_fixture.py --synthetic \
//       --out ../../web/test/fixtures/facekp-maps-synthetic.json
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeMaps } from '../src/detect/facekp';

interface Fixture {
  source: string;
  shape: number[];      // [1, 9, gh, gw]
  stride: number;
  inputWh: [number, number];
  thresh: number;
  maps: number[];
  expected: { score: number; quad: [number, number][] }[];
}

const load = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Fixture;

const fixtures: [string, Fixture][] = [
  ['trained checkpoint', load('facekp-maps.json')],
  ['synthetic edge cases', load('facekp-maps-synthetic.json')],
];

describe.each(fixtures)('decodeMaps vs Python decode_maps (%s)', (_name, fixture) => {
  const [, ch, gh, gw] = fixture.shape;
  const [iw, ih] = fixture.inputWh;
  const run = (k = 6, thresh = fixture.thresh) =>
    decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride, iw, ih, k, thresh);

  it('reads a 9-channel map at the exported grid size', () => {
    expect(ch).toBe(9);
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

describe('decodeMaps NMS', () => {
  // The synthetic fixture is built to contain an exact plateau; a trained
  // heatmap essentially never does, which is precisely why this property
  // needs its own fixture rather than riding on whichever checkpoint last
  // regenerated the real one.
  const fixture = load('facekp-maps-synthetic.json');
  const [, , gh, gw] = fixture.shape;

  it('keeps every cell of a flat plateau (compares with >=, like max_pool2d)', () => {
    const heat = fixture.maps.slice(0, gh * gw);
    const ties = heat.filter((v, i) => heat.indexOf(v) !== i).length;
    expect(ties, 'fixture must contain an exact plateau').toBeGreaterThan(0);

    const got = decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride,
                           fixture.inputWh[0], fixture.inputWh[1], 6, fixture.thresh);
    const lowest = got[got.length - 1]!.score;
    const plateau = got.filter((d) => Math.abs(d.score - lowest) < 1e-9);
    expect(plateau.length).toBeGreaterThanOrEqual(2);
  });

  it('suppresses a cell that a neighbour beats', () => {
    // One isolated peak with a strictly lower ring around it: exactly one
    // detection may survive from that neighbourhood.
    const gh2 = 5;
    const gw2 = 5;
    const maps = new Float32Array(9 * gh2 * gw2).fill(-6);
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) maps[i * gw2 + j] = 1;
    maps[2 * gw2 + 2] = 4;                       // the peak
    const got = decodeMaps(maps, gh2, gw2, 16, 80, 80, 6, 0.5);
    expect(got).toHaveLength(1);
    expect(got[0]!.score).toBeCloseTo(1 / (1 + Math.exp(-4)), 6);
  });
});

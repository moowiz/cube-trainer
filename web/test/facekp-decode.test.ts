// The TypeScript decoder must agree with the Python one, number for number.
//
// model/train/model.py::decode_maps is the single source of truth for turning
// the center head's raw maps into quads; web/src/detect/facekp.ts::decodeMaps
// mirrors it. Two implementations of the same arithmetic drift silently — a
// half-cell offset here shows up as a phone overlay that sits slightly off
// the cube and nowhere else — so the fixture pins them together.
//
// Regenerate with:
//   cd model/train && python dump_decode_fixture.py --ckpt runs/<run>/best.pt
//   cd model/train && python dump_decode_fixture.py --synthetic   # no ckpt
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

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'facekp-maps.json'), 'utf8'),
) as Fixture;

describe('decodeMaps (TS mirror of model/train/model.py decode_maps)', () => {
  const [, ch, gh, gw] = fixture.shape;
  const [iw, ih] = fixture.inputWh;
  const run = () =>
    decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride, iw, ih, 6, fixture.thresh);

  it('reads a 9-channel map at the exported grid size', () => {
    expect(ch).toBe(9);
    expect(fixture.maps.length).toBe(ch * gh * gw);
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
    const got = decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride, iw, ih, 6, 0.99);
    expect(got.every((d) => d.score >= 0.99)).toBe(true);
    expect(got.length).toBeLessThan(fixture.expected.length);
  });

  it('keeps a flat plateau (NMS compares with >=, like torch max_pool2d)', () => {
    // The fixture deliberately contains two adjacent cells with identical
    // heat. An implementation using > would keep neither.
    const maps = Float32Array.from(fixture.maps);
    const heat = Array.from(maps.slice(0, gh * gw));
    const ties = heat.filter((v, i) => heat.indexOf(v) !== i).length;
    expect(ties).toBeGreaterThan(0);
    const got = decodeMaps(maps, gh, gw, fixture.stride, iw, ih, 6, fixture.thresh);
    const plateau = got.filter((d) => Math.abs(d.score - got[got.length - 1]!.score) < 1e-9);
    expect(plateau.length).toBeGreaterThanOrEqual(2);
  });

  it('honours top-k', () => {
    expect(decodeMaps(Float32Array.from(fixture.maps), gh, gw, fixture.stride, iw, ih, 2, 0).length)
      .toBe(2);
  });
});

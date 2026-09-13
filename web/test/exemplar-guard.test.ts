// Regression for the "blue reads as green" lock-in (2026-09-13, two Capture
// debug files from scan.html twelve seconds apart, test/fixtures/scan-debug-*):
//
//   09:09:52  U white, F green named correctly; F exemplar measured green.
//   09:10:04  the only quad has a BLUE centre and is named F at distance 1.4,
//             because the F exemplar had become that blue: the F track kept
//             its id while the cube turned, every seam-verified frame fed the
//             blue reading to observe('F', ...), and the median flipped.
//
// Three guards close it: an observation cannot move a measured exemplar by
// more than MAX_OBS_DRIFT nor be nearer another face's exemplar; the priors
// for unmeasured faces are fitted to the room from the measured ones (nominal
// blue was 55 from the real blue, further than the poisoned green); and a
// name needs a margin (MIN_NAME_CONF).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labDistance } from '../src/color';
import { AMBIGUOUS_REASON, CenterExemplars, MAX_OBS_DRIFT, MIN_NAME_CONF, nameQuads } from '../src/detect/identify';
import type { ImageDataLike } from '../src/rectify';
import { FACE_ORDER } from '../src/types';
import type { FaceId, Lab } from '../src/types';

const dir = new URL('./fixtures/', import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as {
  exemplars: { face: FaceId; measured: boolean; lab: Lab }[];
  quads: { named: { face: FaceId | null; centreNorm: Lab; cells: { lab: Lab }[] } }[];
};
const healthy = load('scan-debug-1789290592829.json');
const poisoned = load('scan-debug-1789290604959.json');

/** Nine cells whose normalized centre is exactly `c` (eight neutral cells at L 0 pin the median). */
function cellsWithCentre(c: Lab): Lab[] {
  const cells: Lab[] = Array.from({ length: 9 }, () => ({ L: 0, a: c.a, b: c.b }));
  cells[4] = { L: c.L, a: c.a, b: c.b };
  return cells;
}

/** Exemplars in the state the healthy capture recorded: U, R, F measured. */
function healthyExemplars(): CenterExemplars {
  const ex = new CenterExemplars();
  for (const e of healthy.exemplars) {
    if (e.measured) expect(ex.observe(e.face, cellsWithCentre(e.lab))).toBe(true);
  }
  return ex;
}

// The blue centre that got named green, in the naming space.
const BLUE = poisoned.quads[0]!.named.centreNorm;

describe('CenterExemplars guards (fixtures scan-debug-1789290592829 / -604959)', () => {
  it('the captured failure: the blue centre was 54 from measured green and 55 from nominal blue', () => {
    const nominal = new CenterExemplars();
    const green = healthy.exemplars.find((e) => e.face === 'F')!.lab;
    expect(labDistance(BLUE, green)).toBeCloseTo(54.5, 0);
    expect(labDistance(BLUE, nominal.get('B'))).toBeCloseTo(55.1, 0);
  });

  it('fits the unmeasured priors to the room: blue is nearer the blue prior than any measured face', () => {
    const ex = healthyExemplars();
    const d = Object.fromEntries(FACE_ORDER.map((f) => [f, labDistance(BLUE, ex.get(f))])) as Record<FaceId, number>;
    expect(d.B).toBeLessThan(d.F);
    expect(d.B).toBeLessThan(d.U);
    expect(d.B).toBeLessThan(d.R);
    expect(d.B).toBeLessThan(45); // nominal was 55
    // the fit is a scale+shift of the nominal scheme, so measured faces are untouched
    expect(ex.isMeasured('F')).toBe(true);
    expect(ex.isMeasured('B')).toBe(false);
  });

  it('refuses to teach F the blue reading (drift and nearest-face guards)', () => {
    const ex = healthyExemplars();
    const before = ex.get('F');
    for (let i = 0; i < 20; i++) expect(ex.observe('F', cellsWithCentre(BLUE))).toBe(false);
    expect(ex.rejected).toBe(20);
    expect(ex.get('F')).toEqual(before);
    // and the blue reading IS accepted for B
    expect(ex.observe('B', cellsWithCentre(BLUE))).toBe(true);
    expect(ex.isMeasured('B')).toBe(true);
  });

  it('accepts ordinary drift of a measured face', () => {
    const ex = healthyExemplars();
    const g = ex.get('F');
    const drifted = { L: g.L + 3, a: g.a + 4, b: g.b - 2 };
    expect(labDistance(drifted, g)).toBeLessThan(MAX_OBS_DRIFT);
    expect(ex.observe('F', cellsWithCentre(drifted))).toBe(true);
  });

  it('reset() clears the guards state', () => {
    const ex = healthyExemplars();
    ex.observe('F', cellsWithCentre(BLUE));
    ex.reset();
    expect(ex.rejected).toBe(0);
    expect(ex.isMeasured('F')).toBe(false);
  });
});

describe('nameQuads margin gate', () => {
  const W = 320;
  const H = 240;
  const S = 120; // face edge, well above the range floor for a 240-high frame

  function frameWithCentre(rgb: [number, number, number]): ImageDataLike {
    // a 3x3 face: eight mid-grey stickers and the centre in `rgb`
    const data = new Uint8ClampedArray(W * H * 4).fill(90);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const x0 = 100;
    const y0 = 60;
    const cell = S / 3;
    for (let py = y0; py < y0 + S; py++) {
      for (let px = x0; px < x0 + S; px++) {
        const ci = Math.min(2, Math.floor((py - y0) / cell)) * 3 + Math.min(2, Math.floor((px - x0) / cell));
        const c: [number, number, number] = ci === 4 ? rgb : [150, 150, 150];
        const o = (py * W + px) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      }
    }
    return { width: W, height: H, data };
  }
  const quad: [number, number][] = [[100, 60], [220, 60], [220, 180], [100, 180]];

  it('refuses a centre that two exemplars claim about equally, and says which two', () => {
    // a teal halfway between the nominal green and blue
    const ex = new CenterExemplars();
    const res = nameQuads(frameWithCentre([40, 150, 170]), [quad], ex)[0]!;
    expect(res.face).toBeNull();
    expect(res.reason.startsWith(AMBIGUOUS_REASON)).toBe(true);
    expect(res.nameConf).toBeLessThan(MIN_NAME_CONF);
    expect(res.ranked).toBeDefined();
  });

  it('still names a clear centre', () => {
    const ex = new CenterExemplars();
    const res = nameQuads(frameWithCentre([51, 177, 93]), [quad], ex)[0]!;
    expect(res.face).toBe('F');
    expect(res.nameConf).toBeGreaterThan(MIN_NAME_CONF);
  });
});

// The naming space, pinned to two real phone captures that got it wrong.
//
// Both came off the detect page's "Capture debug" button (v4ft1 ep6 fp32,
// wasm EP, 480x640 source) and both named a face white that plainly was not.
// The cell Labs below are verbatim from those captures, so this is a real
// frame's numbers without needing the frame.
import { describe, expect, it } from 'vitest';
import { facePlan, labDistance, MIN_FACE_EDGE_PX } from '../src/color';
import { CenterExemplars } from '../src/detect/identify';
import { CLUSTER_L_WEIGHT, NAME_L_WEIGHT, normalizeFaceCells } from '../src/state';
import { FACE_ORDER } from '../src/types';
import type { FaceId, Lab } from '../src/types';

const lab = (L: number, a: number, b: number): Lab => ({ L, a, b });

// detect-debug-1789274595073, quad 0: conf 0.995, a correctly placed quad on a
// face reading red/red/red, red/BLUE/yellow, white/green/white. All five
// sub-patches of the center agreed it was blue; naming called it white 0.34.
const BLUE_CENTER_FACE: Lab[] = [
  lab(40.916, 63.702, 53.500), lab(39.976, 63.006, 53.721), lab(39.574, 62.567, 53.718),
  lab(39.473, 61.760, 52.175), lab(26.537, -2.088, -27.386), lab(67.095, -1.860, 68.527),
  lab(60.373, 6.959, 21.293), lab(46.975, -46.832, 35.185), lab(64.639, 2.601, 20.235),
];

function rank(cells: Lab[], weight: number): { face: FaceId; d: number }[] {
  const ex = new CenterExemplars();
  const center = normalizeFaceCells(cells, weight)[4]!;
  return FACE_ORDER.map((f) => ({ f, d: labDistance(center, ex.get(f)) }))
    .sort((a, b) => a.d - b.d)
    .map((r) => ({ face: r.f, d: r.d }));
}

describe('naming space: lightness must count against fixed exemplars', () => {
  it('names the dark blue center blue, where the clustering weight named it white', () => {
    // What shipped: L crushed to 15% leaves white (a*~0, b*~0) nearest any
    // weakly chromatic sample, however dark.
    const crushed = rank(BLUE_CENTER_FACE, CLUSTER_L_WEIGHT);
    expect(crushed[0]!.face).toBe('U');

    const named = rank(BLUE_CENTER_FACE, NAME_L_WEIGHT);
    expect(named[0]!.face).toBe('B');
    expect(named[0]!.d).toBeLessThan(named[1]!.d);
  });

  it('still cancels exposure drift: scaling the whole face does not change the name', () => {
    // The median-L subtraction is what makes the space exposure-invariant, and
    // it survives the weight change - that was never the part that was wrong.
    const darker = BLUE_CENTER_FACE.map((c) => lab(c.L - 12, c.a, c.b));
    expect(rank(darker, NAME_L_WEIGHT)[0]!.face).toBe('B');
  });

  it('a genuinely white center is still white', () => {
    const whiteCentered = BLUE_CENTER_FACE.map((c, i) =>
      i === 4 ? lab(78, 1.2, 6.0) : c);
    expect(rank(whiteCentered, NAME_L_WEIGHT)[0]!.face).toBe('U');
  });
});

describe('facePlan: refuse faces the detector was never trained to place', () => {
  it('refuses the grazing top-face sliver that read shadow as white', () => {
    // detect-debug-1789274516525, quad 1: edges 78/33/110/20 px in the 320x240
    // frame naming samples. 20/3 = 6.7 px per sticker; three of the center
    // cell's five patches fell off the sticker entirely.
    expect(facePlan(20 / 3)).toBeNull();
  });

  it('refuses exactly at the trainer threshold, and accepts just above it', () => {
    expect(facePlan((MIN_FACE_EDGE_PX - 1) / 3)).toBeNull();
    expect(facePlan(MIN_FACE_EDGE_PX / 3)).not.toBeNull();
  });

  it('spends the budget on patch width first, and only then on a ring', () => {
    const tight = facePlan(MIN_FACE_EDGE_PX / 3)!;   // ~10.7 px per sticker
    const roomy = facePlan(30)!;
    expect(tight.off).toBeLessThan(roomy.off);
    expect(roomy.half).toBe(0.15);
    // Nothing may reach the seam: half a cell, with slack for corner error.
    for (const p of [tight, roomy]) expect(p.half + p.off).toBeLessThan(0.45);
  });
});

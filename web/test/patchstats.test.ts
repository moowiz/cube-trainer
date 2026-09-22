import { describe, it, expect } from 'vitest';
import { samplePatchStats, sampleGridStats, blurScore, quadViewCos, quadEdgePx, PATCH_TRIM } from '../src/colour/patch';
import { makeImage, setPixel } from './helpers';

function fill(img: ImageData, rgb: readonly [number, number, number]): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) setPixel(img, x, y, rgb);
  }
}

describe('samplePatchStats', () => {
  it('a flat colour patch returns that colour with no spread and nothing flagged', () => {
    const img = makeImage(20, 20);
    fill(img, [200, 30, 40]);
    const s = samplePatchStats(img, 10, 10, 12);
    expect(s.rgb).toEqual([200, 30, 40]);
    expect(s.spread).toBeLessThan(0.01);
    expect(s.clipFrac).toBe(0);
    expect(s.darkFrac).toBe(0);
    expect(s.censored).toEqual([false, false, false]);
    expect(s.n).toBe(12 * 12);
  });

  it('a black seam covering 40% of the patch is trimmed out of the median but counted as dark', () => {
    const img = makeImage(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) setPixel(img, x, y, x < 4 ? [0, 0, 0] : [180, 120, 60]);
    }
    const s = samplePatchStats(img, 5, 5, 10);
    expect(s.rgb).toEqual([180, 120, 60]);
    expect(s.darkFrac).toBeCloseTo(0.4, 5);
    expect(s.spread).toBeLessThan(1);
  });

  it('30% glare is trimmed out of the median but counted as clipped', () => {
    const img = makeImage(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) setPixel(img, x, y, x >= 7 ? [255, 255, 255] : [100, 150, 90]);
    }
    const s = samplePatchStats(img, 5, 5, 10);
    expect(s.rgb).toEqual([100, 150, 90]);
    expect(s.clipFrac).toBeCloseTo(0.3, 5);
    expect(s.spread).toBeLessThan(1);
  });

  it('a saturated-red patch is censored on every channel (255 and 0 are both bounds)', () => {
    const img = makeImage(10, 10);
    fill(img, [255, 0, 0]);
    const s = samplePatchStats(img, 5, 5, 10);
    expect(s.rgb).toEqual([255, 0, 0]);
    // R sits at the top bound, G and B both sit at the bottom bound -- all three are bounds.
    expect(s.censored).toEqual([true, true, true]);
  });

  it('throws on a patch entirely outside the image', () => {
    const img = makeImage(10, 10);
    expect(() => samplePatchStats(img, 100, 100, 12)).toThrow();
  });
});

describe('sampleGridStats', () => {
  // A 90x90 face: 3x3 grid of distinct flat colours with 4px black seams on the
  // grid lines (x/y = 30, 60), and a round "logo" of a 10th colour painted in
  // the centre cell, antialiased (supersampled) so its edge is not a single
  // hard step -- exactly like a real decal, and the only way to see the ring's
  // *contamination*, rather than just its color flipping outright, show up as
  // `spread` (see the note above sampleCentreStats: samplePatchStats's median
  // is a robust/step statistic, so a hard-edged synthetic logo either misses
  // the ring entirely or swallows it whole with no partial state in between).
  const COLORS: [number, number, number][] = [
    [200, 30, 40], [30, 200, 40], [40, 30, 200],
    [200, 200, 30], [90, 90, 90], [30, 200, 200],
    [120, 80, 40], [40, 120, 80], [80, 40, 120],
  ];
  const LOGO: [number, number, number] = [10, 220, 10];

  function coverage(cx: number, cy: number, x: number, y: number, r: number): number {
    const SS = 4;
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (Math.hypot(px - cx, py - cy) < r) hit++;
      }
    }
    return hit / (SS * SS);
  }

  function buildGrid(logoDiameter: number): ImageData {
    const img = makeImage(90, 90);
    const r = logoDiameter / 2;
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 90; x++) {
        const seam = (x >= 28 && x < 32) || (x >= 58 && x < 62) || (y >= 28 && y < 32) || (y >= 58 && y < 62);
        const col = x < 30 ? 0 : x < 60 ? 1 : 2;
        const row = y < 30 ? 0 : y < 60 ? 1 : 2;
        const base: [number, number, number] = seam ? [0, 0, 0] : COLORS[row * 3 + col]!;
        const cov = coverage(45, 45, x, y, r);
        setPixel(img, x, y, [
          base[0] + (LOGO[0] - base[0]) * cov,
          base[1] + (LOGO[1] - base[1]) * cov,
          base[2] + (LOGO[2] - base[2]) * cov,
        ]);
      }
    }
    return img;
  }

  it('reads each outer cell as its own colour and never touches the seams', () => {
    const stats = sampleGridStats(buildGrid(12), { x: 0, y: 0, w: 90, h: 90 });
    for (let i = 0; i < 9; i++) {
      if (i === 4) continue;
      expect(stats[i]!.rgb).toEqual(COLORS[i]);
      expect(stats[i]!.darkFrac).toBe(0);
    }
  });

  it('the ring dodges a 12px logo: centre cell still reads the cell colour with tiny spread', () => {
    const stats = sampleGridStats(buildGrid(12), { x: 0, y: 0, w: 90, h: 90 });
    const centre = stats[4]!;
    expect(centre.rgb).toEqual(COLORS[4]);
    expect(centre.spread).toBeLessThan(1);
  });

  it('a 24px logo reaches the ring: spread grows relative to the 12px case', () => {
    const clean = sampleGridStats(buildGrid(12), { x: 0, y: 0, w: 90, h: 90 })[4]!;
    const touched = sampleGridStats(buildGrid(24), { x: 0, y: 0, w: 90, h: 90 })[4]!;
    expect(touched.spread).toBeGreaterThan(clean.spread);
    expect(touched.spread).toBeGreaterThan(1);
  });
});

describe('blurScore', () => {
  function makeGrey(size: number, fn: (x: number, y: number) => number): ImageData {
    const img = makeImage(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = fn(x, y);
        setPixel(img, x, y, [v, v, v]);
      }
    }
    return img;
  }

  it('scores a checkerboard far higher than a flat image, with a box-blurred checkerboard in between', () => {
    const size = 20;
    const checkerAt = (x: number, y: number) => ((x + y) % 2 === 0 ? 20 : 230);
    const checker = makeGrey(size, checkerAt);
    const flat = makeGrey(size, () => 128);
    const blurred = makeGrey(size, (x, y) => {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
          sum += checkerAt(xx, yy);
          n++;
        }
      }
      return sum / n;
    });
    const checkerScore = blurScore(checker);
    const flatScore = blurScore(flat);
    const blurredScore = blurScore(blurred);
    expect(flatScore).toBe(0);
    expect(blurredScore).toBeGreaterThan(flatScore);
    expect(checkerScore).toBeGreaterThan(blurredScore);
  });
});

describe('quadViewCos / quadEdgePx', () => {
  it('a square is square-on: viewCos 1', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(quadViewCos(square)).toBeCloseTo(1, 6);
  });

  it('a 100x40 rectangle foreshortens to 0.4, with a 100px longest edge', () => {
    const rect: [number, number][] = [[0, 0], [100, 0], [100, 40], [0, 40]];
    expect(quadViewCos(rect)).toBeCloseTo(0.4, 6);
    expect(quadEdgePx(rect)).toBe(100);
  });
});

// Sanity on the exported constant used by the trim wording above.
describe('PATCH_TRIM', () => {
  it('is a fraction, not a pixel count', () => {
    expect(PATCH_TRIM).toBeGreaterThan(0);
    expect(PATCH_TRIM).toBeLessThan(0.5);
  });
});

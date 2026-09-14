import { describe, it, expect } from 'vitest';
import {
  srgbToLab,
  labToSrgb,
  labDistance,
  labMedian,
  samplePatch,
  sampleGridCells,
  gridCellCenters,
  labMean,
  type Rect,
} from '../src/color';
import type { Lab } from '../src/types';

// ---------- helpers for ImageData-like fixtures (node has no ImageData) ----------

function makeImage(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) } as unknown as ImageData;
}

function setPixel(img: ImageData, x: number, y: number, rgb: readonly [number, number, number], alpha = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
  img.data[i + 3] = alpha;
}

describe('srgbToLab', () => {
  // Reference values, D65 / 2 deg observer, tolerance +/-0.5 per channel.
  const cases: Array<{ name: string; rgb: [number, number, number]; lab: Lab }> = [
    { name: 'white', rgb: [255, 255, 255], lab: { L: 100, a: 0, b: 0 } },
    { name: 'black', rgb: [0, 0, 0], lab: { L: 0, a: 0, b: 0 } },
    { name: 'red', rgb: [255, 0, 0], lab: { L: 53.2, a: 80.1, b: 67.2 } },
    { name: 'green', rgb: [0, 255, 0], lab: { L: 87.7, a: -86.2, b: 83.2 } },
    { name: 'blue', rgb: [0, 0, 255], lab: { L: 32.3, a: 79.2, b: -107.9 } },
  ];

  for (const { name, rgb, lab } of cases) {
    it(`${name} (${rgb.join(',')}) -> L=${lab.L} a=${lab.a} b=${lab.b}`, () => {
      const got = srgbToLab(rgb[0], rgb[1], rgb[2]);
      // toBeCloseTo's second arg is decimal digits, not an absolute tolerance;
      // use explicit absolute-difference assertions for a real +/-0.5 tolerance.
      expect(Math.abs(got.L - lab.L)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got.a - lab.a)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got.b - lab.b)).toBeLessThanOrEqual(0.5);
    });
  }
});

describe('labDistance', () => {
  it('is zero for identical colors', () => {
    const p: Lab = { L: 50, a: 12, b: -8 };
    expect(labDistance(p, { ...p })).toBe(0);
  });

  it('is symmetric', () => {
    const p: Lab = { L: 50, a: 12, b: -8 };
    const q: Lab = { L: 61, a: -3, b: 20 };
    expect(labDistance(p, q)).toBeCloseTo(labDistance(q, p), 10);
  });

  it('matches a hand-computed case', () => {
    const p: Lab = { L: 0, a: 0, b: 0 };
    const q: Lab = { L: 3, a: 4, b: 0 };
    // 3-4-5 triangle
    expect(labDistance(p, q)).toBeCloseTo(5, 10);

    const p2: Lab = { L: 10, a: -2, b: 5 };
    const q2: Lab = { L: 12, a: 1, b: 9 };
    // dL=2, da=3, db=4 -> sqrt(4+9+16)=sqrt(29)
    expect(labDistance(p2, q2)).toBeCloseTo(Math.sqrt(29), 10);
  });
});

describe('labMedian', () => {
  it('throws on empty input', () => {
    expect(() => labMedian([])).toThrow();
  });

  it('computes the component-wise median for an odd count', () => {
    const samples: Lab[] = [
      { L: 10, a: 1, b: 100 },
      { L: 30, a: 3, b: 90 },
      { L: 20, a: 2, b: 95 },
    ];
    expect(labMedian(samples)).toEqual({ L: 20, a: 2, b: 95 });
  });

  it('computes the component-wise median for an even count (average of middle two)', () => {
    const samples: Lab[] = [
      { L: 10, a: 0, b: 0 },
      { L: 20, a: 10, b: -10 },
      { L: 30, a: 20, b: -20 },
      { L: 40, a: 30, b: -30 },
    ];
    // medians independently per channel: L -> (20+30)/2=25, a -> (10+20)/2=15, b -> (-20+-10)/2=-15
    expect(labMedian(samples)).toEqual({ L: 25, a: 15, b: -15 });
  });

  it('is robust to a single outlier', () => {
    const samples: Lab[] = [
      { L: 50, a: 0, b: 0 },
      { L: 51, a: 1, b: 1 },
      { L: 49, a: -1, b: -1 },
      { L: 52, a: 2, b: 2 },
      { L: 999, a: -999, b: 999 }, // outlier
    ];
    const med = labMedian(samples);
    // Sorted L: 49,50,51,52,999 -> median 51. Sorted a: -999,-1,0,1,2 -> median 0.
    // Sorted b: -1,0,1,2,999 -> median 1.
    expect(med).toEqual({ L: 51, a: 0, b: 1 });
  });
});

describe('sampling: samplePatch / gridCellCenters / sampleGridCells', () => {
  const BLOCK = 30;
  const SIZE = 90;
  // 9 distinct solid colors, row-major to match gridCellCenters' row-major output.
  const COLORS: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [128, 128, 128],
    [255, 128, 0],
    [0, 128, 255],
  ];

  function paintedImage(): ImageData {
    const img = makeImage(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      const row = Math.floor(y / BLOCK);
      for (let x = 0; x < SIZE; x++) {
        const col = Math.floor(x / BLOCK);
        setPixel(img, x, y, COLORS[row * 3 + col]!);
      }
    }
    return img;
  }

  it('gridCellCenters returns 9 centers, row-major, at block midpoints', () => {
    const rect: Rect = { x: 0, y: 0, w: SIZE, h: SIZE };
    const centers = gridCellCenters(rect);
    expect(centers).toHaveLength(9);
    let idx = 0;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++, idx++) {
        const [cx, cy] = centers[idx]!;
        expect(cx).toBeCloseTo(col * BLOCK + BLOCK / 2, 6);
        expect(cy).toBeCloseTo(row * BLOCK + BLOCK / 2, 6);
      }
    }
  });

  it('samplePatch recovers the exact solid color at each cell center', () => {
    const img = paintedImage();
    const centers = gridCellCenters({ x: 0, y: 0, w: SIZE, h: SIZE });
    centers.forEach(([cx, cy], i) => {
      const sample = samplePatch(img, cx, cy, 12);
      expect(sample.rgb[0]).toBeCloseTo(COLORS[i]![0], 6);
      expect(sample.rgb[1]).toBeCloseTo(COLORS[i]![1], 6);
      expect(sample.rgb[2]).toBeCloseTo(COLORS[i]![2], 6);
    });
  });

  it('sampleGridCells returns the 9 cells in row-major order matching the painted blocks', () => {
    const img = paintedImage();
    const samples = sampleGridCells(img, { x: 0, y: 0, w: SIZE, h: SIZE });
    expect(samples).toHaveLength(9);
    samples.forEach((s, i) => {
      expect(s.rgb[0]).toBeCloseTo(COLORS[i]![0], 6);
      expect(s.rgb[1]).toBeCloseTo(COLORS[i]![1], 6);
      expect(s.rgb[2]).toBeCloseTo(COLORS[i]![2], 6);
      // sanity: lab is derived from the same rgb
      expect(s.lab).toEqual(srgbToLab(s.rgb[0], s.rgb[1], s.rgb[2]));
    });
  });

  it('clamps the patch at image edges instead of reading out of bounds', () => {
    const img = paintedImage();
    // Top-left corner: patch centered at (0,0) with size 12 would want x in
    // [-6, 6); it must clamp to [0, 6) and still average only in-bounds pixels.
    const corner = samplePatch(img, 0, 0, 12);
    expect(corner.rgb[0]).toBeCloseTo(COLORS[0]![0], 6);
    expect(corner.rgb[1]).toBeCloseTo(COLORS[0]![1], 6);
    expect(corner.rgb[2]).toBeCloseTo(COLORS[0]![2], 6);

    // Bottom-right corner likewise clamps against width/height.
    const brCorner = samplePatch(img, SIZE - 1, SIZE - 1, 12);
    expect(brCorner.rgb[0]).toBeCloseTo(COLORS[8]![0], 6);
    expect(brCorner.rgb[1]).toBeCloseTo(COLORS[8]![1], 6);
    expect(brCorner.rgb[2]).toBeCloseTo(COLORS[8]![2], 6);

    // A patch entirely outside the image throws rather than returning NaN/garbage.
    expect(() => samplePatch(img, -100, -100, 12)).toThrow();
  });

  it('ignores the alpha channel', () => {
    const img = makeImage(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        // Wildly varying alpha; color must not be affected.
        setPixel(img, x, y, [10, 20, 30], (x * 4 + y) * 16);
      }
    }
    const sample = samplePatch(img, 2, 2, 4);
    expect(sample.rgb[0]).toBeCloseTo(10, 6);
    expect(sample.rgb[1]).toBeCloseTo(20, 6);
    expect(sample.rgb[2]).toBeCloseTo(30, 6);
  });
});

describe('labMean', () => {
  it('labMean averages component-wise and throws on empty', () => {
    const m = labMean([
      { L: 10, a: -4, b: 6 },
      { L: 30, a: 4, b: 10 },
    ]);
    expect(m).toEqual({ L: 20, a: 0, b: 8 });
    expect(() => labMean([])).toThrow();
  });
});

describe('labToSrgb', () => {
  it('inverts srgbToLab on sticker-like colours', () => {
    for (const rgb of [[255, 255, 255], [200, 0, 33], [0, 170, 92], [248, 86, 4], [205, 219, 53], [0, 81, 161], [128, 128, 128]] as [number, number, number][]) {
      const back = labToSrgb(srgbToLab(...rgb));
      rgb.forEach((v, i) => expect(Math.abs(back[i]! - v)).toBeLessThanOrEqual(1));
    }
  });
});

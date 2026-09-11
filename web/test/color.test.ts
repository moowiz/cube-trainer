import { describe, it, expect } from 'vitest';
import {
  srgbToLab,
  labDistance,
  labMedian,
  samplePatch,
  sampleGridCells,
  gridCellCenters,
  kmeans,
  nearestCentroid,
  rgbCss,
  labMean,
  maxPairwiseLabDistance,
  sampleSurroundPatches,
  type Rect,
} from '../src/color';
import type { Lab } from '../src/types';

// ---------- deterministic noise: tiny hand-rolled LCG (no Math.random) ----------

function makeLcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Uniform noise in [-amplitude, amplitude]. */
function noise(rand: () => number, amplitude: number): number {
  return (rand() * 2 - 1) * amplitude;
}

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
    const samples = sampleGridCells(img, { x: 0, y: 0, w: SIZE, h: SIZE }, 12);
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

describe('kmeans', () => {
  it('recovers well-separated clusters without seeds (farthest-point init)', () => {
    const rand = makeLcg(1);
    const trueCenters: Lab[] = [
      { L: 20, a: 40, b: 40 },
      { L: 60, a: -40, b: 0 },
      { L: 85, a: 0, b: -40 },
    ];
    const samples: Lab[] = [];
    const memberOf: number[] = [];
    for (let c = 0; c < trueCenters.length; c++) {
      for (let i = 0; i < 15; i++) {
        const center = trueCenters[c]!;
        samples.push({
          L: center.L + noise(rand, 1),
          a: center.a + noise(rand, 1),
          b: center.b + noise(rand, 1),
        });
        memberOf.push(c);
      }
    }
    const { labels } = kmeans(samples, 3);
    // Every pair of samples from the same true cluster must share a label,
    // and samples from different true clusters must have different labels.
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        if (memberOf[i] === memberOf[j]) {
          expect(labels[i]).toBe(labels[j]);
        } else {
          expect(labels[i]).not.toBe(labels[j]);
        }
      }
    }
  });

  it('keeps red and orange separate when seeded at their true centers, even with noise comparable to their separation', () => {
    // Real cube-sticker colors: red (#E2433C) and orange (#F58F2A) from
    // DEFAULT_SCHEME_HEX, converted to Lab. These are the "hard case" the
    // module's own docs call out (see MILESTONES M1 / CLAUDE.md known hard cases).
    const redCenter = srgbToLab(0xe2, 0x43, 0x3c);
    const orangeCenter = srgbToLab(0xf5, 0x8f, 0x2a);
    const separation = labDistance(redCenter, orangeCenter);
    expect(separation).toBeGreaterThan(0); // sanity: the two centers are distinct

    // Noise amplitude comparable to the separation, but small enough that no
    // single sample's noise vector (up to amplitude on each of L, a, b) can
    // cross the midline between the two seeded centers (a safety margin of
    // amplitude * sqrt(3) < separation / 2).
    const amplitude = separation * 0.2;
    const rand = makeLcg(42);

    const samples: Lab[] = [];
    const memberOf: number[] = []; // 0 = red, 1 = orange
    for (let i = 0; i < 25; i++) {
      samples.push({
        L: redCenter.L + noise(rand, amplitude),
        a: redCenter.a + noise(rand, amplitude),
        b: redCenter.b + noise(rand, amplitude),
      });
      memberOf.push(0);
    }
    for (let i = 0; i < 25; i++) {
      samples.push({
        L: orangeCenter.L + noise(rand, amplitude),
        a: orangeCenter.a + noise(rand, amplitude),
        b: orangeCenter.b + noise(rand, amplitude),
      });
      memberOf.push(1);
    }

    const { labels } = kmeans(samples, 2, [redCenter, orangeCenter]);
    for (let i = 0; i < samples.length; i++) {
      expect(labels[i]).toBe(memberOf[i]);
    }
  });

  it('throws when seeds length does not match k', () => {
    const samples: Lab[] = [
      { L: 10, a: 0, b: 0 },
      { L: 20, a: 0, b: 0 },
      { L: 30, a: 0, b: 0 },
    ];
    expect(() => kmeans(samples, 3, [{ L: 0, a: 0, b: 0 }, { L: 50, a: 0, b: 0 }])).toThrow();
  });

  it('throws when there are fewer samples than k', () => {
    const samples: Lab[] = [
      { L: 10, a: 0, b: 0 },
      { L: 20, a: 0, b: 0 },
    ];
    expect(() => kmeans(samples, 3)).toThrow();
  });

  it('gives every centroid at least one sample even when a seed starts far from all data', () => {
    const rand = makeLcg(7);
    const c1: Lab = { L: 30, a: 20, b: 20 };
    const c2: Lab = { L: 70, a: -20, b: -20 };
    const farSeed: Lab = { L: 0, a: 127, b: -127 }; // deliberately far from both clusters

    const samples: Lab[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ L: c1.L + noise(rand, 1), a: c1.a + noise(rand, 1), b: c1.b + noise(rand, 1) });
    }
    for (let i = 0; i < 10; i++) {
      samples.push({ L: c2.L + noise(rand, 1), a: c2.a + noise(rand, 1), b: c2.b + noise(rand, 1) });
    }

    const { labels } = kmeans(samples, 3, [c1, c2, farSeed]);
    const owned = new Set(labels);
    expect(owned.size).toBe(3);
    expect(owned.has(0)).toBe(true);
    expect(owned.has(1)).toBe(true);
    expect(owned.has(2)).toBe(true);
  });
});

describe('nearestCentroid', () => {
  it('returns the correct index, dist, and secondDist on a hand-built case', () => {
    const centroids: Lab[] = [
      { L: 0, a: 0, b: 0 }, // index 0
      { L: 10, a: 0, b: 0 }, // index 1 -> dist 10
      { L: 3, a: 4, b: 0 }, // index 2 -> dist 5 (3-4-5 triangle)
    ];
    const p: Lab = { L: 0, a: 0, b: 0 };
    const result = nearestCentroid(p, centroids);
    // Distances to centroids: [0, 10, 5]. Nearest is index 0 (dist 0),
    // second-nearest is index 2 (dist 5).
    expect(result.index).toBe(0);
    expect(result.dist).toBe(0);
    expect(result.secondDist).toBe(5);
    expect(result.secondDist).toBeGreaterThanOrEqual(result.dist);
  });

  it('handles a case where the second-nearest is not the last centroid checked', () => {
    const centroids: Lab[] = [
      { L: 100, a: 0, b: 0 }, // dist 100
      { L: 1, a: 0, b: 0 }, // dist 1 -> nearest
      { L: 5, a: 0, b: 0 }, // dist 5 -> second-nearest
      { L: 50, a: 0, b: 0 }, // dist 50
    ];
    const p: Lab = { L: 0, a: 0, b: 0 };
    const result = nearestCentroid(p, centroids);
    expect(result.index).toBe(1);
    expect(result.dist).toBe(1);
    expect(result.secondDist).toBe(5);
    expect(result.secondDist).toBeGreaterThanOrEqual(result.dist);
  });
});

describe('rgbCss', () => {
  it('formats an rgb triple as a css rgb() string', () => {
    expect(rgbCss([255, 0, 128])).toBe('rgb(255, 0, 128)');
    expect(rgbCss([0, 0, 0])).toBe('rgb(0, 0, 0)');
  });

  it('rounds fractional components', () => {
    expect(rgbCss([254.6, 0.2, 127.5])).toBe('rgb(255, 0, 128)');
  });
});

describe('labMean / maxPairwiseLabDistance', () => {
  it('labMean averages component-wise and throws on empty', () => {
    const m = labMean([
      { L: 10, a: -4, b: 6 },
      { L: 30, a: 4, b: 10 },
    ]);
    expect(m).toEqual({ L: 20, a: 0, b: 8 });
    expect(() => labMean([])).toThrow();
  });

  it('maxPairwiseLabDistance is 0 for uniform input and finds the widest pair', () => {
    const u = { L: 50, a: 0, b: 0 };
    expect(maxPairwiseLabDistance([u, u, u])).toBe(0);
    const spread = [u, { L: 53, a: 4, b: 0 }, { L: 50, a: 0, b: 40 }];
    expect(maxPairwiseLabDistance(spread)).toBeCloseTo(labDistance(spread[1]!, spread[2]!), 5);
  });
});

describe('sampleSurroundPatches', () => {
  // 100x100 image: a 40x40 "cube" rect at (30,30) painted red, everything
  // else (the background) painted gray.
  function makeScene(bg: readonly [number, number, number]): { img: ImageData; rect: Rect } {
    const img = makeImage(100, 100);
    const rect: Rect = { x: 30, y: 30, w: 40, h: 40 };
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        setPixel(img, x, y, inside ? [200, 40, 40] : bg);
      }
    }
    return { img, rect };
  }

  it('samples only outside the rect and sees the background color', () => {
    const { img, rect } = makeScene([120, 120, 120]);
    const patches = sampleSurroundPatches(img, rect, 8);
    expect(patches.length).toBe(8);
    const gray = srgbToLab(120, 120, 120);
    for (const p of patches) {
      expect(labDistance(p.lab, gray)).toBeLessThan(1);
    }
  });

  it('distinguishes cube-against-background from wall-to-wall background', () => {
    const { img, rect } = makeScene([120, 120, 120]);
    const faceMean = srgbToLab(200, 40, 40); // the "cube" color
    const patches = sampleSurroundPatches(img, rect, 8);
    const similar = patches.filter((p) => labDistance(p.lab, faceMean) < 16).length;
    expect(similar).toBe(0); // contrasting background: no surround patch matches the face

    // Now a "ceiling": the whole frame is the face color.
    const wall = makeImage(100, 100);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) setPixel(wall, x, y, [200, 40, 40]);
    const wallPatches = sampleSurroundPatches(wall, rect, 8);
    const wallSimilar = wallPatches.filter((p) => labDistance(p.lab, faceMean) < 16).length;
    expect(wallSimilar).toBe(wallPatches.length); // everything matches -> not a cube
  });
});

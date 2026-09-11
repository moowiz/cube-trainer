// Lab conversion, sticker sampling, and k-means classification.
// Everything here is a pure function on ImageData / plain arrays so it can be
// unit-tested without a camera (see web/test/color.test.ts).

import type { CellSample, Lab } from './types';

// ---------- sRGB (0-255) -> CIE Lab, D65 ----------

export function srgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  let x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  let z = 0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl;
  x /= 0.95047;
  z /= 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labDistance(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Component-wise median — robust per-cell color over a window of frames. */
export function labMedian(samples: readonly Lab[]): Lab {
  if (samples.length === 0) throw new Error('labMedian: empty input');
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  return {
    L: med(samples.map((s) => s.L)),
    a: med(samples.map((s) => s.a)),
    b: med(samples.map((s) => s.b)),
  };
}

// ---------- sampling ----------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Average an axis-aligned square patch (side `size` px) centered at (cx, cy). */
export function samplePatch(img: ImageData, cx: number, cy: number, size = 12): CellSample {
  const half = size / 2;
  const x0 = Math.max(0, Math.round(cx - half));
  const y0 = Math.max(0, Math.round(cy - half));
  const x1 = Math.min(img.width, Math.round(cx + half));
  const y1 = Math.min(img.height, Math.round(cy + half));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const d = img.data;
  for (let y = y0; y < y1; y++) {
    let i = (y * img.width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
  }
  if (n === 0) throw new Error(`samplePatch: patch at (${cx},${cy}) outside image`);
  r /= n;
  g /= n;
  b /= n;
  return { lab: srgbToLab(r, g, b), rgb: [r, g, b] };
}

/** Centers of the 9 cells of a 3x3 grid inside `rect`, row-major. */
export function gridCellCenters(rect: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out.push([rect.x + ((col + 0.5) * rect.w) / 3, rect.y + ((row + 0.5) * rect.h) / 3]);
    }
  }
  return out;
}

/** Sample the 9 sticker cells of a face grid, row-major. */
export function sampleGridCells(img: ImageData, rect: Rect, patchSize = 12): CellSample[] {
  return gridCellCenters(rect).map(([cx, cy]) => samplePatch(img, cx, cy, patchSize));
}

/** Component-wise mean. */
export function labMean(samples: readonly Lab[]): Lab {
  if (samples.length === 0) throw new Error('labMean: empty input');
  let L = 0;
  let a = 0;
  let b = 0;
  for (const s of samples) {
    L += s.L;
    a += s.a;
    b += s.b;
  }
  const n = samples.length;
  return { L: L / n, a: a / n, b: b / n };
}

/** Largest Lab distance between any two samples — 0 means perfectly uniform. */
export function maxPairwiseLabDistance(samples: readonly Lab[]): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const d = labDistance(samples[i]!, samples[j]!);
      if (d > max) max = d;
    }
  }
  return max;
}

// DECISION: below a median L of 22 the chroma signal drowns in sensor noise
// and faces become unclassifiable. Derived from fixture
// cube-scan-1789100642010.json (kitchen, evening, desktop webcam): every face
// read L 4-30, "white" came back rgb(74,68,65), near-black cells picked up a
// green tint, and the U and L centers collided. All six of that scan's faces
// have median L < 22; a normally lit face (even a blue-heavy one) sits well
// above it. Tune against future fixtures rather than by feel.
export const MIN_FACE_LIGHTNESS = 22;

/** True when a face reading is too dark to classify reliably. */
export function isFaceTooDark(cells: readonly Lab[]): boolean {
  return labMedian(cells).L < MIN_FACE_LIGHTNESS;
}

/**
 * Sample up to 8 patches in the region surrounding `rect` (edge midpoints and
 * corners, halfway between the rect and the image border). Used to tell a
 * cube face from bare background: background continues outside the grid,
 * a cube doesn't.
 */
export function sampleSurroundPatches(img: ImageData, rect: Rect, patchSize = 12): CellSample[] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const half = patchSize / 2;
  const left = rect.x / 2;
  const right = (rect.x + rect.w + img.width) / 2;
  const top = rect.y / 2;
  const bottom = (rect.y + rect.h + img.height) / 2;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const points: Array<[number, number]> = [
    [left, cy],
    [right, cy],
    [cx, top],
    [cx, bottom],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
  const out: CellSample[] = [];
  for (const [px, py] of points) {
    const x = clamp(px, half, img.width - half);
    const y = clamp(py, half, img.height - half);
    // Skip degenerate placements that would land back inside the grid
    // (possible when the rect nearly fills the image).
    if (x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h) continue;
    out.push(samplePatch(img, x, y, patchSize));
  }
  return out;
}

// ---------- k-means in Lab ----------

export interface KmeansResult {
  centroids: Lab[];
  /** Cluster index per input sample. */
  labels: number[];
}

/**
 * Lloyd's k-means over Lab samples.
 *
 * `seeds` (when given) must have length k and is used as the initial
 * centroids — for cube faces we seed from the six face-center samples, which
 * is what keeps red/orange from being merged (see MILESTONES M1). Without
 * seeds, greedy farthest-point init is used.
 */
export function kmeans(samples: readonly Lab[], k: number, seeds?: readonly Lab[], maxIters = 32): KmeansResult {
  if (samples.length < k) throw new Error(`kmeans: ${samples.length} samples < k=${k}`);
  let centroids: Lab[];
  if (seeds) {
    if (seeds.length !== k) throw new Error(`kmeans: ${seeds.length} seeds != k=${k}`);
    centroids = seeds.map((s) => ({ ...s }));
  } else {
    centroids = farthestPointInit(samples, k);
  }

  const labels = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      const l = nearestCentroid(samples[i]!, centroids).index;
      if (l !== labels[i]) {
        labels[i] = l;
        changed = true;
      }
    }
    // Recompute means; an empty cluster steals the sample farthest from its centroid.
    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let i = 0; i < samples.length; i++) {
      const s = sums[labels[i]!]!;
      const p = samples[i]!;
      s.L += p.L;
      s.a += p.a;
      s.b += p.b;
      s.n++;
    }
    for (let c = 0; c < k; c++) {
      const s = sums[c]!;
      if (s.n === 0) {
        let worst = 0;
        let worstD = -1;
        for (let i = 0; i < samples.length; i++) {
          const d = labDistance(samples[i]!, centroids[labels[i]!]!);
          if (d > worstD && sums[labels[i]!]!.n > 1) {
            worstD = d;
            worst = i;
          }
        }
        sums[labels[worst]!]!.n--;
        labels[worst] = c;
        centroids[c] = { ...samples[worst]! };
        changed = true;
      } else {
        centroids[c] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
      }
    }
    if (!changed && iter > 0) break;
  }
  return { centroids, labels };
}

export function nearestCentroid(p: Lab, centroids: readonly Lab[]): { index: number; dist: number; secondDist: number } {
  let index = 0;
  let dist = Infinity;
  let secondDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = labDistance(p, centroids[i]!);
    if (d < dist) {
      secondDist = dist;
      dist = d;
      index = i;
    } else if (d < secondDist) {
      secondDist = d;
    }
  }
  return { index, dist, secondDist };
}

function farthestPointInit(samples: readonly Lab[], k: number): Lab[] {
  const centroids: Lab[] = [{ ...samples[0]! }];
  while (centroids.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < samples.length; i++) {
      const d = Math.min(...centroids.map((c) => labDistance(samples[i]!, c)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    centroids.push({ ...samples[best]! });
  }
  return centroids;
}

/** sRGB triple -> css color, for painting sampled stickers back into the UI. */
export function rgbCss(rgb: readonly [number, number, number]): string {
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
}

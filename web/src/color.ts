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

/**
 * Robust cell sample: five patches (center + four diagonals at ±25% of the
 * cell size), component-median of their Lab and rgb. The median rejects a
 * contaminated minority — a center-cap logo, a glare speck, a tile edge
 * clipping one corner. Derived from fixture cube-frame-D-1789100811627,
 * where the GAN logo covers the entire center of the white tile and any
 * single center patch reads solid blue; the tile's corners are honest.
 */
export function sampleCellRobust(img: ImageData, cx: number, cy: number, cellSize: number, patchSize = 12): CellSample {
  // DECISION: 25% offset — far enough that sub-patches escape a big center
  // logo, close enough to stay inside the tile when alignment is imperfect.
  const off = cellSize * 0.25;
  const points: Array<[number, number]> = [
    [cx, cy],
    [cx - off, cy - off],
    [cx + off, cy - off],
    [cx - off, cy + off],
    [cx + off, cy + off],
  ];
  const parts = points.map(([x, y]) => samplePatch(img, x, y, patchSize));
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  };
  return {
    lab: labMedian(parts.map((p) => p.lab)),
    rgb: [med(parts.map((p) => p.rgb[0])), med(parts.map((p) => p.rgb[1])), med(parts.map((p) => p.rgb[2]))],
  };
}

/** Sample the 9 sticker cells of a face grid, row-major. */
export function sampleGridCells(img: ImageData, rect: Rect, patchSize = 12): CellSample[] {
  const cellSize = Math.min(rect.w, rect.h) / 3;
  return gridCellCenters(rect).map(([cx, cy]) => sampleCellRobust(img, cx, cy, cellSize, patchSize));
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

// DECISION: a face is hopeless only when it is BOTH dark (median L < 22) and
// chroma-dead (median chroma < 9) — then color identity has drowned in sensor
// noise. Dark alone is fine: the backlit-kitchen frame fixtures sit at
// median L 8-25 yet classify at 44/45 once exposure is normalized (see
// test/lowlight.test.ts), so refusing on lightness alone would reject scans
// that actually work. The chroma-dead case comes from fixture
// cube-scan-1789100642010.json, whose R face read near-black (median L 6,
// median chroma 7) with a noise-green tint. Tune against fixtures.
export const MIN_FACE_LIGHTNESS = 22;
export const MIN_FACE_CHROMA = 9;

/** True when a face reading is too dark AND too colorless to classify. */
export function isFaceTooDark(cells: readonly Lab[]): boolean {
  if (labMedian(cells).L >= MIN_FACE_LIGHTNESS) return false;
  const chromas = cells.map((c) => Math.hypot(c.a, c.b)).sort((a, b) => a - b);
  return chromas[chromas.length >> 1]! < MIN_FACE_CHROMA;
}

// DECISION: the mirror image of isFaceTooDark, and the reason it has to exist
// separately from isGlareSample. White IS a sticker color, so a single cell at
// L>96 with no chroma is not evidence of anything - refusing on that alone
// would refuse every U face in bright light, which is a sixth of all faces.
// A whole face that reads that way carries no information either way, and
// that is what a highlight blowing out a face actually looks like.
export const MAX_FACE_LIGHTNESS = 96;

/** True when a face reading is so blown out that nothing can be read from it. */
export function isFaceBlownOut(cells: readonly Lab[]): boolean {
  if (labMedian(cells).L <= MAX_FACE_LIGHTNESS) return false;
  const chromas = cells.map((c) => Math.hypot(c.a, c.b)).sort((a, b) => a - b);
  return chromas[chromas.length >> 1]! < MIN_FACE_CHROMA;
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
 *
 * `anchors` (when given) pins sample `anchors[j]` to cluster `j` on every
 * iteration. For cube faces the anchors are the six center cells: a physical
 * cube's centers ARE six distinct colors, so Lloyd is never allowed to
 * collapse two center clusters into one — under a strong color cast (white
 * stickers lit by a blue monitor) it otherwise merges white into blue and
 * the whole scan dies (fixture cube-scan-1789102942492).
 */
export function kmeans(
  samples: readonly Lab[],
  k: number,
  seeds?: readonly Lab[],
  maxIters = 32,
  anchors?: readonly number[],
): KmeansResult {
  if (samples.length < k) throw new Error(`kmeans: ${samples.length} samples < k=${k}`);
  if (anchors && anchors.length !== k) throw new Error(`kmeans: ${anchors.length} anchors != k=${k}`);
  let centroids: Lab[];
  if (seeds) {
    if (seeds.length !== k) throw new Error(`kmeans: ${seeds.length} seeds != k=${k}`);
    centroids = seeds.map((s) => ({ ...s }));
  } else {
    centroids = farthestPointInit(samples, k);
  }

  const labels = new Array<number>(samples.length).fill(0);
  const pin = () => anchors?.forEach((idx, j) => (labels[idx] = j));
  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      const l = nearestCentroid(samples[i]!, centroids).index;
      if (l !== labels[i]) {
        labels[i] = l;
        changed = true;
      }
    }
    pin();
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
          if (anchors?.includes(i)) continue; // never steal a pinned center
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

// ---------- balanced assignment ----------
//
// DECISION 2026-09-13: a finished cube shows EXACTLY nine stickers of each
// color, and that is evidence the classifier was throwing away. Fifty-four
// independent nearest-centroid calls have no way to express it, so under a
// color cast the nearest centroid wins ties in one direction and a color ends
// up with fourteen members while another gets four. Solving it as an
// assignment instead - 54 stickers into 6 colors x 9 slots, minimizing total
// distance - makes "looks red, but red already has nine better candidates"
// resolve to orange on its own. See web/src/color-notes.md item 3.
//
// The same argument is why the white bias on dim frames is not fixable by
// tuning a threshold: white is the only exemplar on the neutral axis, so
// every washed-out sample is nearest to it, and only a global constraint can
// say "nine of you at most".

const FORBIDDEN = 1e6; // finite, not Infinity: the solver subtracts potentials

/**
 * Hungarian algorithm (O(n^3), e-maxx potentials form) on a square cost
 * matrix. Returns row -> column. Costs must be finite.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  const m = n === 0 ? 0 : cost[0]!.length;
  if (n !== m) throw new Error(`solveAssignment: expected a square matrix, got ${n}x${m}`);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j]! - 1] = j - 1;
  return rowToCol;
}

/**
 * Label `samples` with cluster indices so that every cluster gets exactly
 * `perCluster` of them, minimizing total Lab distance to `centroids`.
 *
 * `pinned` forces a sample to a cluster (the center stickers: a face's center
 * defines its color by construction, so it must never be reassigned).
 * samples.length must equal centroids.length * perCluster.
 */
export function assignBalanced(
  samples: readonly Lab[],
  centroids: readonly Lab[],
  perCluster: number,
  pinned?: ReadonlyMap<number, number>,
): number[] {
  const k = centroids.length;
  const n = samples.length;
  if (n !== k * perCluster) {
    throw new Error(`assignBalanced: ${n} samples cannot fill ${k} clusters x ${perCluster}`);
  }
  // Expand each cluster into `perCluster` interchangeable columns.
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n);
    const force = pinned?.get(i);
    for (let c = 0; c < k; c++) {
      // Squared distance, not distance: the cost is then a Gaussian
      // log-likelihood, so the solver pays quadratically to drag a sticker
      // away from a color it sits close to and prefers to rebalance using the
      // genuinely ambiguous ones.
      const raw = labDistance(samples[i]!, centroids[c]!);
      const d = force === undefined ? raw * raw : force === c ? 0 : FORBIDDEN;
      for (let s = 0; s < perCluster; s++) row[c * perCluster + s] = d;
    }
    cost.push(row);
  }
  return solveAssignment(cost).map((col) => Math.floor(col / perCluster));
}

// Lab conversion, sticker sampling, and k-means classification.
// Everything here is a pure function on ImageData / plain arrays so it can be
// unit-tested without a camera (see web/test/color.test.ts).

import type { CellSample, Lab } from './types';
import type { PatchStats } from './colour/types';

// ---------- sRGB (0-255) -> CIE Lab, D65 ----------

export function srgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return linearRgbToLab(lin(r), lin(g), lin(b));
}

/** Linear sRGB (0-1, D65 primaries) -> CIE Lab. */
export function linearRgbToLab(rl: number, gl: number, bl: number): Lab {
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

/** CIE Lab (D65) -> sRGB 0-255, clamped; the inverse of srgbToLab, for showing measured colours. */
export function labToSrgb(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const finv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = finv(fx) * 0.95047;
  const y = finv(fy);
  const z = finv(fz) * 1.08883;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const gam = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, v * 255)));
  };
  return [gam(rl), gam(gl), gam(bl)];
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
 * How far a sample may stray from a cell's center, as fractions of one cell.
 * `half` is the patch's half-width; `off` is the radius of the ring of extra
 * patches (0 = no ring, a single patch at the center).
 */
export interface CellPlan {
  half: number;
  off: number;
  /** Patch half-width for the center cell, which trades width for reach. */
  centreHalf: number;
  /** Ring radius for the center cell. May be 0 when there is no budget. */
  centreOff: number;
}

/**
 * Diagonal offset (in cells) at which all four ring patches clear the center
 * logo. MEASURED on a GAN cube whose center cap carries a large blue mark:
 * out to ±0.20 of a cell the sample is 100% logo, at ±0.26 it is still
 * 86–91% logo, and only at ±0.30 do all four diagonal patches come off it.
 * Diagonal placement is what makes this affordable — a corner at ±0.30 sits
 * 0.42 from the cell center but only 0.30 from the seam on either axis.
 */
const LOGO_CLEAR_OFF = 0.3;

/** Patch half-width on the center cell: small, because reach matters more. */
const CENTRE_PATCH_HALF = 0.07;

/**
 * Lab gap between the middle of the center cell and its ring above which the
 * center sticker is taken to be obscured — by a logo, a fingertip, or glare.
 * The ring is then the only honest reading of the sticker.
 */
const CENTRE_OBSCURED_LAB = 12;

/**
 * When the center is obscured, the two ring patches the reading is built from
 * must agree within this. Beyond it the ring is straddling seams or the
 * obstruction covers most of the cell, and there is no sticker reading to be
 * had — identify.ts declines the face rather than guess.
 */
export const RING_INCOHERENT_LAB = 25;

/**
 * Median corner error of the deployed detector, in SOURCE px. Stage 2 is
 * scale-normalized by the crop (model/PORTRAIT-DESIGN.md section 0): its
 * ~3 px of model error is 2.5 source px at the range floor and ~8 on the
 * nearest cubes, where stickers are 60+ px and it does not matter. A flat
 * 3 source px is the conservative end of that.
 */
const CORNER_ERR_PX = 3.0;

/**
 * The scanning-range floor: a face whose longest edge is below this fraction
 * of the SOURCE FRAME HEIGHT is further than a person can hold a cube. The
 * trainer buries anything smaller in the ignore region (model/train/shapes.py
 * MIN_FACE_EDGE_FRAC) and naming a face this small asks the detector for a
 * precision it was never trained to have. A fraction of the frame height, not
 * a pixel count, because the stage-2 crop zooms the cube to a constant size
 * in model px - only the source frame still says how far away it is.
 * 0.133 = 85 px on a 480x640 phone frame.
 */
export const MIN_FACE_EDGE_FRAC = 0.133;

/** The floor in pixels of a source frame `frameH` tall. */
export function minFaceEdgePx(frameH: number): number {
  return MIN_FACE_EDGE_FRAC * frameH;
}

/**
 * Sampling geometry for a face with `cellPx` SOURCE pixels per sticker, or
 * null if the face is too small to sample at all (its edge, 3 cells, is under
 * `minEdgePx` - the caller derives that from the source frame height with
 * minFaceEdgePx; 0 disables the gate).
 *
 * MEASURED (model/data_real_val, 74 labelled faces, deployed v4ft1): the
 * detector's corner error is nearly flat in pixels — 3.9 px on the smallest
 * faces, 2.1 px on the largest — but as a fraction of a sticker it runs from
 * 0.91 down to 0.06. The grid displacement, not the color, is what breaks
 * glancing faces.
 *
 * So the budget between a cell's center and its seam (half a cell) is spent
 * as: 0.5, less the expected displacement, less 5% slack. Patch half-width is
 * paid first (capped at 0.15 — wider buys no averaging worth the reach), and
 * only the remainder funds a ring.
 */
export function facePlan(cellPx: number, minEdgePx = 0): CellPlan | null {
  if (cellPx * 3 < minEdgePx) return null;
  const budget = 0.45 - CORNER_ERR_PX / Math.max(cellPx, 1e-6);
  if (budget <= 0.02) return null;
  // The eight outer cells have nothing to dodge (measured: their middle and
  // their own ±25% ring differ by 1.6–2.8 Lab), so they spend the budget on
  // patch width. The CENTER cell is the opposite: its middle is the one place
  // a logo is guaranteed to be, so it spends the budget on reach first and
  // takes whatever width is left.
  const half = Math.min(0.15, budget);
  const centreOff = Math.max(0, Math.min(LOGO_CLEAR_OFF, budget - CENTRE_PATCH_HALF));
  return { half, off: centreOff, centreHalf: CENTRE_PATCH_HALF, centreOff };
}

/** The plan a caller gets when it does not supply one: today's fixed geometry. */
const LEGACY_PLAN: CellPlan = { half: 0.2, off: 0.25, centreHalf: 0.1, centreOff: 0.25 };

/**
 * One of the eight OUTER cells: a single patch at the cell's center.
 *
 * MEASURED: on full-resolution photos with hand-labelled geometry the gap
 * between a sticker's middle and its own ±25% ring is 1.6–2.8 Lab for these
 * eight cells and 8.3 for the face center. There is nothing here to dodge, so
 * a ring would only spend reach toward the seam and buy noise. The center
 * cell, which does have something to dodge, is sampleCentreCell.
 */
export function sampleCellRobust(
  img: ImageData,
  cx: number,
  cy: number,
  cellSize: number,
  plan: CellPlan = LEGACY_PLAN,
): CellSample {
  const patchSize = Math.max(2, Math.round(2 * plan.half * cellSize));
  return samplePatch(img, cx, cy, patchSize);
}

/**
 * The center cell, which is the only one that has to work around something
 * sitting in its middle.
 *
 * Reads a ring of four DIAGONAL patches and takes their medoid, then compares
 * that to the middle of the cell. The middle is never allowed to vote: on a
 * logo'd cube it is contaminated essentially always (measured: 100% logo out
 * to ±0.20 of a cell), so including it would let the contaminant win a
 * majority rather than be outvoted by it.
 */
export function sampleCentreCell(
  img: ImageData,
  cx: number,
  cy: number,
  cellSize: number,
  plan: CellPlan,
): CellSample {
  const patchSize = Math.max(2, Math.round(2 * plan.centreHalf * cellSize));
  const inner = samplePatch(img, cx, cy, patchSize);
  if (plan.centreOff < 0.02) return inner;
  const off = cellSize * plan.centreOff;
  const ring = ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]) =>
    samplePatch(img, cx + sx * off, cy + sy * off, patchSize),
  );
  const byDistance = ring
    .map((s) => ({ s, d: labDistance(s.lab, inner.lab) }))
    .sort((a, b) => b.d - a.d);
  // Nothing is on the middle: the whole cell agrees, and the tight middle
  // patch is the most accurate reading of it.
  if (byDistance[0]!.d <= CENTRE_OBSCURED_LAB) return { ...inner, obscured: false };
  // Something IS on the middle. The contaminant is by construction central,
  // so the ring patches least like the middle are the least contaminated —
  // MEASURED on a GAN center mark at the reach the budget allows (±0.195):
  // the medoid of the ring names white at distance 30-39, the mean of the two
  // furthest at 20-21, against a middle that names blue. Two rather than one
  // so a single stray patch cannot carry the reading on its own.
  const [a, b] = [byDistance[0]!.s, byDistance[1]!.s];
  const rgb: [number, number, number] = [
    (a.rgb[0] + b.rgb[0]) / 2, (a.rgb[1] + b.rgb[1]) / 2, (a.rgb[2] + b.rgb[2]) / 2,
  ];
  return {
    lab: srgbToLab(rgb[0], rgb[1], rgb[2]),
    rgb,
    obscured: true,
    ringSpread: labDistance(a.lab, b.lab),
  };
}

/**
 * Sample the 9 sticker cells of a face grid, row-major.
 *
 * `plan` must be supplied whenever `rect` is a rectified canvas, because the
 * canvas size says nothing about how many real pixels the face occupied —
 * derive it with facePlan() from the source quad. When omitted the rect is
 * assumed to be in source pixels and the plan comes from its own cell size.
 *
 * Only cell 4 gets the ring: see sampleCellRobust.
 */
export function sampleGridCells(img: ImageData, rect: Rect, plan?: CellPlan): CellSample[] {
  const cellSize = Math.min(rect.w, rect.h) / 3;
  const p = plan ?? facePlan(cellSize) ?? LEGACY_PLAN;
  return gridCellCenters(rect).map(([cx, cy], i) =>
    i === 4 ? sampleCentreCell(img, cx, cy, cellSize, p)
            : sampleCellRobust(img, cx, cy, cellSize, p),
  );
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

// DECISION: a face is hopeless only when it is BOTH dark (median L < 22) and
// chroma-dead (median chroma < 9) — then color identity has drowned in sensor
// noise. Dark alone is fine: the backlit-kitchen frame fixtures sit at
// median L 8-25 yet classify at 44/45 once exposure is normalized (see
// test/lowlight.test.ts), so refusing on lightness alone would reject scans
// that actually work. The chroma-dead case comes from fixture
// cube-scan-1789100642010.json, whose R face read near-black (median L 6,
// median chroma 7) with a noise-green tint. Tune against fixtures.
const MIN_FACE_LIGHTNESS = 22;
const MIN_FACE_CHROMA = 9;

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
const MAX_FACE_LIGHTNESS = 96;

/** True when a face reading is so blown out that nothing can be read from it. */
export function isFaceBlownOut(cells: readonly Lab[]): boolean {
  if (labMedian(cells).L <= MAX_FACE_LIGHTNESS) return false;
  const chromas = cells.map((c) => Math.hypot(c.a, c.b)).sort((a, b) => a - b);
  return chromas[chromas.length >> 1]! < MIN_FACE_CHROMA;
}

// ---------- assignment ----------
//
// The Hungarian solver behind every "which is which" decision that must be
// a bijection: the six palette colours to the six colour names
// (colour/naming.ts) and the exact decoder's per-colour quotas
// (colour/decode.ts). Fifty-four independent nearest-centroid calls cannot
// express "nine of each colour"; an assignment can. See
// web/src/color-notes.md item 3.

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

// ---------- robust patch statistics ----------
//
// samplePatch (above) returns the MEAN of a patch, which averages glare, seam
// spill and finger edges straight into a sticker's color. samplePatchStats
// and its callers below return the actual distribution — a trimmed median
// plus clip/dark fractions and a spread — so evidence.ts can down-weight or
// discard a contaminated reading instead of silently blending it in.

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** DECISION: trim the brightest and darkest 10% of pixels (by luminance) before the per-channel median. */
export const PATCH_TRIM = 0.1;
// A pixel is GLARE when it is blown towards white - its darkest channel is
// near the top - not when one channel saturates: the phone's ISP clips the
// red channel of every orange sticker to 255 (and often red's), and "any
// channel >= 250" threw every orange reading of the third phone session
// away (18 stickers "unseen" on faces that had been shown for 100 frames).
// A saturated channel is a censored value, reported per channel in
// `censored`; it is not missing pigment.
const CLIP_LEVEL = 235; // min(r, g, b) at or above this counts as glare
const DARK_LEVEL = 0.08 * 255; // luminance below this counts as dark

/**
 * Statistics of an axis-aligned square patch (side `size` px) centered at
 * (cx, cy): the same geometry as samplePatch, but a trimmed-median color plus
 * clip/dark fractions and a spread instead of a single mean.
 */
export function samplePatchStats(img: ImageData, cx: number, cy: number, size = 12): PatchStats {
  const half = size / 2;
  const x0 = Math.max(0, Math.round(cx - half));
  const y0 = Math.max(0, Math.round(cy - half));
  const x1 = Math.min(img.width, Math.round(cx + half));
  const y1 = Math.min(img.height, Math.round(cy + half));
  const d = img.data;
  // [r, g, b, luminance] per gathered pixel.
  const pixels: Array<[number, number, number, number]> = [];
  let clipped = 0;
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * img.width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      pixels.push([r, g, b, luma]);
      if (r >= CLIP_LEVEL && g >= CLIP_LEVEL && b >= CLIP_LEVEL) clipped++;
      if (luma < DARK_LEVEL) dark++;
    }
  }
  const n = pixels.length;
  if (n === 0) throw new Error(`samplePatchStats: patch at (${cx},${cy}) outside image`);

  pixels.sort((p, q) => p[3] - q[3]);
  // Drop the top and bottom PATCH_TRIM fraction, but never down to zero.
  const trim = Math.min(Math.floor(n * PATCH_TRIM), Math.floor((n - 1) / 2));
  const kept = pixels.slice(trim, n - trim);

  const rgb: [number, number, number] = [
    median(kept.map((p) => p[0])),
    median(kept.map((p) => p[1])),
    median(kept.map((p) => p[2])),
  ];
  const lab = srgbToLab(rgb[0], rgb[1], rgb[2]);
  const censored: [boolean, boolean, boolean] = [
    rgb[0] <= 0 || rgb[0] >= 255,
    rgb[1] <= 0 || rgb[1] >= 255,
    rgb[2] <= 0 || rgb[2] >= 255,
  ];
  const spread = median(kept.map((p) => labDistance(srgbToLab(p[0], p[1], p[2]), lab)));

  return { rgb, lab, clipFrac: clipped / n, darkFrac: dark / n, spread, censored, n };
}

/** One of the eight OUTER cells, robust version: mirrors sampleCellRobust's geometry. */
function sampleCellStats(
  img: ImageData,
  cx: number,
  cy: number,
  cellSize: number,
  plan: CellPlan = LEGACY_PLAN,
): PatchStats {
  const patchSize = Math.max(2, Math.round(2 * plan.half * cellSize));
  return samplePatchStats(img, cx, cy, patchSize);
}

/**
 * The center cell, robust version: mirrors sampleCentreCell's geometry (a
 * ring of four diagonal patches dodging the logo) but never blends two ring
 * patches into a mean — it takes their medoid instead, so the returned
 * statistics (clipFrac, darkFrac, spread) describe one real reading rather
 * than an average of two.
 *
 * `spread` is inflated to the median distance from the OTHER three ring
 * patches to the medoid when that is larger than the medoid's own spread:
 * a logo or fingertip that reaches part of the ring shows up here as
 * uncertainty in the returned stats rather than silently winning a vote.
 */
function sampleCentreStats(
  img: ImageData,
  cx: number,
  cy: number,
  cellSize: number,
  plan: CellPlan,
): PatchStats {
  const patchSize = Math.max(2, Math.round(2 * plan.centreHalf * cellSize));
  if (plan.centreOff < 0.02) return samplePatchStats(img, cx, cy, patchSize);
  const off = cellSize * plan.centreOff;
  const ring = ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]) =>
    samplePatchStats(img, cx + sx * off, cy + sy * off, patchSize),
  );
  let medoidIdx = 0;
  let bestSum = Infinity;
  for (let i = 0; i < ring.length; i++) {
    let sum = 0;
    for (let j = 0; j < ring.length; j++) {
      if (i !== j) sum += labDistance(ring[i]!.lab, ring[j]!.lab);
    }
    if (sum < bestSum) {
      bestSum = sum;
      medoidIdx = i;
    }
  }
  const medoid = ring[medoidIdx]!;
  const othersToMedoid = ring
    .filter((_, i) => i !== medoidIdx)
    .map((s) => labDistance(s.lab, medoid.lab));
  return {
    ...medoid,
    spread: Math.max(medoid.spread, median(othersToMedoid)),
    clipFrac: ring.reduce((s, r) => s + r.clipFrac, 0) / ring.length,
    darkFrac: ring.reduce((s, r) => s + r.darkFrac, 0) / ring.length,
    n: ring.reduce((s, r) => s + r.n, 0),
  };
}

/** Robust version of sampleGridCells: the 9 sticker cells of a face grid, row-major. */
export function sampleGridStats(img: ImageData, rect: Rect, plan?: CellPlan): PatchStats[] {
  const cellSize = Math.min(rect.w, rect.h) / 3;
  const p = plan ?? facePlan(cellSize) ?? LEGACY_PLAN;
  return gridCellCenters(rect).map(([cx, cy], i) =>
    i === 4 ? sampleCentreStats(img, cx, cy, cellSize, p)
             : sampleCellStats(img, cx, cy, cellSize, p),
  );
}

/**
 * Variance of the 3x3 Laplacian of the grey image (sharpness; higher is
 * sharper). Used on the rectified 90x90 warp to flag a motion-blurred face
 * before its colors are trusted.
 */
export function blurScore(img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): number {
  const { width, height, data } = img;
  const grey = new Float64Array(width * height);
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) {
    grey[p] = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  }
  const responses: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      responses.push(grey[idx - width]! + grey[idx + width]! + grey[idx - 1]! + grey[idx + 1]! - 4 * grey[idx]!);
    }
  }
  if (responses.length === 0) return 0;
  const mean = responses.reduce((s, v) => s + v, 0) / responses.length;
  return responses.reduce((s, v) => s + (v - mean) * (v - mean), 0) / responses.length;
}

/**
 * Foreshortening of a quad: shorter mid-line over longer, 1 = square on.
 * Mid-lines join the midpoints of opposite edges (corners taken in order
 * around the quad, winding either way).
 */
export function quadViewCos(corners: ReadonlyArray<readonly [number, number]>): number {
  const mid = (a: readonly [number, number], b: readonly [number, number]): [number, number] =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [c0, c1, c2, c3] = corners;
  const midA = dist(mid(c0!, c1!), mid(c2!, c3!));
  const midB = dist(mid(c1!, c2!), mid(c3!, c0!));
  const lo = Math.min(midA, midB);
  const hi = Math.max(midA, midB);
  return hi <= 0 ? 1 : lo / hi;
}

/** Longest edge of a quad in px. */
export function quadEdgePx(corners: ReadonlyArray<readonly [number, number]>): number {
  let max = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > max) max = d;
  }
  return max;
}

// Grid-prior quad scoring and refinement (M6): a correct face quad,
// homography-warped to a square, puts the dark seams between cubies at
// exactly 1/3 and 2/3 in both directions. seamScore() measures how well a
// quad's warp matches that thirds prior; refineQuad() nudges corners to
// maximize it. Ports the seam-score semantics of
// model/train/grid_check.py (Python, PIL/numpy) to pure TS on ImageDataLike.
//
// Pure functions: no DOM, no canvas. Sampling goes through the existing
// warpQuad() so this stays consistent with rectify.ts's corner convention
// (TL,TR,BR,BL) and bilinear sampling.

import { warpQuad, type ImageDataLike, type Quad } from '../rectify';

export interface SeamResult { score: number; strength: number; }

// DECISION: keep grid_check.py's pixel-space window (+/-4px "at thirds",
// >7px away counts as "elsewhere", 4px border skip) rather than scaling with
// warpSize. Our default warpSize (96) is close enough to the Python
// reference's WARP=90 that the same pixel constants apply.
const SEAM_WINDOW_PX = 4;
const SEAM_MARGIN_PX = 7;
const BORDER_PX = 4;

function toGray(img: ImageDataLike): Float64Array {
  const { width, height, data } = img;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    gray[i] = (data[o] + data[o + 1] + data[o + 2]) / 3;
  }
  return gray;
}

/**
 * Gradient profile along one axis, averaged across the perpendicular one.
 * axis 0: |gray[y+1,x]-gray[y,x]| averaged over x -> profile indexed by y
 *         (picks up horizontal seam lines, which show up as a step in y).
 * axis 1: |gray[y,x+1]-gray[y,x]| averaged over y -> profile indexed by x
 *         (picks up vertical seam lines).
 */
function axisProfile(gray: Float64Array, width: number, height: number, axis: 0 | 1): Float64Array {
  if (axis === 0) {
    const prof = new Float64Array(height - 1);
    for (let y = 0; y < height - 1; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += Math.abs(gray[(y + 1) * width + x] - gray[y * width + x]);
      }
      prof[y] = sum / width;
    }
    return prof;
  }
  const prof = new Float64Array(width - 1);
  for (let x = 0; x < width - 1; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      sum += Math.abs(gray[y * width + (x + 1)] - gray[y * width + x]);
    }
    prof[x] = sum / height;
  }
  return prof;
}

function axisSeamScore(prof: Float64Array, size: number): { score: number; strength: number } {
  const t1 = size / 3;
  const t2 = (2 * size) / 3;
  let atSum = 0, atN = 0;
  let elseSum = 0, elseN = 0;
  for (let i = BORDER_PX; i < prof.length - BORDER_PX; i++) {
    const d1 = Math.abs(i - t1);
    const d2 = Math.abs(i - t2);
    if (d1 <= SEAM_WINDOW_PX || d2 <= SEAM_WINDOW_PX) {
      atSum += prof[i];
      atN++;
    } else if (d1 > SEAM_MARGIN_PX && d2 > SEAM_MARGIN_PX) {
      elseSum += prof[i];
      elseN++;
    }
  }
  const atMean = atN > 0 ? atSum / atN : 0;
  const elseMean = elseN > 0 ? elseSum / elseN : 0;
  return { score: atMean / Math.max(elseMean, 1e-6), strength: atMean };
}

/**
 * Warp the quad to warpSize and measure how well gradient energy
 * concentrates at the 1/3 and 2/3 seam lines, in both axes. See SeamResult.
 */
export function seamScore(img: ImageDataLike, quad: Quad, warpSize = 96): SeamResult {
  const warped = warpQuad(img, quad, warpSize);
  const gray = toGray(warped);
  let score = Infinity;
  let strength = Infinity;
  for (const axis of [0, 1] as const) {
    const prof = axisProfile(gray, warpSize, warpSize, axis);
    const r = axisSeamScore(prof, warpSize);
    score = Math.min(score, r.score);
    strength = Math.min(strength, r.strength);
  }
  return { score, strength };
}

const REFINE_WARP = 64; // smaller warp during search, for speed
const REFINE_STEPS = [3, 1]; // px in source space
const FINAL_WARP = 96;

/**
 * Local refinement: nudge each corner to maximize seamScore().score via
 * coordinate descent. Repeatedly cycles the step schedule [3, 1] px
 * (source space): each round sweeps every corner at each step size, trying
 * +/-step in x and +/-step in y and keeping any move that improves the
 * score. Rounds repeat until a full round makes no improvement (or the eval
 * budget runs out) - a single corner's move can distort the whole
 * projective warp enough to look worse in isolation, so getting from a
 * multi-corner perturbation back to alignment can take several rounds.
 * Evaluates at REFINE_WARP for speed; the returned SeamResult is
 * recomputed once at FINAL_WARP (96) for a faithful report.
 */
export function refineQuad(img: ImageDataLike, quad: Quad, opts: { maxEvals?: number } = {}): { quad: Quad; seam: SeamResult } {
  const maxEvals = opts.maxEvals ?? 160;
  let current: Array<[number, number]> = quad.map((p) => [p[0], p[1]]);
  let evals = 0;
  let bestScore = -Infinity;
  if (evals < maxEvals) {
    bestScore = seamScore(img, current, REFINE_WARP).score;
    evals++;
  }

  let improvedAny = true;
  while (improvedAny && evals < maxEvals) {
    improvedAny = false;
    for (const step of REFINE_STEPS) {
      const offsets: Array<[number, number]> = [[step, 0], [-step, 0], [0, step], [0, -step]];
      for (let ci = 0; ci < current.length && evals < maxEvals; ci++) {
        for (const [dx, dy] of offsets) {
          if (evals >= maxEvals) break;
          const trial = current.map((p, i) => (i === ci ? ([p[0] + dx, p[1] + dy] as [number, number]) : p));
          const r = seamScore(img, trial, REFINE_WARP);
          evals++;
          if (r.score > bestScore) {
            bestScore = r.score;
            current = trial;
            improvedAny = true;
          }
        }
      }
    }
  }

  const seam = seamScore(img, current, FINAL_WARP);
  return { quad: current, seam };
}

// Robust location statistics in 1-D and 3-D. Everything here is a pure
// function on plain arrays/tuples; no dependency on the rest of the colour
// pipeline beyond the Vec3 type.

import type { Vec3 } from './types';

/** Sorted-by-x weighted median: the x where cumulative weight first reaches half the total. */
export function weightedMedian(xs: readonly number[], ws: readonly number[]): number {
  const total = ws.reduce((s, w) => s + w, 0);
  if (total <= 0) return NaN;
  const order = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!);
  const half = total / 2;
  let cum = 0;
  for (const i of order) {
    cum += ws[i]!;
    if (cum >= half) return xs[i]!;
  }
  // Unreachable unless floating point rounds cum just short of half.
  return xs[order[order.length - 1]!]!;
}

/** Weighted median absolute deviation of xs from a given centre. */
export function weightedMAD(xs: readonly number[], ws: readonly number[], centre: number): number {
  const dev = xs.map((x) => Math.abs(x - centre));
  return weightedMedian(dev, ws);
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Weighted Weiszfeld iteration for the geometric median (minimizes sum of weighted distances). */
export function geometricMedian(points: readonly Vec3[], weights: readonly number[], iters = 20): Vec3 {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) throw new Error('geometricMedian: zero total weight');
  if (points.length === 1) return points[0]!;

  // Start from the weighted mean.
  let value: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const w = weights[i]!;
    value[0] += points[i]![0] * w;
    value[1] += points[i]![1] * w;
    value[2] += points[i]![2] * w;
  }
  value = [value[0] / total, value[1] / total, value[2] / total];

  for (let it = 0; it < iters; it++) {
    let numX = 0;
    let numY = 0;
    let numZ = 0;
    let den = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const w = weights[i]!;
      // Guard the division when the estimate coincides with a point.
      const d = Math.max(dist3(p, value), 1e-6);
      const iw = w / d;
      numX += p[0] * iw;
      numY += p[1] * iw;
      numZ += p[2] * iw;
      den += iw;
    }
    if (den <= 0) break;
    value = [numX / den, numY / den, numZ / den];
  }
  return value;
}

export interface RobustCentre {
  value: Vec3;
  weights: number[];
  spread: number;
}

/** Iteratively reweighted robust location in 3-D: geometric median + Cauchy down-weighting of outliers. */
export function robustCentre(
  points: readonly Vec3[],
  weights: readonly number[],
  opts?: { iters?: number; c?: number; floor?: number },
): RobustCentre {
  if (points.length === 0) throw new Error('robustCentre: empty input');
  if (points.length === 1) return { value: points[0]!, weights: [weights[0]!], spread: 0 };

  const iters = opts?.iters ?? 4;
  const c = opts?.c ?? 2.5;
  const floor = opts?.floor ?? 1.0;

  let value = geometricMedian(points, weights);
  let w = [...weights];

  for (let it = 0; it < iters; it++) {
    const d = points.map((p) => dist3(p, value));
    const scale = Math.max(weightedMAD(d, w, 0), floor);
    w = d.map((di, i) => weights[i]! / (1 + (di / (c * scale)) ** 2));
    value = geometricMedian(points, w);
  }

  const finalD = points.map((p) => dist3(p, value));
  const spread = weightedMAD(finalD, w, 0);
  return { value, weights: w, spread };
}

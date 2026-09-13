// Weighted k-clusters palette fit over the six cube colours, with robust
// (Cauchy-reweighted) centres and a Student-t membership model so a handful
// of glare/shadow readings don't drag a centre off its true location.

import type { Palette, Vec3 } from './types';
import { dist3, robustCentre } from './robust';

/** log-density of a multivariate Student-t (dim 3) at distance d from the centre, up to a constant. */
export function studentLogLik(d: number, sigma: number, nu: number): number {
  return -((nu + 3) / 2) * Math.log(1 + (d * d) / (nu * sigma * sigma)) - 3 * Math.log(sigma);
}

/** Soft memberships over the six colours: softmax of studentLogLik; a null centre gets 0. */
export function memberships(x: Vec3, palette: Pick<Palette, 'centres' | 'sigma'>, nu: number): number[] {
  const lls = palette.centres.map((c, i) => (c === null ? -Infinity : studentLogLik(dist3(x, c), palette.sigma[i]!, nu)));
  const finite = lls.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return lls.map(() => 0);
  const max = Math.max(...finite);
  const exps = lls.map((v) => (Number.isFinite(v) ? Math.exp(v - max) : 0));
  const total = exps.reduce((s, v) => s + v, 0);
  return exps.map((v) => (total > 0 ? v / total : 0));
}

/**
 * Greedy farthest-point seeding: first seed is the point of largest weight
 * (ties broken by first occurrence); each subsequent seed maximizes
 * weight * distance-to-nearest-existing-seed. Returns min(k, points.length) seeds.
 */
export function farthestPointSeeds(points: readonly Vec3[], weights: readonly number[], k: number): Vec3[] {
  const n = points.length;
  if (n === 0) return [];
  const m = Math.min(k, n);

  let firstIdx = 0;
  for (let i = 1; i < n; i++) {
    if (weights[i]! > weights[firstIdx]!) firstIdx = i;
  }
  const seeds: Vec3[] = [points[firstIdx]!];
  const minDist = points.map((p) => dist3(p, seeds[0]!));

  while (seeds.length < m) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const score = weights[i]! * minDist[i]!;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const pick = points[bestIdx]!;
    seeds.push(pick);
    for (let i = 0; i < n; i++) {
      const d = dist3(points[i]!, pick);
      if (d < minDist[i]!) minDist[i] = d;
    }
  }
  return seeds;
}

// Small deterministic LCG (Numerical Recipes constants) so restart seeding
// is repeatable across runs and platforms without pulling in a PRNG library.
function makeLCG(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** k-means++-style weighted-random seeding, using `rng` for both the first pick and the D^2 picks. */
function randomPlusPlusSeeds(points: readonly Vec3[], weights: readonly number[], k: number, rng: () => number): Vec3[] {
  const n = points.length;
  if (n === 0) return [];
  const m = Math.min(k, n);

  const totalW = weights.reduce((s, w) => s + w, 0);
  let r = rng() * totalW;
  let firstIdx = 0;
  for (; firstIdx < n - 1; firstIdx++) {
    r -= weights[firstIdx]!;
    if (r <= 0) break;
  }
  const seeds: Vec3[] = [points[firstIdx]!];
  const minDistSq = points.map((p) => dist3(p, seeds[0]!) ** 2);

  while (seeds.length < m) {
    const scores = points.map((p, i) => weights[i]! * minDistSq[i]!);
    const total = scores.reduce((s, v) => s + v, 0);
    let idx: number;
    if (total <= 0) {
      // Every remaining point coincides with an already-chosen seed: fall back to uniform.
      idx = Math.min(Math.floor(rng() * n), n - 1);
    } else {
      let rr = rng() * total;
      idx = 0;
      for (; idx < n - 1; idx++) {
        rr -= scores[idx]!;
        if (rr <= 0) break;
      }
    }
    const pick = points[idx]!;
    seeds.push(pick);
    for (let i = 0; i < n; i++) {
      const d = dist3(points[i]!, pick) ** 2;
      if (d < minDistSq[i]!) minDistSq[i] = d;
    }
  }
  return seeds;
}

/** Fill null slots in a seed list by farthest-point selection among points far from the non-null seeds. */
function resolveSeeds(seeds: readonly (Vec3 | null)[], xs: readonly Vec3[], ws: readonly number[], k: number): (Vec3 | null)[] {
  const result: (Vec3 | null)[] = seeds.slice(0, k);
  while (result.length < k) result.push(null);

  const chosen: Vec3[] = result.filter((s): s is Vec3 => s !== null);
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== null) continue;
    if (chosen.length === 0 || xs.length === 0) {
      // No reference point yet: fall back to plain farthest-point seeding.
      const fallback = farthestPointSeeds(xs, ws, 1);
      if (fallback.length === 0) continue;
      result[i] = fallback[0]!;
      chosen.push(fallback[0]!);
      continue;
    }
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let j = 0; j < xs.length; j++) {
      let minD = Infinity;
      for (const c of chosen) minD = Math.min(minD, dist3(xs[j]!, c));
      const score = ws[j]! * minD;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    const pick = xs[bestIdx]!;
    result[i] = pick;
    chosen.push(pick);
  }
  return result;
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function assign(points: readonly { x: Vec3; w: number }[], centres: readonly (Vec3 | null)[], sigma: readonly number[], nu: number): number[] {
  return points.map((p) => {
    let best = -1;
    let bestLL = -Infinity;
    for (let c = 0; c < centres.length; c++) {
      const centre = centres[c];
      if (centre === null) continue;
      const ll = studentLogLik(dist3(p.x, centre), sigma[c]!, nu);
      if (ll > bestLL) {
        bestLL = ll;
        best = c;
      }
    }
    return best;
  });
}

export interface PaletteFit {
  centres: (Vec3 | null)[];
  sigma: number[];
  labels: number[];
  objective: number;
}

export interface FitOptions {
  seeds?: (Vec3 | null)[];
  restarts?: number;
  iters?: number;
  nu?: number;
  sigmaFloor?: number;
  minWeight?: number;
}

interface RunConfig {
  iters: number;
  nu: number;
  sigmaFloor: number;
  minWeight: number;
}

function runKClusters(points: readonly { x: Vec3; w: number }[], initCentres: readonly (Vec3 | null)[], k: number, cfg: RunConfig): PaletteFit {
  const { iters, nu, sigmaFloor, minWeight } = cfg;
  const centres: (Vec3 | null)[] = initCentres.slice(0, k);
  while (centres.length < k) centres.push(null);
  const sigma: number[] = centres.map((c) => (c === null ? 0 : sigmaFloor));
  // Sentinel distinct from any real label so the first iteration always counts as "changed".
  let labels: number[] = new Array(points.length).fill(-2);

  for (let it = 0; it < iters; it++) {
    const newLabels = assign(points, centres, sigma, nu);
    const changed = !arraysEqual(newLabels, labels);
    labels = newLabels;

    for (let c = 0; c < k; c++) {
      if (centres[c] === null) continue;
      const memberIdx: number[] = [];
      for (let i = 0; i < points.length; i++) {
        if (labels[i] === c) memberIdx.push(i);
      }
      if (memberIdx.length === 0) {
        centres[c] = null;
        sigma[c] = 0;
        continue;
      }
      const totalW = memberIdx.reduce((s, i) => s + points[i]!.w, 0);
      if (totalW < minWeight) {
        centres[c] = null;
        sigma[c] = 0;
        continue;
      }
      const pts = memberIdx.map((i) => points[i]!.x);
      const wts = memberIdx.map((i) => points[i]!.w);
      const rc = robustCentre(pts, wts);
      centres[c] = rc.value;
      sigma[c] = Math.max(rc.spread, sigmaFloor);
    }

    if (!changed) break;
  }

  // DECISION: re-assign once more against the converged centres. A cluster can die on the
  // same iteration its members were assigned to it, which would otherwise leave labels
  // pointing at a null centre; a final pass guarantees the "never a null cluster" invariant
  // and keeps the objective consistent with the returned centres/sigma.
  const finalLabels = assign(points, centres, sigma, nu);

  let objective = 0;
  for (let i = 0; i < points.length; i++) {
    const c = finalLabels[i]!;
    if (c < 0) continue; // no live centre at all (degenerate: e.g. k=0 or everything died)
    const d = dist3(points[i]!.x, centres[c]!);
    objective += points[i]!.w * -studentLogLik(d, sigma[c]!, nu);
  }

  return { centres, sigma, labels: finalLabels, objective };
}

/**
 * Weighted k-clusters fit with robust centres (see module comment). Runs the seeded
 * initialization plus `restarts` random k-means++-style initializations and keeps
 * whichever converges to the lowest objective.
 */
export function fitPalette(points: readonly { x: Vec3; w: number }[], k: number, opts?: FitOptions): PaletteFit {
  const restarts = opts?.restarts ?? 3;
  const iters = opts?.iters ?? 10;
  const nu = opts?.nu ?? 3;
  const sigmaFloor = opts?.sigmaFloor ?? 2.0;
  const minWeight = opts?.minWeight ?? 1.0;
  const cfg: RunConfig = { iters, nu, sigmaFloor, minWeight };

  const xs = points.map((p) => p.x);
  const ws = points.map((p) => p.w);

  const primarySeeds: (Vec3 | null)[] = opts?.seeds ? resolveSeeds(opts.seeds, xs, ws, k) : farthestPointSeeds(xs, ws, k);
  while (primarySeeds.length < k) primarySeeds.push(null);

  let best = runKClusters(points, primarySeeds, k, cfg);

  for (let r = 0; r < restarts; r++) {
    // DECISION: seed the LCG from r+1 (r alone would still work, but keeps the stream
    // away from state 0 on the very first restart for extra margin against short cycles).
    const rng = makeLCG(r + 1);
    const seeds: (Vec3 | null)[] = randomPlusPlusSeeds(xs, ws, k, rng);
    while (seeds.length < k) seeds.push(null);
    const fit = runKClusters(points, seeds, k, cfg);
    if (fit.objective < best.objective) best = fit;
  }

  return best;
}

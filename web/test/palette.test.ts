import { describe, it, expect } from 'vitest';
import { studentLogLik, memberships, farthestPointSeeds, fitPalette } from '../src/colour/palette';
import type { Vec3 } from '../src/colour/types';
import { makeLcg } from './helpers';

// Rough Lab-ish triples for the six cube colours: well separated, roughly the
// real spread we see off a cube (see src/colour/types.ts PatchStats/Lab).
const TRUE_CENTRES: Record<string, Vec3> = {
  white: [95, 0, 0],
  yellow: [90, -15, 75],
  red: [50, 70, 55],
  orange: [65, 45, 60],
  green: [60, -55, 45],
  blue: [35, 10, -55],
};

function noise(rand: () => number, sd: number): number {
  // Sum of two uniforms approximates a bell curve well enough for a synthetic test fixture.
  return ((rand() + rand() - 1) * sd) / 0.4082; // 0.4082 ~= sd of one (rand()+rand()-1)
}

function makeCluster(rand: () => number, centre: Vec3, n: number, sd: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    pts.push([centre[0] + noise(rand, sd), centre[1] + noise(rand, sd), centre[2] + noise(rand, sd)]);
  }
  return pts;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function nearestTrueCentre(p: Vec3): number {
  return Math.min(...Object.values(TRUE_CENTRES).map((c) => dist(p, c)));
}

describe('studentLogLik', () => {
  it('is highest at d = 0 and decreases with distance', () => {
    const at0 = studentLogLik(0, 5, 3);
    const at5 = studentLogLik(5, 5, 3);
    const at20 = studentLogLik(20, 5, 3);
    expect(at0).toBeGreaterThan(at5);
    expect(at5).toBeGreaterThan(at20);
  });
});

describe('memberships', () => {
  const palette = {
    centres: [[0, 0, 0], null, [100, 0, 0]] as (Vec3 | null)[],
    sigma: [5, 0, 5],
  };

  it('gives a point at a centre high membership there', () => {
    const m = memberships([0, 0, 0], palette, 3);
    expect(m[0]).toBeGreaterThan(0.95);
  });

  it('always gives a null centre zero membership', () => {
    const m = memberships([50, 0, 0], palette, 3);
    expect(m[1]).toBe(0);
  });

  it('sums to 1 over the live centres', () => {
    const m = memberships([30, 0, 0], palette, 3);
    expect(m.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });
});

describe('farthestPointSeeds', () => {
  it('picks one seed near each of the six colours', () => {
    const rand = makeLcg(1);
    const points: Vec3[] = [];
    for (const c of Object.values(TRUE_CENTRES)) points.push(...makeCluster(rand, c, 30, 4));
    const weights = points.map(() => 1);

    const seeds = farthestPointSeeds(points, weights, 6);
    expect(seeds.length).toBe(6);

    for (const c of Object.values(TRUE_CENTRES)) {
      const nearestSeed = Math.min(...seeds.map((s) => dist(s, c)));
      expect(nearestSeed).toBeLessThan(20);
    }
    // Every true centre should claim a distinct seed (no two colours sharing one seed).
    const claims = Object.values(TRUE_CENTRES).map((c) => seeds.map((s) => dist(s, c)).indexOf(Math.min(...seeds.map((s) => dist(s, c)))));
    expect(new Set(claims).size).toBe(6);
  });

  it('returns min(k, n) seeds', () => {
    const points: Vec3[] = [[0, 0, 0], [1, 1, 1]];
    expect(farthestPointSeeds(points, [1, 1], 6).length).toBe(2);
  });

  it('breaks weight ties by first occurrence', () => {
    const points: Vec3[] = [[0, 0, 0], [10, 10, 10]];
    const seeds = farthestPointSeeds(points, [1, 1], 1);
    expect(seeds).toEqual([[0, 0, 0]]);
  });
});

describe('fitPalette', () => {
  it('recovers all six well-separated colours within 3 units', () => {
    const rand = makeLcg(7);
    const points: { x: Vec3; w: number }[] = [];
    for (const c of Object.values(TRUE_CENTRES)) {
      for (const p of makeCluster(rand, c, 30, 4)) points.push({ x: p, w: 1 });
    }

    const fit = fitPalette(points, 6);
    const live = fit.centres.filter((c): c is Vec3 => c !== null);
    expect(live.length).toBe(6);

    for (const c of Object.values(TRUE_CENTRES)) {
      const nearest = Math.min(...live.map((lc) => dist(lc, c)));
      expect(nearest).toBeLessThan(3);
    }
    // Labels never point at a null cluster.
    for (const l of fit.labels) {
      expect(l).toBeGreaterThanOrEqual(0);
      expect(fit.centres[l]).not.toBeNull();
    }
  });

  it('gives a point right at a centre >0.95 membership there once fit', () => {
    const rand = makeLcg(7);
    const points: { x: Vec3; w: number }[] = [];
    for (const c of Object.values(TRUE_CENTRES)) {
      for (const p of makeCluster(rand, c, 30, 4)) points.push({ x: p, w: 1 });
    }
    const fit = fitPalette(points, 6);

    const white = TRUE_CENTRES.white!;
    const nearestIdx = fit.centres.reduce<{ idx: number; d: number }>((best, c, i) => {
      if (c === null) return best;
      const d = dist(c, white);
      return d < best.d ? { idx: i, d } : best;
    }, { idx: -1, d: Infinity }).idx;

    const m = memberships(white, { centres: fit.centres, sigma: fit.sigma }, 3);
    expect(m[nearestIdx]!).toBeGreaterThan(0.95);
  });

  it('does not throw with only 4 of 6 colours present (documented: surplus seeds split rather than die)', () => {
    const rand = makeLcg(11);
    const present = ['white', 'red', 'green', 'blue'] as const;
    const points: { x: Vec3; w: number }[] = [];
    for (const name of present) {
      for (const p of makeCluster(rand, TRUE_CENTRES[name]!, 30, 4)) points.push({ x: p, w: 1 });
    }

    let fit: ReturnType<typeof fitPalette> | undefined;
    expect(() => {
      fit = fitPalette(points, 6);
    }).not.toThrow();

    const live = fit!.centres.filter((c): c is Vec3 => c !== null);
    // DOCUMENTED BEHAVIOUR (seed 11, this noise draw): the two surplus seeds do not die
    // (default minWeight=1.0 only requires 1 unit of member weight, and every seed captures
    // at least a handful of points) — instead they land inside the white and red clusters
    // and split each in two. All 6 centres stay live; none is a stray in empty space. Every
    // live centre sits within 6 units of the true centre it split off from — looser than the
    // "clean fit" 3-unit bound because a partial sample's mean is biased away from the full
    // population mean.
    expect(live.length).toBe(6);
    for (const c of live) {
      expect(nearestTrueCentre(c)).toBeLessThan(6);
    }
  });

  it('is not dragged off by a low-weight junk cluster', () => {
    const rand = makeLcg(13);
    const points: { x: Vec3; w: number }[] = [];
    for (const c of Object.values(TRUE_CENTRES)) {
      for (const p of makeCluster(rand, c, 30, 4)) points.push({ x: p, w: 1 });
    }
    for (let i = 0; i < 10; i++) points.push({ x: [30, 10, 10], w: 0.1 });

    const fit = fitPalette(points, 6);
    const live = fit.centres.filter((c): c is Vec3 => c !== null);

    for (const c of Object.values(TRUE_CENTRES)) {
      const nearest = Math.min(...live.map((lc) => dist(lc, c)));
      expect(nearest).toBeLessThan(3);
    }
  });
});

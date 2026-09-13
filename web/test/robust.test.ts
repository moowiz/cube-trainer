import { describe, it, expect } from 'vitest';
import { weightedMedian, weightedMAD, dist3, geometricMedian, robustCentre } from '../src/colour/robust';
import type { Vec3 } from '../src/colour/types';
import { makeLcg } from './helpers';

describe('weightedMedian', () => {
  it('weights shift the median toward the heavy sample', () => {
    // [1, 2, 3] with equal weights would give 2; weight 10 on the 3 pulls it there.
    expect(weightedMedian([1, 2, 3], [1, 1, 10])).toBe(3);
  });

  it('reduces to the ordinary median with equal weights', () => {
    expect(weightedMedian([5, 1, 3], [1, 1, 1])).toBe(3);
  });

  it('is order-independent (sorts internally)', () => {
    expect(weightedMedian([3, 1, 2], [1, 1, 1])).toBe(2);
  });

  it('returns NaN when total weight is zero', () => {
    expect(Number.isNaN(weightedMedian([1, 2, 3], [0, 0, 0]))).toBe(true);
  });
});

describe('weightedMAD', () => {
  it('matches a hand-checked deviation median', () => {
    // deviations from 3: [2, 1, 0, 1, 2]; sorted [0,1,1,2,2], equal weights -> median 1.
    expect(weightedMAD([1, 2, 3, 4, 5], [1, 1, 1, 1, 1], 3)).toBe(1);
  });

  it('is zero when every point sits at the centre', () => {
    expect(weightedMAD([7, 7, 7], [1, 2, 3], 7)).toBe(0);
  });
});

describe('dist3', () => {
  it('computes Euclidean distance', () => {
    expect(dist3([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 10);
  });
});

describe('geometricMedian', () => {
  it('lands on the shared centre of symmetric points', () => {
    const pts: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    const m = geometricMedian(pts, [1, 1, 1, 1]);
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it('returns the sole point for a single input', () => {
    const m = geometricMedian([[5, 6, 7]], [2]);
    expect(m).toEqual([5, 6, 7]);
  });

  it('throws when total weight is zero', () => {
    expect(() => geometricMedian([[1, 2, 3], [4, 5, 6]], [0, 0])).toThrow();
  });
});

describe('robustCentre', () => {
  function lcgNoise(rand: () => number, amplitude: number): number {
    return (rand() * 2 - 1) * amplitude;
  }

  it('recovers the inlier centre and down-weights outliers', () => {
    const rand = makeLcg(42);
    const centre: Vec3 = [10, 20, 30];
    const points: Vec3[] = [];
    for (let i = 0; i < 30; i++) {
      points.push([centre[0] + lcgNoise(rand, 2), centre[1] + lcgNoise(rand, 2), centre[2] + lcgNoise(rand, 2)]);
    }
    const outlierStart = points.length;
    for (let i = 0; i < 5; i++) {
      points.push([200, 200, 200]);
    }
    const weights = points.map(() => 1);

    const result = robustCentre(points, weights);

    expect(dist3(result.value, centre)).toBeLessThan(1.0);

    const inlierWeights = result.weights.slice(0, outlierStart);
    const outlierWeights = result.weights.slice(outlierStart);
    const minInlier = Math.min(...inlierWeights);
    const maxOutlier = Math.max(...outlierWeights);
    expect(maxOutlier).toBeLessThan(0.05 * minInlier);

    // Spread should track the inliers' noise (amplitude 2), not the 200-away outliers.
    expect(result.spread).toBeLessThan(3);
  });

  it('returns the point itself for a single input, with zero spread', () => {
    const result = robustCentre([[5, 5, 5]], [1]);
    expect(result.value).toEqual([5, 5, 5]);
    expect(result.spread).toBe(0);
    expect(result.weights).toEqual([1]);
  });

  it('throws on empty input', () => {
    expect(() => robustCentre([], [])).toThrow();
  });

  it('throws when every weight is zero (propagated from geometricMedian)', () => {
    const points: Vec3[] = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    expect(() => robustCentre(points, [0, 0, 0])).toThrow();
  });
});

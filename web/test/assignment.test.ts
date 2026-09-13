// The balanced-assignment solver. It is NOT wired into assembleState (see the
// MEASURED note there — on the current fixtures it trades one fixture's gain
// for another's loss), but it is the implementation of color-notes.md item 3
// and is kept correct and tested for when better centroids make it pay.
import { describe, expect, it } from 'vitest';
import { assignBalanced, solveAssignment } from '../src/color';
import type { Lab } from '../src/types';

describe('solveAssignment', () => {
  it('finds the minimum-cost perfect matching', () => {
    // Optimum is the anti-diagonal (cost 3), not the greedy diagonal (cost 5).
    const cost = [
      [1, 2, 3],
      [3, 1, 2],
      [2, 3, 1],
    ];
    const rowToCol = solveAssignment(cost);
    expect(new Set(rowToCol).size).toBe(3);
    const total = rowToCol.reduce((sum, col, row) => sum + cost[row]![col]!, 0);
    expect(total).toBe(3);
  });

  it('beats greedy where greedy is trapped', () => {
    // Greedy takes (0,0)=1 and is then forced into (1,1)=9 for a total of 10;
    // the optimum is 2 + 3 = 5.
    const cost = [
      [1, 2],
      [3, 9],
    ];
    const rowToCol = solveAssignment(cost);
    const total = rowToCol.reduce((sum, col, row) => sum + cost[row]![col]!, 0);
    expect(total).toBe(5);
    expect(rowToCol).toEqual([1, 0]);
  });

  it('rejects a non-square matrix', () => {
    expect(() => solveAssignment([[1, 2, 3], [1, 2, 3]])).toThrow(/square/);
  });
});

describe('assignBalanced', () => {
  const lab = (L: number, a: number, b: number): Lab => ({ L, a, b });

  it('gives every cluster exactly its quota', () => {
    const centroids = [lab(50, 60, 40), lab(50, -60, 40)];
    // Five samples hug the first centroid, one hugs the second - unconstrained
    // that is 5/1, and the quota must force it to 3/3.
    const samples = [
      lab(50, 61, 40), lab(50, 59, 40), lab(50, 58, 41),
      lab(50, 40, 40), lab(50, 20, 40), lab(50, -59, 40),
    ];
    const labels = assignBalanced(samples, centroids, 3);
    expect(labels.filter((l) => l === 0)).toHaveLength(3);
    expect(labels.filter((l) => l === 1)).toHaveLength(3);
    // The three closest to centroid 0 keep it; the drifters are the ones moved.
    expect(labels.slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('never moves a pinned sample', () => {
    const centroids = [lab(50, 60, 40), lab(50, -60, 40)];
    const samples = [lab(50, 61, 40), lab(50, 59, 40), lab(50, -59, 40), lab(50, -58, 40)];
    // Pin a sample that clearly belongs to cluster 0 onto cluster 1 anyway.
    const labels = assignBalanced(samples, centroids, 2, new Map([[0, 1]]));
    expect(labels[0]).toBe(1);
    expect(labels.filter((l) => l === 0)).toHaveLength(2);
    expect(labels.filter((l) => l === 1)).toHaveLength(2);
  });

  it('refuses samples that cannot fill the quotas exactly', () => {
    const centroids = [lab(0, 0, 0), lab(50, 0, 0)];
    expect(() => assignBalanced([lab(0, 0, 0)], centroids, 3)).toThrow(/cannot fill/);
  });
});

// The Hungarian solver behind the palette naming and the exact decoder
// (color-notes.md item 3).
import { describe, expect, it } from 'vitest';
import { solveAssignment } from '../src/color';

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

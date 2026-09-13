import { describe, expect, it } from 'vitest';
import { randomScramble, scrambleState } from '../src/scramble';
import { validateState } from '../src/state';

describe('randomScramble', () => {
  it('makes 20 legal moves with no repeated face and no three on one axis, and a valid state', () => {
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 20; i++) {
      const alg = randomScramble(20, rnd);
      const moves = alg.split(' ');
      expect(moves.length).toBe(20);
      const axis: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };
      for (let k = 1; k < moves.length; k++) {
        expect(moves[k]![0]).not.toBe(moves[k - 1]![0]);
        if (k >= 2) expect(axis[moves[k]![0]!] === axis[moves[k - 1]![0]!] && axis[moves[k]![0]!] === axis[moves[k - 2]![0]!]).toBe(false);
      }
      const st = scrambleState(alg);
      expect(st).toHaveLength(54);
      expect(validateState(st).ok).toBe(true);
    }
  });
});

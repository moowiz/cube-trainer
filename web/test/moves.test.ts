// The facelet permutations behind the move reader, checked against cubejs.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { applyMove, applySeq, canonicalSeqs, invertMove, MOVES, parseAlg } from '../src/moves/moves';
import { SOLVED } from '../src/cube/state';

describe('moves', () => {
  it('every face turn agrees with cubejs on random states', () => {
    for (let n = 0; n < 6; n++) {
      const c = Cube.random();
      const s = c.asString();
      for (const m of MOVES) expect(applyMove(s, m), m).toBe(Cube.fromString(s).move(m).asString());
    }
  });

  it('inverse and double turns compose', () => {
    const s = Cube.random().asString();
    for (const m of MOVES) {
      expect(applySeq(s, [m, invertMove(m)])).toBe(s);
      if (!m.endsWith('2')) expect(applySeq(s, [m, m])).toBe(applyMove(s, `${m[0]}2` as never));
    }
    expect(applySeq(SOLVED, parseAlg("R U R' U'")).length).toBe(54);
    expect(applySeq(SOLVED, parseAlg("R U R' U' R U R' U' R U R' U' R U R' U' R U R' U' R U R' U'"))).toBe(SOLVED);
  });

  it('canonical sequences reach each state once per commuting class', () => {
    for (const [depth, count] of [[1, 18], [2, 243], [3, 3240]] as const) {
      const seqs = canonicalSeqs(depth);
      expect(seqs.length).toBe(count);
      const states = new Set(seqs.map((q) => applySeq(SOLVED, q)));
      expect(states.size).toBe(count);
    }
  });
});

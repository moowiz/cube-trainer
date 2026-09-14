// Last-layer model + case tables (web/src/ll/). Every fact asserted about
// cubejs here (state() normalisation quirks especially) was checked by
// actually running it, not guessed - see the comment on the y/R test.
import { describe, expect, it } from 'vitest';
import { CASES, OCLL_CASES, PLL_CASES } from '../src/ll/cases';
import {
  SOLVED, aufToSolve, done, identify, inverse, moveCount, randomSetup, solution, state, tokens, whiteDown,
} from '../src/ll/model';
import { stageOf } from '../src/stage';

const AUFS = ['', 'U', "U'", 'U2'];

// Same LCG as the throwaway sketch this file replaces, so runs are reproducible.
function makeRng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x80000000; };
}

describe('OCLL and PLL algs are legal last-layer algs', () => {
  for (const c of OCLL_CASES) {
    it(`OCLL ${c.name}: applied to a solved cube keeps F2L intact and edges oriented`, () => {
      const r = stageOf(state(c.alg));
      expect([c.id, r.pairs, r.eoBad]).toEqual([c.id, 4, 0]);
    });
  }

  for (const c of PLL_CASES) {
    it(`PLL ${c.name}: applied to a solved cube keeps F2L and edge orientation, leaves corners oriented, and isn't a no-op`, () => {
      const after = state(c.alg);
      const r = stageOf(after);
      expect([c.id, r.pairs, r.eoBad, r.ocll]).toEqual([c.id, 4, 0, true]);
      expect([c.id, after]).not.toEqual([c.id, SOLVED]);
    });
  }
});

describe('the case tables are internally distinct', () => {
  it('all 7 OCLL cases identify themselves and no two collide', () => {
    const ids = OCLL_CASES.map((c) => identify('ocll', inverse(c.alg))?.id);
    expect(ids).toEqual(OCLL_CASES.map((c) => c.id));
    expect(new Set(ids).size).toBe(OCLL_CASES.length);
  });

  it('all 21 PLL cases identify themselves and no two collide', () => {
    const ids = PLL_CASES.map((c) => identify('pll', inverse(c.alg))?.id);
    expect(ids).toEqual(PLL_CASES.map((c) => c.id));
    expect(new Set(ids).size).toBe(PLL_CASES.length);
  });
});

describe('identify() is AUF-invariant', () => {
  for (const kind of ['ocll', 'pll'] as const) {
    it(`every ${kind.toUpperCase()} case identifies under any pre- and post-AUF`, () => {
      for (const c of CASES[kind]) {
        for (const pre of AUFS) {
          for (const post of AUFS) {
            const got = identify(kind, `${pre} ${inverse(c.alg)} ${post}`)?.id;
            expect([c.id, pre, post, got]).toEqual([c.id, pre, post, c.id]);
          }
        }
      }
    });
  }

  // OCLL cases are read off corner orientation alone, so a permutation
  // scramble before the case (a real PLL alg, minus whole-cube rotations so
  // it applies cleanly at any point) must not change what's identified.
  it('OCLL cases identify regardless of the last-layer permutation', () => {
    const rng = makeRng(7);
    const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
    const pureAlgs = PLL_CASES.filter((p) => !/[xyz]/.test(p.alg)).map((p) => p.alg);
    for (const c of OCLL_CASES) {
      for (let i = 0; i < 5; i++) {
        const alg = `${pick(pureAlgs)} ${pick(AUFS)} ${inverse(c.alg)} ${pick(AUFS)}`;
        expect([c.id, i, identify('ocll', alg)?.id]).toEqual([c.id, i, c.id]);
      }
    }
  });
});

describe('identify() refuses the wrong stage', () => {
  it('a lone quarter turn (F2L broken, not oriented) is not a PLL case', () => {
    expect(identify('pll', 'F')).toBeNull();
  });

  it('a broken F2L pair is not an OCLL case either', () => {
    expect(identify('ocll', "R U R' U'")).toBeNull();
  });

  it('corners not yet oriented (still mid-OCLL) is not a PLL case', () => {
    const sune = OCLL_CASES.find((c) => c.id === 'S')!.alg;
    expect(identify('pll', inverse(sune))).toBeNull();
  });
});

describe('solution() finds the tabled fix for random drills', () => {
  it('OCLL: names the drawn case and its alg finishes OCLL', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 30; i++) {
      const { setup, case: want } = randomSetup('ocll', rng);
      const sol = solution('ocll', setup);
      expect([setup, sol?.case.id]).toEqual([setup, want.id]);
      expect([setup, done('ocll', `${setup} ${sol!.pre} ${sol!.case.alg} ${sol!.post}`)]).toEqual([setup, true]);
    }
  });

  it('PLL: names the drawn case and its alg leaves the cube exactly solved', () => {
    const rng = makeRng(2);
    for (let i = 0; i < 30; i++) {
      const { setup, case: want } = randomSetup('pll', rng);
      const sol = solution('pll', setup);
      expect([setup, sol?.case.id]).toEqual([setup, want.id]);
      const finished = `${setup} ${sol!.pre} ${sol!.case.alg} ${sol!.post}`;
      expect([setup, done('pll', finished)]).toEqual([setup, true]);
      expect([setup, state(finished)]).toEqual([setup, SOLVED]);
    }
  });
});

describe('tokens()', () => {
  it('drops parentheses', () => {
    expect(tokens("(R U R')")).toEqual(['R', 'U', "R'"]);
  });

  it('lowers wide moves: Rw to r, keeping any modifier', () => {
    expect(tokens('Rw')).toEqual(['r']);
    expect(tokens('Rw2')).toEqual(['r2']);
    expect(tokens("Rw'")).toEqual(["r'"]);
  });

  it('keeps slice moves and whole-cube rotations exactly as written', () => {
    expect(tokens('M2')).toEqual(['M2']);
    expect(tokens("x'")).toEqual(["x'"]);
  });

  it('throws on a letter that names no move', () => {
    expect(() => tokens('Q')).toThrow();
  });

  it("throws on a double modifier that isn't a real move (U2')", () => {
    expect(() => tokens("U2'")).toThrow();
  });

  it("throws on a wide double modifier either (Rw2')", () => {
    expect(() => tokens("Rw2'")).toThrow();
  });
});

describe('inverse()', () => {
  it("inverts R U R' U' to U R U' R'", () => {
    expect(inverse("R U R' U'")).toBe("U R U' R'");
  });

  it('is an involution: inverting twice returns the same tokens', () => {
    const alg = "R U R' U' M x y";
    expect(tokens(inverse(inverse(alg)))).toEqual(tokens(alg));
  });

  // Covers a half turn (self-inverse), a slice move, a wide move, a whole-cube
  // rotation, and a y mid-alg (V perm) - alg followed by its inverse must
  // always cancel back to solved.
  const cancelling = [
    "R U R' U'",
    'M2 U M2 U2 M2 U M2',
    "r U R' U' r' F R F'",
    "x R' U R' D2 R U' R' D2 R2 x'",
    "R' U R' U' y R' F' R2 U' R' U R' F R F",
  ];
  for (const alg of cancelling) {
    it(`alg followed by its inverse cancels to solved: ${alg}`, () => {
      expect(state(`${alg} ${inverse(alg)}`)).toBe(SOLVED);
    });
  }
});

describe('state() normalisation', () => {
  it('a whole-cube rotation alone still reads as solved (relabelled by centre)', () => {
    expect(state('y')).toBe(SOLVED);
    expect(state('x')).toBe(SOLVED);
    expect(state("z'")).toBe(SOLVED);
  });

  // Verified by running it, not guessed: state('y R') equals neither state('F')
  // nor state('B') - the centre-relabelling after `y` doesn't line up with a
  // bare F or B turn from solved. What does hold, checked the same way: it's
  // still just one face turn away from solved, landing at the eo stage with
  // three of four cross edges, two F2L pairs, and no corners oriented yet -
  // the same shape a lone quarter turn produces elsewhere in this suite.
  it('y then R is one face turn away from solved, read from the eo stage', () => {
    const r = stageOf(state('y R'));
    expect(r).toEqual({ stage: 'eo', eoBad: 0, cross: 3, pairs: 2, ocll: false });
  });
});

describe('whiteDown()', () => {
  it('stays true after a y rotation, a U turn, or a pair-breaking trigger', () => {
    expect(whiteDown('y')).toBe(true);
    expect(whiteDown('U')).toBe(true);
    expect(whiteDown("R U R' U'")).toBe(true);
  });

  it('goes false once the cube is tipped onto its side', () => {
    expect(whiteDown('x')).toBe(false);
    expect(whiteDown("z'")).toBe(false);
  });
});

describe('aufToSolve()', () => {
  it('is empty for an already-solved cube', () => {
    expect(aufToSolve('')).toBe('');
  });

  it('names the U turn that finishes a bare AUF offset', () => {
    expect(aufToSolve('U')).toBe("U'");
    expect(aufToSolve('U2')).toBe('U2');
  });

  it('is null when no AUF alone would solve it', () => {
    expect(aufToSolve('R')).toBeNull();
  });
});

describe('moveCount()', () => {
  it('counts face and slice turns but not whole-cube rotations (Aa perm, written with x/x\')', () => {
    expect(moveCount("x R' U R' D2 R U' R' D2 R2 x'")).toBe(9);
  });

  it('counts slice moves even though they touch no single face (H perm, all M)', () => {
    expect(moveCount('M2 U M2 U2 M2 U M2')).toBe(7);
  });
});

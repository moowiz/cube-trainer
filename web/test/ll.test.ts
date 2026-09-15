// Last-layer model + case tables (web/src/ll/). Every fact asserted about
// cubejs here (state() normalisation quirks especially) was checked by
// actually running it, not guessed - see the comment on the y/R test.
import { describe, expect, it } from 'vitest';
import { CASES, OCLL_CASES, PLL_CASES } from '../src/ll/cases';
import { features } from '../src/ll/features';
import { algHtml, chainSummary } from '../src/ll/reference';
import {
  SOLVED, aufToSolve, chainPartner, done, identify, inverse, moveCount, pllArrows, randomSetup, scrambleFor, solution, state, tokens,
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

  it('PLL: the drawn case comes up from every side (a random AUF before the inverse alg)', () => {
    const rng = makeRng(3);
    const t = PLL_CASES.find((c) => c.id === 'T')!;
    const seen = new Set<string>();
    for (let i = 0; i < 400 && seen.size < 4; i++) {
      const { setup, case: c } = randomSetup('pll', rng);
      if (c.id !== t.id) continue;
      // which side the permutation faces: the state modulo the AUF after the setup
      for (const pre of ['', 'U', "U'", 'U2']) for (const post of ['', 'U', "U'", 'U2']) if (state(`${setup} ${post}`) === state(`${pre} ${inverse(t.alg)}`)) seen.add(pre);
    }
    expect([...seen].sort()).toEqual(['', 'U', "U'", 'U2']);
  });
});

describe('scrambleFor(): a face-turn scramble for a PLL drill', () => {
  it('reaches the same state as the setup with face turns only, 15 moves at most', () => {
    const rng = makeRng(4);
    for (const c of PLL_CASES) {
      for (const pre of ['', 'U2']) {
        const setup = `${pre} ${inverse(c.alg)}`;
        const scr = scrambleFor(setup, rng)!;
        expect([c.id, scr]).toEqual([c.id, expect.stringMatching(/^([URFDLB][2']? ?)+$/)]);
        expect([c.id, state(scr)]).toEqual([c.id, state(setup)]);
        expect([c.id, moveCount(scr) <= 15]).toEqual([c.id, true]);
      }
    }
  });

  it('is null off G1: an OCLL drill has twisted corners', () => {
    expect(scrambleFor(inverse(OCLL_CASES[0]!.alg))).toBeNull();
    expect(scrambleFor('')).toBe('');
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

});

describe('state() undoes rotations', () => {
  it('reads the same cube whichever way it was turned: x, z and y rotations vanish', () => {
    expect(state('x')).toBe(SOLVED);
    expect(state("z'")).toBe(SOLVED);
    expect(state('y')).toBe(SOLVED);
    // a turn made after tipping the cube is the same physical turn: x then R is the trainer's R
    expect(state('x R')).toBe(state('R'));
    expect(state('y R')).toBe(state('B'));
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

describe('pllArrows()', () => {
  it('draws one arrow per moved piece, the same count in every AUF, none when solved', () => {
    expect(pllArrows(state(''))).toEqual([]);
    for (const c of PLL_CASES) {
      const counts = ['', 'U', "U'", 'U2'].map((auf) => pllArrows(state(`${inverse(c.alg)} ${auf}`))!.length);
      expect(new Set(counts).size, c.name).toBe(1);
      expect(counts[0]!, c.name).toBeGreaterThanOrEqual(3);
      expect(counts[0]!, c.name).toBeLessThanOrEqual(8);
    }
    // a 2-cycle is two arrows (drawn as one double-headed); T moves four pieces, Ua three, H four, E four
    const n = (name: string) => pllArrows(state(inverse(PLL_CASES.find((c) => c.name === name)!.alg)))!.length;
    expect([n('T'), n('Ua'), n('H'), n('E')]).toEqual([4, 3, 4, 4]);
  });
  it('is null when the corners are not oriented', () => {
    expect(pllArrows(state("R U R' U R U2 R'"))).toBeNull();
  });
});

describe('chainPartner(): the case an alg leaves on a solved cube', () => {
  const chains = (kind: 'ocll' | 'pll') => CASES[kind].map((c) => `${c.id}>${chainPartner(kind, c)?.id ?? '-'}`).join(' ');
  it('PLL: A, U and G perms pair up, the rest are their own inverse', () => {
    expect(chains('pll')).toBe('Aa>Ab Ab>Aa E>E F>F Ga>Gb Gb>Ga Gc>Gd Gd>Gc H>H Ja>Ja Jb>Jb Na>Na Nb>Nb Ra>Ra Rb>Rb T>T Ua>Ub Ub>Ua V>V Y>Y Z>Z');
    const { self, pairs, oneWay } = chainSummary('pll');
    expect([pairs.map(([a, b]) => `${a.id}-${b.id}`), oneWay.length, self.length]).toEqual([['Aa-Ab', 'Ga-Gb', 'Gc-Gd', 'Ua-Ub'], 0, 13]);
  });
  it('OCLL: Sune and Anti-Sune pair up, T and L too; the headlights alg permutes, so it chains one way to L', () => {
    expect(chains('ocll')).toBe('S>AS AS>S H>H Pi>Pi U>L T>L L>T');
    const { self, pairs, oneWay } = chainSummary('ocll');
    expect([pairs.map(([a, b]) => `${a.id}-${b.id}`), oneWay.map(([a, b]) => `${a.id}-${b.id}`), self.map((c) => c.id)]).toEqual([['S-AS', 'T-L'], ['U-L'], ['H', 'Pi']]);
  });
});

describe('algHtml(): the alg with its triggers labelled', () => {
  it('brackets sexy and sledge in the Y perm and leaves the rest as text', () => {
    expect(algHtml("F R U R' U' R' F R F'")).toBe(`F <span class="ll-trig">R U R' U'<i>sexy</i></span> <span class="ll-trig">R' F R F'<i>sledge</i></span>`);
  });
});

describe('features(): what a PLL case looks like, the same in every AUF', () => {
  const line = (id: string) => { const f = features(state(inverse(PLL_CASES.find((c) => c.id === id)!.alg)))!; return `${f.corners} / ${f.edges} / ${f.sides.bar3}${f.sides.headlights}${f.sides.bar2}${f.sides.none}`; };
  it('reads the cycle types and the side patterns (bar of three, headlights, bar of two, nothing)', () => {
    expect(line('T')).toBe('adjacent swap / opposite swap / 0121');
    expect(line('H')).toBe('solved / two swaps / 0400');
    expect(line('Ua')).toBe('solved / 3-cycle / 1300');
    expect(line('Aa')).toBe('3-cycle / solved / 0121');
    expect(line('E')).toBe('two swaps / solved / 0004');
    expect(line('Na')).toBe('diagonal swap / opposite swap / 0040');
    expect(line('Y')).toBe('diagonal swap / adjacent swap / 0022');
    expect(line('Ga')).toBe('adjacent swap / 3-cycle / 0112');
    expect(line('Ja')).toBe('adjacent swap / adjacent swap / 1030');
  });
  it('is the same whichever way the layer is turned, and null off PLL', () => {
    const t = PLL_CASES.find((c) => c.id === 'T')!.alg;
    for (const auf of ['U', "U'", 'U2']) expect(features(state(`${auf} ${inverse(t)} ${auf}`))).toEqual(features(state(inverse(t))));
    expect(features(state(inverse(OCLL_CASES[0]!.alg)))).toBeNull();
  });
});

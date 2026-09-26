// Last-layer model + case tables (web/src/ll/). Every fact asserted about
// cubejs here (state() normalisation quirks especially) was checked by
// actually running it, not guessed - see the comment on the y/R test.
import { describe, expect, it } from 'vitest';
import { CASES, type LLCase, OCLL_CASES, PLL_CASES, isFavourite, setMainAlg, standardAlg } from '../src/ll/cases';
import { algAngle, features } from '../src/ll/features';
import { algHtml, chainSummary } from '../src/ll/reference';
import {
  SOLVED, aufToSolve, chainPartner, done, fitAlg, identify, inverse, moveCount, pllArrows, randomSetup, reached, route, scrambleFor, trimAuf, solution, splitAt, state, stepPlain, tokens, drawCase } from '../src/ll/model';
import { faceTurns } from '../src/cube/state';
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
  // 2026-09-25: a Performance trace of the page frozen 45 s at load put it all in the phase-2 search the two-phase
  // solver runs at each phase-1 leaf (scrambleFor -> solveAny -> search1 -> searchG1), which had no cap at all; the
  // constrained G1 searches (faces dropped, the slice rule, a length) had none either. Both are capped now, and past
  // the cap a looser search stands in, so the scramble still reaches the state.
  it('the phase-2 tails give up inside their budget and the scramble still reaches the state', async () => {
    const { lastSearchStats } = await import('../src/ll/scramble');
    // off G1 with the faces restricted (the PLL drill rebasing a long setup): the tails have no answer under
    // U D R2 L2 and walked 15M nodes uncapped (784 ms on a desktop; the traced freeze was this path, longer)
    let seed = 504;
    const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const setup = "U2 L' U' L2 F L' U' L' U L F' L' U L U2 R U R' U R U' R' U R U2 R' U L2 U' L U' L' U2 L2 U'";
    const t0 = performance.now();
    const scr = scrambleFor(setup, lcg, { faces: 'UDRL' });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(lastSearchStats().gaveUp).toBeGreaterThan(0);
    expect(state(scr)).toBe(state(setup));
    // U and D alone never solve an H perm: the search runs out of depths, and the looser one stands in
    const h = inverse(PLL_CASES.find((c) => c.id === 'H')!.alg);
    const scrH = scrambleFor(h, makeRng(7), { faces: 'UD', slices: 'paired' });
    expect(state(scrH)).toBe(state(h));
  });

  it('a full scramble under the PLL options (an F2L link shared to the drill) runs into the cap, not for ever', async () => {
    const { lastSearchStats } = await import('../src/ll/scramble');
    // the link of 2026-09-25: phase 2 restricted to U D R2 L2 on a state far from G1 walked 716M nodes (17 s)
    const scr = "U2 L D2 U2 B2 F2 D' U L' D R' L' U2 R2 D' R2 U R2 F2 D2 B2";
    const t0 = performance.now();
    const s = scrambleFor(scr, makeRng(3), { longer: [1, 2], slices: 'paired', faces: 'UDRL', noLeadingU: true });
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(state(s)).toBe(state(scr));
    expect(lastSearchStats().phase2).toBeLessThan(10_000_000); // the capped search plus the looser one that stood in
  });

  it('every drill setup (an AUF each side of the case) answers in well under a second', () => {
    const rng = makeRng(7);
    const opts = { longer: [1, 2] as [number, number], slices: 'paired' as const, faces: 'UDRL', noLeadingU: true };
    let worst = 0;
    for (const c of PLL_CASES) for (const a of ['', 'U', 'U2', "U'"]) for (const b of ['', 'U', 'U2', "U'"]) {
      const setup = `${a} ${inverse(c.alg)} ${b}`.trim();
      const t0 = performance.now();
      const scr = scrambleFor(setup, rng, opts);
      worst = Math.max(worst, performance.now() - t0);
      expect([c.id, a, b, state(scr)]).toEqual([c.id, a, b, state(setup)]);
    }
    expect(worst).toBeLessThan(1500);
  });

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

  it('the PLL drill\'s options: U D R2 L2 only, M2 pairs even and never the whole answer, one or two past the shortest, never ending in an AUF, several scrambles per state', async () => {
    const { PLL_SCRAMBLE } = await import('../src/ll/model');
    const rng = makeRng(21);
    const opts = { ...PLL_SCRAMBLE, faces: 'UDRL', noLeadingU: true }; // the trainer drops the faces shown as F and B
    // every state once: reachable with the four faces, in range, no trailing AUF
    for (const c of PLL_CASES) for (const auf of ['', 'U', 'U2', "U'"]) {
      const setup = `${inverse(c.alg)} ${auf}`;
      const shortest = tokens(scrambleFor(setup, rng, { faces: 'UDRL', noLeadingU: true, slices: 'paired' })).length;
      const scr = scrambleFor(setup, rng, opts);
      const toks = tokens(scr);
      expect([c.id, auf, toks.length >= shortest + 1 && toks.length <= shortest + 2]).toEqual([c.id, auf, true]);
      expect(toks.every((m) => /^(U|D|R2|L2)/.test(m) && !/^[RL]'?$/.test(m))).toBe(true);
      expect(toks[toks.length - 1]!.startsWith('U')).toBe(false);
      // R2 L2 pairs (an M2 each) in an even number, and never a scramble of U, D and M2 alone: the H perm's scramble was the H perm
      const pairs = (scr.match(/(?:R2 L2|L2 R2)/g) ?? []).length;
      expect([scr, pairs % 2]).toEqual([scr, 0]);
      if (pairs) expect(scr.replace(/R2 L2|L2 R2/g, '').trim()).toMatch(/[RL]2/);
      expect(state(scr)).toBe(state(setup));
    }
    // the states with the fewest answers (measured 2026-09-24: Ja and Jb at 12-13 moves, Ga and Rb): eight draws never
    // come back with one or two scrambles
    for (const [id, auf] of [['Ja', ''], ['Jb', ''], ['Ja', "U'"], ['Ga', 'U'], ['Rb', ''], ['Ua', 'U2']] as const) {
      const setup = `${inverse(PLL_CASES.find((c) => c.id === id)!.alg)} ${auf}`;
      const seen = new Set<string>();
      for (let k = 0; k < 8; k++) seen.add(scrambleFor(setup, rng, opts));
      expect([id, auf, seen.size >= 3]).toEqual([id, auf, true]);
    }
  });
  it('an exact length that no answer has falls back to the shortest', async () => {
    const t = PLL_CASES.find((c) => c.id === 'T')!;
    const scr = scrambleFor(inverse(t.alg), makeRng(4), { faces: 'UDRLF', length: 3 });
    expect(state(scr)).toBe(state(inverse(t.alg)));
    expect(tokens(scr).length).toBeGreaterThan(3);
  });
  it('off G1 (a twist alone) the shortest scramble is the alg backwards, as it must be; solved is empty', () => {
    const sune = OCLL_CASES.find((c) => c.id === 'S')!;
    const scr = scrambleFor(inverse(sune.alg), () => 0.5);
    expect(state(scr)).toBe(state(inverse(sune.alg)));
    expect(moveCount(scr)).toBe(7);
    expect(scrambleFor('')).toBe('');
  });

  it("trimAuf(): the trailing top-layer turns come off (the case's AUF), and the setup moved by their inverse is the same case", () => {
    expect(trimAuf("R U R' U2")).toEqual({ scramble: "R U R'", auf: 'U2' });
    expect(trimAuf("R U R' U U'")).toEqual({ scramble: "R U R'", auf: "U U'" });
    expect(trimAuf("U R U R'")).toEqual({ scramble: "U R U R'", auf: '' });
    expect(trimAuf('U2')).toEqual({ scramble: '', auf: 'U2' });
    const rng = makeRng(6);
    for (const c of PLL_CASES) {
      const setup = `U ${inverse(c.alg)}`;
      const t = trimAuf(scrambleFor(setup, rng));
      const moved = `${setup} ${inverse(t.auf)}`;
      expect([c.id, state(t.scramble)]).toEqual([c.id, state(moved)]);
      expect([c.id, identify('pll', moved)?.id]).toEqual([c.id, c.id]);
    }
  });
});

describe('an earlier start: the drill after the step before it', () => {
  it('a PLL drill from OCLL: the corners twisted, the PLL drawn comes up after the standard OCLL from its angle', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 30; i++) {
      const { setup, case: want } = randomSetup('pll', rng, 'ocll');
      expect([setup, reached('pll', setup)]).toEqual([setup, false]);
      expect([setup, reached('ocll', setup)]).toEqual([setup, true]);
      const r = route('pll', setup)!;
      expect([setup, r.map((s) => s.stage)]).toEqual([setup, ['ocll', 'pll']]);
      const moves = r.map(stepPlain).join(' ');
      expect([setup, done('pll', `${setup} ${moves}`)]).toEqual([setup, true]);
      // the split: the OCLL step's moves reach the PLL, and the case there is the route's
      const sp = splitAt('pll', setup, tokens(moves))!;
      expect([setup, sp.k]).toEqual([setup, tokens(stepPlain(r[0]!)).length]);
      expect([setup, sp.case]).toEqual([setup, identify('pll', `${setup} ${stepPlain(r[0]!)}`)]);
      // the OCLL alg from the angle it was set up at gives back the case drawn (a symmetric OCLL may not)
      const back = identify('pll', `${setup} ${inverse(setup.split(' ').slice(-1)[0] ?? '')}`);
      if (['H', 'Pi'].includes(r[0]!.name.split(' ')[0]!)) continue;
      expect([setup, (sp.case as { id: string }).id === want.id || back?.id === want.id]).toEqual([setup, true]);
    }
  });

  it('a PLL drill from the last pair: three pairs in, the route inserts it, orients, permutes', () => {
    const rng = makeRng(6);
    for (let i = 0; i < 30; i++) {
      const { setup } = randomSetup('pll', rng, 'pair');
      const rep = stageOf(state(setup));
      expect([setup, rep.eoBad, rep.cross, rep.pairs]).toEqual([setup, 0, 4, 3]);
      const r = route('pll', setup)!;
      expect([setup, r.map((s) => s.stage)]).toEqual([setup, ['pair', 'ocll', 'pll']]);
      expect([setup, done('pll', `${setup} ${r.map(stepPlain).join(' ')}`)]).toEqual([setup, true]);
    }
  });

  it('an OCLL drill from the last pair, and its route', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20; i++) {
      const { setup } = randomSetup('ocll', rng, 'pair');
      expect([setup, stageOf(state(setup)).pairs]).toEqual([setup, 3]);
      const r = route('ocll', setup)!;
      expect([setup, r.map((s) => s.stage)]).toEqual([setup, ['pair', 'ocll']]);
      expect([setup, done('ocll', `${setup} ${r.map(stepPlain).join(' ')}`)]).toEqual([setup, true]);
    }
  });

  it('the scramble for an earlier start is face turns for the whole state, shorter than the setup and not the algs backwards', () => {
    const rng = makeRng(8);
    for (let i = 0; i < 12; i++) {
      const { setup, case: c } = randomSetup('pll', rng, i % 2 ? 'ocll' : 'pair');
      const scr = scrambleFor(setup, rng);
      expect([setup, scr]).toEqual([setup, expect.stringMatching(/^([URFDLB][2']? ?)*$/)]);
      expect([setup, state(scr)]).toEqual([setup, state(setup)]);
      expect([setup, moveCount(scr) <= 19]).toEqual([setup, true]);
      // the tail of the setup (the OCLL alg backwards) is not the tail of the scramble
      expect([setup, scr.endsWith(inverse(c.alg))]).toEqual([setup, false]);
    }
  });

  it('an OCLL drill: a permutation under every twist, and its scramble mixes the two', () => {
    const rng = makeRng(9);
    for (let i = 0; i < 12; i++) {
      const { setup, case: c } = randomSetup('ocll', rng);
      const scr = scrambleFor(setup, rng);
      expect([setup, state(scr)]).toEqual([setup, state(setup)]);
      expect([setup, moveCount(scr) <= 18]).toEqual([setup, true]);
      expect([setup, scr.includes(inverse(c.alg))]).toEqual([setup, false]);
    }
  });

  it('splitAt(): a skip when the moves land on the stage solved, null when they never reach it', () => {
    const t = PLL_CASES.find((c) => c.id === 'T')!, s = OCLL_CASES.find((c) => c.id === 'S')!;
    expect(splitAt('pll', inverse(t.alg), tokens(t.alg))).toEqual({ k: 0, case: t });
    expect(splitAt('pll', inverse(s.alg), tokens(s.alg))).toEqual({ k: 7, case: 'skip' });
    expect(splitAt('pll', inverse(s.alg), tokens('R U'))).toBeNull();
  });

  it('route(): one step at the drill\'s own stage, null off the tabled path (a cube at EO)', () => {
    expect(route('ocll', "R U R' U R U2 R'")!.map((s) => [s.stage, s.name])).toEqual([['ocll', 'Anti-Sune']]);
    expect(route('pll', 'F')).toBeNull();
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

describe('faceTurns(): an alg as face turns only, the same cube', () => {
  const ALGS = [
    "r U R' U' r' F R F'", "F' r U R' U' r' F R", 'M2 U M U2 M\' U M2', "M' U M2 U M2 U M' U2 M2", "x R' U R' D2 R U' R' D2 R2 x'",
    "R' U R' U' y R' F' R2 U' R' U R' F R F", "R U R' U R U2 R'", 'u R d\' E S2 z F b', "y R U R' y' L", "R R' U2 U", "r' U r",
  ];
  it('matches state() and reads as face turns', () => {
    for (const a of ALGS) {
      const f = faceTurns(a);
      expect([a, f]).toEqual([a, expect.stringMatching(/^([URFDLB][2']?( |$))*$/)]);
      expect([a, state(f)]).toEqual([a, state(a)]);
    }
  });
  it('the moves after a wide move or slice are relabelled through its rotation', () => {
    expect(faceTurns('r U')).toBe('L F');
    expect(faceTurns("M' U")).toBe("L R' F");
    expect(faceTurns("R R'")).toBe('');
  });
});

describe('algAngle(): where to hold a PLL for its alg', () => {
  it('names the one bar of three or the one side of headlights where the alg has it, and says when any side works', () => {
    const by = Object.fromEntries(PLL_CASES.map((c) => [c.id, algAngle(c)]));
    expect(by.Ra).toBe('the headlights on your left');   // the recognition hint faces the headlights; the alg does not
    expect(by.Rb).toBe('the headlights facing you');
    expect(by.Ja).toBe('the bar of three on your right');
    expect(by.Ua).toBe('the bar of three at the back');
    expect(by.V).toBe('the bars of two at the back and on your left');
    expect(by.H).toBe('from any side');
    expect(by.Na).toBe('from any side');
    expect(by.Z).toMatch(/^the side facing you reads \w+, \w+, \w+ left to right \(or the opposite side\)$/);
  });
  it('the side it names shows that pattern at the alg\'s angle, for every case', () => {
    const strips: Record<string, number[]> = { 'facing you': [18, 19, 20], 'on your right': [9, 10, 11], 'at the back': [45, 46, 47], 'on your left': [36, 37, 38] };
    for (const c of PLL_CASES) {
      const a = algAngle(c), f = state(inverse(c.alg));
      const m = /^the (bar of three|headlights) (facing you|on your right|at the back|on your left)/.exec(a);
      if (!m) continue;
      const [l, mid, r] = strips[m[2]!]!.map((i) => f[i]);
      expect([c.id, m[1] === 'bar of three' ? l === mid && mid === r : l === r && l !== mid]).toEqual([c.id, true]);
    }
  });
});

describe('the J perms: the 2x2 block sits where the hint says, at the alg\'s angle', () => {
  // the bar of three is on the right (Ja) / left (Jb); the block is the corner at one of its ends whose
  // sticker on the NEXT side matches that side's edge. Facing the right side the back is on your right;
  // facing the left side the back is on your left.
  const block = (f: string, side: 'right' | 'left') => {
    if (side === 'right') { const bar = f[9] === f[10] && f[10] === f[11]; const backEnd = f[45] === f[46]; const frontEnd = f[19] === f[20]; return bar && backEnd && !frontEnd ? 'right end' : bar && frontEnd && !backEnd ? 'left end' : 'no block'; }
    const bar = f[36] === f[37] && f[37] === f[38]; const backEnd = f[46] === f[47]; const frontEnd = f[18] === f[19];
    return bar && backEnd && !frontEnd ? 'left end' : bar && frontEnd && !backEnd ? 'right end' : 'no block';
  };
  it('Ja: bar of three on the right, the block at its right end (the back)', () => {
    const c = PLL_CASES.find((x) => x.id === 'Ja')!;
    expect(block(state(inverse(c.alg)), 'right')).toBe('right end');
    expect(c.hint).toContain('block at its right end');
  });
  it('Jb: bar of three on the left, the block at its left end (the back)', () => {
    const c = PLL_CASES.find((x) => x.id === 'Jb')!;
    expect(block(state(inverse(c.alg)), 'left')).toBe('left end');
    expect(c.hint).toContain('block at its left end');
  });
});

describe('the alternative algs solve their case', () => {
  it('every alt is the same case as the standard alg (up to AUF) and solves it from the case, F2L kept', () => {
    let n = 0;
    for (const c of PLL_CASES) for (const a of c.alts ?? []) {
      n++;
      expect([c.id, a.alg, identify('pll', inverse(a.alg))?.id]).toEqual([c.id, a.alg, c.id]);
      const fit = fitAlg('pll', inverse(c.alg), a.alg);
      expect([c.id, a.alg, fit !== null]).toEqual([c.id, a.alg, true]);
      expect([c.id, a.alg, state(`${inverse(c.alg)} ${fit!.pre} ${a.alg} ${fit!.post}`)]).toEqual([c.id, a.alg, SOLVED]);
    }
    expect(n).toBeGreaterThan(20);
    for (const c of OCLL_CASES) expect([c.id, c.alts]).toEqual([c.id, undefined]); // the H and T ids are shared: alts are PLL's
  });
});

describe('every PLL hint tells its case from the other twenty, from the sides alone, in every AUF', () => {
  // the four sides in clockwise order seen from above (front, right, back, left), each read left to right
  // as you face it; facing side k, the side to your right is k+1, the far side k+2, the one to your left k+3
  const SEEN = [[18, 19, 20], [9, 10, 11], [45, 46, 47], [36, 37, 38]];
  type Side = { l: string; m: string; r: string; pat: 'bar3' | 'headlights' | 'bar2L' | 'bar2R' | 'none' };
  const sidesOf = (f: string): Side[] => SEEN.map(([a, b, c]) => {
    const l = f[a!]!, m = f[b!]!, r = f[c!]!;
    return { l, m, r, pat: l === m && m === r ? 'bar3' : l === r ? 'headlights' : l === m ? 'bar2L' : m === r ? 'bar2R' : 'none' };
  });
  const count = (s: Side[], p: Side['pat'] | 'bar2') => s.filter((x) => (p === 'bar2' ? x.pat === 'bar2L' || x.pat === 'bar2R' : x.pat === p)).length;
  const at = (s: Side[], k: number) => s[((k % 4) + 4) % 4]!;
  const only = (s: Side[], p: Side['pat']) => (count(s, p) === 1 ? s.findIndex((x) => x.pat === p) : -1);
  // relative to the side faced: the side to the right has its near end on the left as seen (bar2L), far end bar2R;
  // the side to the left has its near end on the right (bar2R); the far side's end "toward your right" is bar2L
  const HL = (s: Side[]) => only(s, 'headlights');
  const hlBar = (s: Side[], where: 'right' | 'far' | 'left', end: 'near' | 'far' | 'towardRight' | 'towardLeft') => {
    const k = HL(s); if (k < 0 || count(s, 'bar2') !== 1 || count(s, 'none') !== 2) return false;
    const side = at(s, k + { right: 1, far: 2, left: 3 }[where]);
    const want = where === 'right' ? (end === 'near' ? 'bar2L' : 'bar2R') : where === 'left' ? (end === 'near' ? 'bar2R' : 'bar2L') : end === 'towardRight' ? 'bar2L' : 'bar2R';
    return side.pat === want;
  };
  const PRED: Record<string, (s: Side[]) => boolean> = {
    // headlights, a 2x2 block at the far right / far left (the block: a bar on the side to the right at its far end AND the far side's bar toward the right)
    Aa: (s) => { const k = HL(s); return k >= 0 && count(s, 'bar2') === 2 && at(s, k + 1).pat === 'bar2R' && at(s, k + 2).pat === 'bar2L'; },
    Ab: (s) => { const k = HL(s); return k >= 0 && count(s, 'bar2') === 2 && at(s, k + 3).pat === 'bar2L' && at(s, k + 2).pat === 'bar2R'; },
    E: (s) => count(s, 'none') === 4,
    F: (s) => count(s, 'bar3') === 1 && count(s, 'none') === 3,
    Ga: (s) => hlBar(s, 'right', 'far'),
    Gb: (s) => hlBar(s, 'far', 'towardLeft'),
    Gc: (s) => hlBar(s, 'left', 'far'),
    Gd: (s) => hlBar(s, 'far', 'towardRight'),
    Ra: (s) => hlBar(s, 'right', 'near'),
    Rb: (s) => hlBar(s, 'left', 'near'),
    H: (s) => count(s, 'headlights') === 4 && s.every((x, i) => x.m === at(s, i + 2).l),
    Z: (s) => count(s, 'headlights') === 4 && s.every((x, i) => x.m === at(s, i + 1).l || x.m === at(s, i + 3).l),
    // a bar of three with the block at its right end: the side to the right has a bar at its near end (and it matches the bar's corner)
    Ja: (s) => { const k = only(s, 'bar3'); return k >= 0 && count(s, 'bar2') === 3 && at(s, k + 1).pat === 'bar2L'; },
    Jb: (s) => { const k = only(s, 'bar3'); return k >= 0 && count(s, 'bar2') === 3 && at(s, k + 3).pat === 'bar2R'; },
    Na: (s) => s.every((x) => x.pat === 'bar2R'),
    Nb: (s) => s.every((x) => x.pat === 'bar2L'),
    T: (s) => { const k = HL(s); return k >= 0 && count(s, 'bar2') === 2 && at(s, k + 1).pat === 'bar2L' && at(s, k + 3).pat === 'bar2R' && at(s, k + 2).pat === 'none'; },
    // a bar of three, headlights elsewhere: facing the bar, the edge on your left (k+3) belongs on your right (k+1): its colour is that side's headlights
    Ua: (s) => { const k = only(s, 'bar3'); return k >= 0 && count(s, 'headlights') === 3 && at(s, k + 3).m === at(s, k + 1).l; },
    Ub: (s) => { const k = only(s, 'bar3'); return k >= 0 && count(s, 'headlights') === 3 && at(s, k + 1).m === at(s, k + 3).l; },
    // two bars meeting at a corner: a side with its bar at the right end, the next side with its bar at the left end
    V: (s) => count(s, 'bar2') === 2 && count(s, 'none') === 2 && s.some((x, i) => x.pat === 'bar2R' && at(s, i + 1).pat === 'bar2L'),
    Y: (s) => count(s, 'bar2') === 2 && count(s, 'none') === 2 && s.some((x, i) => x.pat === 'bar2L' && at(s, i + 1).pat === 'bar2R'),
  };
  it('each predicate holds for its case in all four AUFs and for no other case', () => {
    const states = PLL_CASES.map((c) => ({ c, f: AUFS.map((u) => state(`${inverse(c.alg)} ${u}`)) }));
    for (const { c, f } of states) {
      const pred = PRED[c.id]!;
      expect([c.id, f.map((x) => pred(sidesOf(x)))]).toEqual([c.id, [true, true, true, true]]);
      for (const other of states) if (other.c.id !== c.id) expect([c.id, other.c.id, other.f.map((x) => pred(sidesOf(x)))]).toEqual([c.id, other.c.id, [false, false, false, false]]);
    }
  });
  it('the first sentence names the telling feature (the words the predicate encodes)', () => {
    const first = (h: string) => h.split(/(?<=[a-z)])\. /)[0]!;
    const WORDS: Record<string, RegExp> = {
      Aa: /block .*far right/, Ab: /block .*far left/, E: /no headlights and no bars/, F: /one bar of three and nothing else/,
      Ga: /right at its far end/, Gb: /far side toward your left/, Gc: /left at its far end/, Gd: /far side toward your right/,
      H: /all four sides, every edge the opposite/, Z: /all four sides, every edge a neighbouring/,
      Ja: /block at its right end/, Jb: /block at its left end/, Na: /every side, at the right end/, Nb: /every side, at the left end/,
      Ra: /right at the end nearest you/, Rb: /left at the end nearest you/, T: /bar of two on each side next to them, both at the end touching/,
      Ua: /counter-clockwise/, Ub: /cycling clockwise/, V: /meeting at one corner/, Y: /do not share a corner/,
    };
    for (const c of PLL_CASES) expect([c.id, first(c.hint)]).toEqual([c.id, expect.stringMatching(WORDS[c.id]!)]);
  });
});

describe('heardCase(): what the speech recogniser wrote, as a PLL id', () => {
  it('reads letters as said, spelled or run together, skips "perm" and an article, and hears a surrender', async () => {
    const { heardCase } = await import('../src/ll/hear');
    const ids = PLL_CASES.map((c) => c.id);
    for (const [said, want] of [
      ['G a perm', 'Ga'], ['gee alpha', 'Ga'], ['G. B.', 'Gb'], ['ga', 'Ga'], ['G see perm', 'Gc'], ['golf delta', 'Gd'],
      ['T', 'T'], ['tea perm', 'T'], ['a T perm', 'T'], ['the Y perm', 'Y'], ['you be', 'Ub'], ['are a', 'Ra'], ['N A perm', 'Na'], ['zed', 'Z'],
      ['give up', 'giveup'], ["I don't know", 'giveup'], ['skip it', 'giveup'], ['banana', null], ['G', 'G'],
      ['epsilon', 'E'], ['epsilon perm', 'E'], ['gamma beta', 'Gb'], ['theta', 'T'], ['nu alpha', 'Na'], ['rho bravo', 'Rb'], ['eta perm', 'H'], ['zeta', 'Z'], ['upsilon a', 'Ua'],
    ] as const) expect([said, heardCase(said, ids)]).toEqual([said, want]);
  });
  it('wordsFor(): every PLL letter and a/b/c/d has at least a NATO or Greek word, and each word means only that letter', async () => {
    const { wordsFor, heardCase } = await import('../src/ll/hear');
    const ids = PLL_CASES.map((c) => c.id);
    for (const l of [...new Set(PLL_CASES.map((c) => c.id[0]!)), 'A', 'B', 'C', 'D']) {
      expect([l, wordsFor(l).length > 0]).toEqual([l, true]);
      for (const w of wordsFor(l)) if (ids.includes(l)) expect([w, heardCase(w, ids)]).toEqual([w, l]);
    }
  });
});

describe('practice stats: what to work on', () => {
  it('counts, times and ranks the cases; the unpractised and the misnamed come first', async () => {
    const { caseStats, workOn } = await import('../src/ll/practice');
    const t = PLL_CASES.find((c) => c.id === 'T')!, y = PLL_CASES.find((c) => c.id === 'Y')!, h = PLL_CASES.find((c) => c.id === 'H')!;
    const at = (caseId: string, time: number, extra: Partial<import('../src/store/types').AttemptRecord> = {}): import('../src/store/types').AttemptRecord =>
      ({ id: `${caseId}${time}`, puzzle: '333', stage: 'pll', when: time, scramble: '', moves: '', time, assisted: false, source: 'cube', editedAt: 0, caseId, ...extra });
    const attempts = [
      ...[3000, 2500, 2000, 1800].map((ms) => at(t.name, ms, { recognition: 500, execution: ms - 500, quiz: 'right' })),
      ...[4000, 4200, 3900].map((ms) => at(y.name, ms, { quiz: 'wrong' })),
      at(h.name, 1500),
    ];
    const stats = caseStats(attempts, [t, y, h]);
    const T = stats.find((s) => s.id === 'T')!, Y = stats.find((s) => s.id === 'Y')!, H = stats.find((s) => s.id === 'H')!;
    expect([T.n, T.best, T.recent, T.recognition, T.execution, T.quizRight, T.quizAsked]).toEqual([4, 1800, 2325, 500, 1825, 4, 4]);
    expect([Y.n, Y.best, Y.quizRight, Y.quizAsked, Y.recognition]).toEqual([3, 3900, 0, 3, null]);
    expect([H.n, H.recent]).toEqual([1, 1500]);
    // H has too few attempts to judge, Y is slow and misnamed, T is fine
    expect(workOn(stats).map((s) => s.id)).toEqual(['H', 'Y', 'T']);
  });
  it('the trend is the last eight against the eight before', async () => {
    const { caseStats, RECENT, trendText } = await import('../src/ll/practice');
    const t = PLL_CASES.find((c) => c.id === 'T')!, y = PLL_CASES.find((c) => c.id === 'Y')!;
    const at = (caseId: string, when: number, time: number | null): import('../src/store/types').AttemptRecord =>
      ({ id: `${caseId}${when}`, puzzle: '333', stage: 'pll', when, scramble: '', moves: '', time, assisted: false, source: 'cube', editedAt: 0, caseId });
    // T: twelve tries, 3.0 s down to 1.9 s; the last eight average 2.25, the four before them 2.85
    const tt = Array.from({ length: 12 }, (_, i) => at(t.name, 1000 + i, 3000 - i * 100));
    const yy = [at(y.name, 5, 4000), at(y.name, 6, null), at(y.name, 7, 3500)];
    const stats = caseStats([...yy, ...tt], [t, y]);
    const T = stats.find((s) => s.id === 'T')!, Y = stats.find((s) => s.id === 'Y')!;
    expect(T.trend).toBeCloseTo(2250 - 2850, 6);
    expect(Y.trend).toBeNull(); // nothing before the recent ones
    expect(trendText(T.trend)).toBe('−0.6s'); expect(trendText(300)).toBe('+0.3s'); expect(trendText(20)).toBe('±0'); expect(trendText(null)).toBe('–');
    expect(RECENT).toBe(8);
  });
  it('sorts by any column, blanks at the bottom either way, and \'work\' is the worst-first order', async () => {
    const { caseStats, sortStats, workOn, DEFAULT_DIR } = await import('../src/ll/practice');
    const [t, y, h, ua] = ['T', 'Y', 'H', 'Ua'].map((id) => PLL_CASES.find((c) => c.id === id)!) as [LLCase, LLCase, LLCase, LLCase];
    const at = (caseId: string, when: number, time: number | null, extra: Partial<import('../src/store/types').AttemptRecord> = {}): import('../src/store/types').AttemptRecord =>
      ({ id: `${caseId}${when}`, puzzle: '333', stage: 'pll', when, scramble: '', moves: '', time, assisted: false, source: 'cube', editedAt: 0, caseId, ...extra });
    const attempts = [
      ...[1, 2, 3, 4].map((i) => at(t.name, i, 2000 + i * 10, { quiz: 'right' })),
      ...[5, 6, 7].map((i) => at(y.name, i, 4000, { quiz: i === 5 ? 'wrong' : 'right' })),
      at(h.name, 8, null),
    ];
    const stats = caseStats(attempts, [t, y, h, ua]);
    const ids = (xs: { id: string }[]) => xs.map((s) => s.id);
    expect(ids(sortStats(stats, 'work', 'asc'))).toEqual(ids(workOn(stats)));
    expect(ids(sortStats(stats, 'work', 'desc'))).toEqual(ids(workOn(stats)).reverse());
    expect(ids(sortStats(stats, 'name', 'asc'))).toEqual(['T', 'Y', 'H', 'Ua']);
    expect(ids(sortStats(stats, 'n', 'desc'))).toEqual(['T', 'Y', 'H', 'Ua']);
    expect(ids(sortStats(stats, 'n', 'asc'))).toEqual(['Ua', 'H', 'Y', 'T']);
    // H and Ua have no time: last, whichever way the timed ones go
    expect(ids(sortStats(stats, 'recent', 'desc'))).toEqual(['Y', 'T', 'H', 'Ua']);
    expect(ids(sortStats(stats, 'recent', 'asc'))).toEqual(['T', 'Y', 'H', 'Ua']);
    expect(ids(sortStats(stats, 'best', 'asc'))).toEqual(['T', 'Y', 'H', 'Ua']);
    // the quiz share: Y named 2 of 3, T 4 of 4; the unasked at the bottom
    expect(ids(sortStats(stats, 'quiz', 'asc'))).toEqual(['Y', 'T', 'H', 'Ua']);
    expect(ids(sortStats(stats, 'last', 'desc'))).toEqual(['H', 'Y', 'T', 'Ua']);
    expect(DEFAULT_DIR.recent).toBe('desc'); expect(DEFAULT_DIR.quiz).toBe('asc');
  });
});

describe('a favourite alg: any of a case\'s algs as its main', () => {
  it('swaps the alt in, keeps the case identifiable, routes with it, and the standard alg comes back', () => {
    const ja = PLL_CASES.find((c) => c.id === 'Ja')!;
    const std = ja.alg, alt = ja.alts![0]!.alg;
    expect(standardAlg('pll', 'Ja')).toBe(std);
    expect(setMainAlg('pll', 'Ja', "R U R' U'")).toBe(false); // not one of its algs
    expect(setMainAlg('pll', 'Ja', alt)).toBe(true);
    expect([ja.alg, isFavourite('pll', 'Ja')]).toEqual([alt, true]);
    expect(ja.alts![0]).toEqual({ alg: std, note: 'the standard alg' });
    expect(ja.alts!.some((a) => a.alg === alt)).toBe(false);
    // the case is still found from every angle, and the route solves it with the favourite
    for (const pre of ['', 'U', 'U2', "U'"]) {
      const setup = `${pre} ${inverse(std)}`;
      expect(identify('pll', setup)?.id).toBe('Ja');
      const sol = solution('pll', setup)!;
      expect(sol.case.alg).toBe(alt);
      expect(state(`${setup} ${sol.pre} ${sol.case.alg} ${sol.post}`)).toBe(SOLVED);
    }
    expect(setMainAlg('pll', 'Ja', null)).toBe(true);
    expect([ja.alg, isFavourite('pll', 'Ja'), ja.alts![0]!.alg]).toEqual([std, false, alt]);
  });
});

describe('drawCase(): the next case to drill', () => {
  it('evens the counts out over a few rounds, and repeats are rare', () => {
    const rng = makeRng(11);
    const pool = PLL_CASES.filter((c) => ['Ja', 'Jb', 'T'].includes(c.id));
    const seen: Record<string, number> = {};
    let last: string | null = null;
    const order: string[] = [];
    for (let i = 0; i < 300; i++) {
      const c = drawCase(pool, seen, last, rng);
      seen[c.id] = (seen[c.id] ?? 0) + 1;
      last = c.id;
      order.push(c.id);
    }
    // 300 draws of three cases: each near a hundred
    for (const c of pool) expect([c.id, seen[c.id]! >= 90 && seen[c.id]! <= 110]).toEqual([c.id, true]);
    // a repeat is allowed but uncommon (a plain draw would give a third of them), and three running rarer still
    const twice = order.filter((id, i) => i >= 1 && id === order[i - 1]).length;
    expect(twice).toBeGreaterThan(0);
    expect(twice).toBeLessThan(order.length / 8);
    expect(order.filter((id, i) => i >= 2 && id === order[i - 1] && id === order[i - 2]).length).toBeLessThan(order.length / 25);
  });

  it('a pool of one keeps drawing it; an unseen case is likelier than a much-seen one', () => {
    const one = PLL_CASES.filter((c) => c.id === 'T');
    expect(drawCase(one, { T: 5 }, 'T', () => 0.5).id).toBe('T'); // the only case, so it repeats at full weight
    const two = PLL_CASES.filter((c) => ['Ja', 'Jb'].includes(c.id));
    // Ja seen three times, Jb never: Jb holds 4/5 of the weight
    const picks = Array.from({ length: 100 }, (_, i) => drawCase(two, { Ja: 3 }, null, () => i / 100).id);
    const jb = picks.filter((id) => id === 'Jb').length;
    expect(jb).toBeGreaterThan(70);
    expect(jb).toBeLessThan(90);
  });
});

describe('the practice graph: a line per case', () => {
  const at = (caseId: string, when: number, time: number | null): import('../src/store/types').AttemptRecord =>
    ({ id: `${caseId}${when}`, puzzle: '333', stage: 'pll', when, scramble: '', moves: '', time, assisted: false, source: 'cube', editedAt: 0, caseId });
  it('runs each case\'s ao5 (ao3 first) at its own tries, indexed over every timed try of the stage', async () => {
    const { caseLines, colourOf } = await import('../src/ll/practicegraph');
    const [t, y, h] = ['T', 'Y', 'H'].map((id) => PLL_CASES.find((c) => c.id === id)!) as [LLCase, LLCase, LLCase];
    // T and Y interleaved, newest first in the input; an untimed Y in the middle; H never tried
    const attempts = [
      at(t.name, 1, 3000), at(y.name, 2, 5000), at(t.name, 3, 2000), at(y.name, 4, null), at(t.name, 5, 1000), at(y.name, 6, 4000),
      at(t.name, 7, 2500), at(t.name, 8, 1500), at(t.name, 9, 9000), at(y.name, 10, 3000),
    ].reverse();
    const { lines, whens } = caseLines(attempts, [t, y, h]);
    expect(whens).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    const T = lines[0]!, Y = lines[1]!, H = lines[2]!;
    expect([T.name, T.colour, Y.colour]).toEqual(['T', colourOf(0), colourOf(1)]);
    expect(T.points.map((p) => p.i)).toEqual([0, 2, 3, 5, 6, 7]);
    // under three: nothing; three: the median; four: the middle two; five: ao5 drops the best and the worst; six: the last five
    expect(T.points.map((p) => p.v)).toEqual([null, null, 2000, 2250, 2000, 2000]);
    expect(Y.points.map((p) => [p.i, p.v])).toEqual([[1, null], [4, null], [8, 4000]]);
    expect(H.points).toEqual([]);
  });
  it('lays the drawn lines out inside the plot, only the cases asked for, labels apart, a tick per day', async () => {
    const { caseLines, layoutCaseGraph, caseGraphSvg } = await import('../src/ll/practicegraph');
    const [t, y] = ['T', 'Y'].map((id) => PLL_CASES.find((c) => c.id === id)!) as [LLCase, LLCase];
    const day = 864e5;
    const attempts = Array.from({ length: 20 }, (_, i) => at(i % 2 ? y.name : t.name, i * day, 3000 - i * 50));
    const { lines, whens } = caseLines(attempts, [t, y]);
    const days = whens.map((w) => String(Math.round(w / day)));
    const g = layoutCaseGraph(lines, whens.length, { width: 400, height: 280, shown: ['T', 'Y'], days });
    expect(g.lines.map((l) => l.id)).toEqual(['T', 'Y']);
    for (const l of g.lines) for (const d of l.dots) { expect(d.x).toBeGreaterThanOrEqual(g.x0); expect(d.x).toBeLessThanOrEqual(g.x1); expect(d.y).toBeGreaterThanOrEqual(g.y0); expect(d.y).toBeLessThanOrEqual(g.y1); }
    expect(g.lines[0]!.dots).toHaveLength(8); // ten tries, a value from the third
    expect(g.endLabels[1]!.y - g.endLabels[0]!.y).toBeGreaterThanOrEqual(13);
    expect(g.xTicks.length).toBeGreaterThan(2);
    const one = layoutCaseGraph(lines, whens.length, { width: 400, height: 280, shown: ['Y'], days });
    expect(one.lines.map((l) => l.id)).toEqual(['Y']);
    const svg = caseGraphSvg(g);
    expect(svg).toContain('data-id="T"'); expect(svg).toContain('>Y</text>');
  });
});

describe('sliceForm(): a scramble as done in hand, an R2 L2 pair as one M2', () => {
  it('merges the pairs, relabels the turns while the cube is upside down, and leaves an odd count alone', async () => {
    const { sliceForm } = await import('../src/ll/model');
    // U D L2 R2 U F2 R2 L2 D: after the first M2 the core's U is your D and its F your B, back after the second
    expect(sliceForm(tokens("U D' L2 R2 U F2 R2 L2 D2"))).toEqual({ toks: ['U', "D'", 'M2', 'D', 'B2', 'M2', 'D2'], spans: [1, 1, 2, 1, 1, 2, 1] });
    expect(sliceForm(tokens('R2 L2 U'))).toEqual({ toks: ['R2', 'L2', 'U'], spans: [1, 1, 1] }); // one pair: it would end upside down
    expect(sliceForm(tokens('R2 U L2'))).toEqual({ toks: ['R2', 'U', 'L2'], spans: [1, 1, 1] }); // not adjacent: not a pair
    expect(sliceForm([])).toEqual({ toks: [], spans: [] });
  });
});

describe('nextInCycle(): every case once before any comes again', () => {
  it('runs the pool through in a shuffled order, reshuffles when done or when the pool changes, and never repeats across the join', async () => {
    const { nextInCycle } = await import('../src/ll/model');
    const rng = makeRng(3);
    const pool = PLL_CASES.filter((c) => ['Ja', 'Jb', 'T', 'Y', 'H'].includes(c.id));
    let cycle: import('../src/ll/model').Cycle | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { const r = nextInCycle(pool, cycle, rng); expect([i, r.fresh]).toEqual([i, i === 0]); expect(r.cycle.at).toBe(i + 1); cycle = r.cycle; seen.push(r.case.id); }
    expect([...seen].sort()).toEqual(['H', 'Ja', 'Jb', 'T', 'Y']);
    // the sixth draw starts over, not on the case just seen
    const again = nextInCycle(pool, cycle, rng);
    expect([again.fresh, again.cycle.at]).toEqual([true, 1]);
    expect(again.case.id).not.toBe(seen[4]);
    // a changed pool starts a fresh cycle at once
    const smaller = pool.slice(0, 2);
    const r = nextInCycle(smaller, again.cycle, rng);
    expect([r.fresh, r.cycle.ids.length, r.cycle.at]).toEqual([true, 2, 1]);
    // a pool of one just repeats it
    const one = nextInCycle(pool.slice(0, 1), undefined, rng);
    expect(nextInCycle(pool.slice(0, 1), one.cycle, rng).case.id).toBe(one.case.id);
  });
});

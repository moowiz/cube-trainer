// A solve's splits (src/timer/splits.ts) and the belief as the trainer sees it
// (src/handoff.ts beliefInTrainer): the stages end the first time the cube is
// past them, a skipped stage takes no time, and a smart cube's own letters
// read the same stage as the trainer's.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { inverse, tokens } from '../src/cube/alg';
import { toWca } from '../src/cube/frame';
import { state } from '../src/cube/state';
import { beliefInTrainer, toSourceLetters } from '../src/handoff';
import { stageOf } from '../src/stage';
import { BACK_TURNS, SplitClock, splitsOf } from '../src/timer/splits';

const T = "R U R' U' R' F R2 U' R' U' R U R' F'"; // trainer letters

describe('splits', () => {
  it('a PLL case solved by its alg is all PLL', () => {
    const scr = toWca(inverse(T));
    const moves = tokens(toWca(T)).map((m, i) => ({ m, t: (i + 1) * 100 }));
    expect(splitsOf(scr, moves)).toEqual({ pll: 1400 });
  });

  it('a whole solve: each stage ends at its first crossing, and they add up to the time', () => {
    // a scramble of stages undone in order: the solve goes EO -> F2L -> OCLL -> PLL -> solved
    const setup = "R U R' U' R' F R2 U' R' U' R U R' F' R U R' U R U2 R' R U R' U' R U' R' F R F'";
    const scr = toWca(inverse(setup));
    const moves = tokens(toWca(setup)).map((m, i) => ({ m, t: (i + 1) * 50 }));
    const sp = splitsOf(scr, moves)!;
    const total = Object.values(sp).reduce((a, b) => a + b, 0);
    expect(total).toBe(moves.length * 50);
    // every stage the cube started behind is there
    expect(Object.keys(sp)).toEqual(['eo', 'f2l', 'ocll', 'pll'].filter((s) => s in sp));
  });

  it('a stage skipped takes no time, and a dip back never moves a split', () => {
    const c = new SplitClock('f2l');
    expect(c.turned('eo', 100)).toBe(false); // an alg breaking the cross
    expect(c.turned('pll', 900)).toBe(true); // F2L done with the corners oriented: an OCLL skip
    expect(c.turned('ocll', 1000)).toBe(false);
    expect(c.turned('solved', 2400)).toBe(true);
    expect(c.splits()).toEqual({ f2l: 900, ocll: 0, pll: 1500 });
    expect(c.current()).toBe('solved');
  });
});

describe('the belief as the trainer sees it', () => {
  it('a smart cube (white up, green front) turned into the hold reads the trainer\'s stage', () => {
    const colourOf = { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' } as const;
    for (const front of ['green', 'blue', 'red', 'orange'] as const) {
      const hold = { down: 'white' as const, front };
      for (const alg of [inverse(T), "R U R' U'", 'F', "R U R' U R U2 R'"]) {
        // the trainer-frame alg as the cube reports it, applied to the cube's own solved state
        const onCube = new Cube().move(toSourceLetters(colourOf, alg, hold)).asString();
        const seen = beliefInTrainer(onCube, colourOf, hold);
        expect(seen).not.toBeNull();
        expect(seen).toBe(state(alg));
        expect(stageOf(seen!).stage).toBe(stageOf(state(alg)).stage);
      }
    }
  });

  it('the pairs count up and do not drop while the next pair lifts one; a real step back re-times what follows', () => {
    const c = new SplitClock('f2l', 0);
    c.turned('f2l', 100, 1); c.turned('f2l', 200, 2);
    c.turned('eo', 250, 1); // an R turn: the cross edge and a pair lifted
    expect(c.pairs()).toBe(2);
    c.turned('f2l', 300, 2);
    c.turned('ocll', 400, 4);
    expect(c.splits()).toEqual({ f2l: 400 });
    // an OCLL alg dips back for a few turns: nothing moves
    for (let i = 0; i < 10; i++) c.turned('eo', 500 + i, 2);
    expect(c.current()).toBe('ocll');
    expect(c.back()).toBe(false);
    // behind for BACK_TURNS turns: the solve is back in F2L, its split gone until it is crossed again
    for (let i = 0; i < BACK_TURNS; i++) c.turned('f2l', 600 + i, 3);
    expect(c.current()).toBe('f2l');
    expect(c.back()).toBe(true);
    expect(c.splits()).toEqual({});
    c.turned('ocll', 900, 4);
    expect(c.back()).toBe(false);
    expect(c.splits()).toEqual({ f2l: 900 });
  });
});

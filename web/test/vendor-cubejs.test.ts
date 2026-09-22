// The vendored cubejs (src/vendor/cubejs) must behave exactly like the npm
// package it was copied from (src/vendor/cubejs/README.md): only the module
// wrapper was changed. Upstream stays a devDependency precisely so this
// comparison - and the oracle every other cube test leans on - is possible.
import Upstream from 'cubejs';
import { describe, expect, it } from 'vitest';
import Vendored from '../src/vendor/cubejs';
import { SOLVED } from '../src/cube/state';
import { makeLcg } from './helpers';

const FACES = 'URFDLB';
const SUFFIX = ['', "'", '2'];

/** A deterministic alg of `n` turns, including rotations and wide moves. */
function alg(rnd: () => number, n: number, exotic = false): string {
  const vocab = exotic ? [...FACES, ...'xyz', ...'urfdlb'] : [...FACES];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(vocab[Math.floor(rnd() * vocab.length)]! + SUFFIX[Math.floor(rnd() * 3)]!);
  return out.join(' ');
}

describe('the vendored cubejs against the npm package', () => {
  it('applies the same algs to the same facelets, rotations and wide moves included', () => {
    const rnd = makeLcg(20260922);
    for (let i = 0; i < 200; i++) {
      const a = alg(rnd, 12, i % 2 === 0);
      expect(new Vendored().move(a).asString()).toBe(new Upstream().move(a).asString());
    }
  });

  it('reads a facelet string into the same cubie state', () => {
    const rnd = makeLcg(7);
    for (let i = 0; i < 50; i++) {
      const f = new Upstream().move(alg(rnd, 15)).asString();
      const v = Vendored.fromString(f), u = Upstream.fromString(f);
      expect({ cp: [...v.cp], co: [...v.co], ep: [...v.ep], eo: [...v.eo] })
        .toEqual({ cp: [...u.cp], co: [...u.co], ep: [...u.ep], eo: [...u.eo] });
      expect(v.asString()).toBe(f);
      expect(v.isSolved()).toBe(u.isSolved());
    }
  });

  it('inverts algs identically, and a solved cube is solved in both', () => {
    const rnd = makeLcg(99);
    for (let i = 0; i < 50; i++) {
      const a = alg(rnd, 10);
      expect(Vendored.inverse(a)).toBe(Upstream.inverse(a));
    }
    expect(new Vendored().asString()).toBe(SOLVED);
    expect(new Vendored().isSolved()).toBe(true);
  });

  // The solver is the half most worth pinning: it is 955 lines of tables and
  // the app's scan lock and Solve-tab scrambles both run through it.
  it('solves the same states to the same solutions', { timeout: 120_000 }, () => {
    Vendored.initSolver();
    Upstream.initSolver();
    const rnd = makeLcg(4242);
    for (let i = 0; i < 6; i++) {
      const f = new Upstream().move(alg(rnd, 18)).asString();
      const sol = Vendored.fromString(f).solve();
      expect(sol).toBe(Upstream.fromString(f).solve());
      // and it is a real solution, not just the same string twice
      expect(Vendored.fromString(f).move(sol).asString()).toBe(SOLVED);
    }
  });

  it('generates a legal random state (its own RNG, so only legality is comparable)', () => {
    for (let i = 0; i < 20; i++) {
      const r = Vendored.random();
      expect(r.asString()).toHaveLength(54);
      expect(Upstream.fromString(r.asString()).isSolved()).toBe(r.isSolved());
    }
  });
});

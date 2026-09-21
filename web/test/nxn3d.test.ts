// The pure half of the n×n alg player (algs/nxn3d.ts): nxnAnimatable's
// polys, checked against cube/nxn.ts's own model (rawNxN) rather than
// against nxn3d.ts's internals, so the test would catch a wrong axis sign
// or a wrong destination permutation on nxnOps, not just mirror it. No DOM
// here (mountPlayer is untested, same as fto3d.ts's mountFtoPlayer).
import { describe, expect, it } from 'vitest';
import { nxnAnimatable } from '../src/algs/nxn3d';
import type { Vec } from '../src/cube/fto';
import { nxnOps, rawNxN, solvedNxN } from '../src/cube/nxn';

/** {pts, fill} for one poly, points sorted within the quad and rounded, so set-equality survives relabelling and float noise. */
function polySig(p: { pts: readonly Vec[]; fill: string }): string {
  const pts = p.pts.map((v) => v.map((x) => (Math.round(x * 1e6) / 1e6).toFixed(6)).join(',')).sort();
  return `${pts.join('|')}#${p.fill}`;
}
const sceneSig = (polys: { pts: readonly Vec[]; fill: string }[]) => polys.map(polySig).sort();

// scrambled so fills are not all equal per face
const SETUP = "R U F' L2";

const NS = [2, 3, 4];
const cases: { n: number; token: string }[] = NS.flatMap((n) => {
  const toks = ['U', "R'", 'F2', 'Rw', 'x', "y'"];
  if (n >= 4) toks.push('2R');
  if (n === 3) toks.push('M');
  return toks.map((token) => ({ n, token }));
});

describe('nxnAnimatable: animation matches the model', () => {
  it.each(cases)('n=$n $token: k=1 equals the committed scene', ({ n, token }) => {
    const state = rawNxN(n, SETUP);
    const a = nxnAnimatable(n, token, state);
    const op = a.ops[0]!;
    const atK1 = a.polys({ state, rots: [], anim: { op, k: 1 } });
    const committed = a.polys({ state: a.apply(state, op), rots: [] });
    expect(sceneSig(atK1)).toEqual(sceneSig(committed));
  });
});

describe('nxnAnimatable: only the moving stickers move mid-turn', () => {
  it.each(cases)('n=$n $token: at k=0.5 exactly op.moving.length polys differ', ({ n, token }) => {
    const state = rawNxN(n, SETUP);
    const a = nxnAnimatable(n, token, state);
    const op = a.ops[0]!;
    const base = a.polys({ state, rots: [] });
    const mid = a.polys({ state, rots: [], anim: { op, k: 0.5 } });
    const byIdx = new Map(base.map((p) => [p.idx!, p]));
    let moved = 0;
    for (const p of mid) {
      const b = byIdx.get(p.idx!)!;
      const same = p.pts.every((pt, j) => pt.every((x, k) => Math.abs(x - b.pts[j]![k]!) < 1e-9));
      if (!same) moved++;
    }
    expect(moved).toBe(op.moving.length);
    expect(op.moving.length).toBeGreaterThan(0);
  });
});

describe('nxnOps: applied through the adapter reproduces rawNxN', () => {
  it("R U R' U' on a 3x3", () => {
    const n = 3;
    const alg = "R U R' U'";
    const a = nxnAnimatable(n, alg, solvedNxN(n));
    let state = a.start;
    for (const op of a.ops) state = a.apply(state, op);
    expect(state).toBe(rawNxN(n, alg));
  });
});

describe('nxnOps turns the short way', () => {
  it('no move animates more than a half turn: L, D, B, M, E, S and their primes are one quarter turn, not three', () => {
    for (const token of ['L', "L'", 'D', "D'", 'B', "B'", 'M', "M'", 'E', 'S', 'Lw', "Dw'", 'R', "R'", 'U2', "L2'"]) {
      const [op] = nxnOps(3, token);
      expect(Math.abs(op!.angle), token).toBeLessThanOrEqual(Math.PI + 1e-9);
      if (!/2/.test(token)) expect(Math.abs(op!.angle), token).toBeCloseTo(Math.PI / 2);
    }
    // and M turns the way L does, M' the way R does (about the shared axis)
    expect(nxnOps(3, 'M')[0]!.angle).toBeCloseTo(nxnOps(3, 'L')[0]!.angle);
    expect(nxnOps(3, "M'")[0]!.angle).toBeCloseTo(nxnOps(3, 'R')[0]!.angle);
  });
});

// The pure half of the FTO alg player (algs/fto3d.ts): ftoPolys, checked
// against cube/fto.ts's own model rather than against fto3d.ts's internals,
// so the test would catch a wrong composition order, not just mirror it.
// No DOM here (mountFtoPlayer is the untested wrapper); vitest's default
// environment for this repo is node (vite.config.ts).
import { describe, expect, it } from 'vitest';
import { ftoPolys, type FtoScene } from '../src/algs/fto3d';
import { applyFto, applyOp, FTO_HEX, FTO_STICKERS, ftoOps, ftoPoint, rotate, solvedFto, type FtoFrame, type Vec } from '../src/cube/fto';

/** {pts, fill} for one poly, points sorted within the triangle and rounded, so set-equality survives relabelling and float noise. */
function polySig(p: { pts: readonly Vec[]; fill: string }): string {
  const pts = p.pts.map((v) => v.map((x) => (Math.round(x * 1e6) / 1e6).toFixed(6)).join(',')).sort();
  return `${pts.join('|')}#${p.fill}`;
}
const sceneSig = (polys: { pts: readonly Vec[]; fill: string }[]) => polys.map(polySig).sort();

describe('ftoPolys: solved scene', () => {
  const polys = ftoPolys({ state: solvedFto(), rots: [] });
  it('has 72 triangles', () => expect(polys).toHaveLength(72));
  it('every poly has 3 points, a unit normal, and a fill from FTO_HEX', () => {
    const hexes = new Set(Object.values(FTO_HEX));
    for (const p of polys) {
      expect(p.pts).toHaveLength(3);
      expect(Math.hypot(...p.n)).toBeCloseTo(1, 9);
      expect(hexes.has(p.fill)).toBe(true);
    }
  });
});

describe('ftoPolys: animation matches the model', () => {
  // scrambled so fills are not all equal per face, across both alg notations (the state itself is frame-free)
  const state = applyFto("U R' F BL D2");
  const cases: { token: string; frame: FtoFrame }[] = [
    { token: 'U', frame: 'ben' },
    { token: "F'", frame: 'ben' },
    { token: 'BL2', frame: 'ben' },
    { token: 'Rw', frame: 'ben' },
    { token: 'Us', frame: 'ben' },
    { token: 'Uo', frame: 'ben' },
    { token: 'Rt', frame: 'eif' },
  ];
  it.each(cases)('$token ($frame): k=1 equals the committed scene', ({ token, frame }) => {
    const op = ftoOps(token, frame)[0]!;
    const atK1: FtoScene = { state, rots: [], anim: { op, k: 1 } };
    const committed: FtoScene = {
      state: applyOp(state, op),
      rots: op.sel === 'all' ? [{ axis: op.axis, angle: op.angle }] : [],
    };
    expect(sceneSig(ftoPolys(atK1))).toEqual(sceneSig(ftoPolys(committed)));
  });
});

describe('ftoPolys: only the moving stickers move mid-turn', () => {
  it('at k=0.5 of a face turn, exactly op.moving.length polys differ in position', () => {
    const state = applyFto("U R' F BL D2");
    const op = ftoOps('U', 'ben')[0]!;
    const base = ftoPolys({ state, rots: [] });
    const mid = ftoPolys({ state, rots: [], anim: { op, k: 0.5 } });
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

describe('ftoPolys: whole-puzzle rotations compose latest-first', () => {
  it('rots = [A, B] applies B then A, not A then B', () => {
    const A = { axis: [0, 0, 1] as Vec, angle: Math.PI / 2 };
    const B = { axis: [1, 0, 0] as Vec, angle: Math.PI / 3 };
    const scene: FtoScene = { state: solvedFto(), rots: [A, B] };
    const polys = ftoPolys(scene);

    // reproduce ftoPolys' own base geometry for sticker 0 (fto.ts's bary/c, moved 6% toward the centroid)
    const s = FTO_STICKERS[0]!;
    const raw = ftoPoint(s.face, s.bary[0]!);
    const p0: Vec = [raw[0] + (s.c[0] - raw[0]) * 0.06, raw[1] + (s.c[1] - raw[1]) * 0.06, raw[2] + (s.c[2] - raw[2]) * 0.06];

    const latestFirst = rotate(rotate(p0, B.axis, B.angle), A.axis, A.angle);
    const otherOrder = rotate(rotate(p0, A.axis, A.angle), B.axis, B.angle);
    const actual = polys.find((p) => p.idx === 0)!.pts[0]!;

    expect(Math.hypot(actual[0] - latestFirst[0], actual[1] - latestFirst[1], actual[2] - latestFirst[2])).toBeLessThan(1e-9);
    expect(Math.hypot(actual[0] - otherOrder[0], actual[1] - otherOrder[1], actual[2] - otherOrder[2])).toBeGreaterThan(1e-3);
  });
});

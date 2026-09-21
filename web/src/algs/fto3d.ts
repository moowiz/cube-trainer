// A 3D player for an FTO alg: the algs sheet's case pictures (pic.ts) are
// static, but an alg is a sequence of turns, and seeing which pieces a move
// carries matters more on the FTO than on the cube (the vertex rotations in
// particular are easy to get backwards from a diagram alone). ftoPolys is
// the pure half: a scene (state + whole-puzzle rotations done so far + an
// in-progress move) to the polygons render.ts paints, so the composition
// can be checked without a DOM. The play/step UI and animation loop live in
// player.ts, generalised for the n×n cubes too (nxn3d.ts); ftoAnimatable
// is this puzzle's adapter to that contract, and mountFtoPlayer is kept as
// a one-line wrapper so any caller that only knows the FTO keeps working.
//
// The animation trick: a sticker's screen position is always its fixed
// slot's geometry (STICKER_GEOM), rotated by the whole-puzzle turns done so
// far; its colour is state[slot], which only changes at the end of a move.
// So a forward move animates the moving slots' geometry toward the next
// slot while their colour stays put — at k=1 a slot's sticker has visually
// arrived where applyOp would put its colour, so the commit is seamless.
// Running a move backward relies on the same fact: cube/fto.ts's moving set
// is purely geometric (which slots the layer touches), the same set forward
// or inverted, so undoing first (state ← applyOp(state, inverseOp(op)),
// i.e. jumping straight to the pre-move picture) and then animating the
// ORIGINAL op's rotation from k=1 down to 0 draws exactly the reverse of
// the forward animation, ending on the already-updated state at k=0.

import { applyOp, FTO_FACES, FTO_HEX, FTO_NORMAL, FTO_STICKERS, ftoOps, ftoPoint, inverseOp, rotate, type FtoFrame, type FtoOp, type FtoState, type Vec } from '../cube/fto';
import type { Poly } from '../cube/render';
import { mountPlayer, type Animatable, type AnimOp } from './player';

export interface FtoScene {
  /** stickers in the START frame */
  state: FtoState;
  /** whole-puzzle rotations done so far, start-frame axes, in the order performed */
  rots: { axis: Vec; angle: number }[];
  /** the move in progress: fraction k (0..1) of op.angle applied */
  anim?: { op: FtoOp; k: number };
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** the gap between stickers: each corner is pulled 6% of the way toward the triangle's centroid */
const GAP = 0.06;

/** Each of the 72 slots' fixed corners and outward normal, computed once (state only ever changes which colour sits there). */
const STICKER_GEOM: readonly { idx: number; pts: readonly [Vec, Vec, Vec]; n: Vec }[] = FTO_STICKERS.map((s) => ({
  idx: s.idx,
  pts: s.bary.map((w) => lerp(ftoPoint(s.face, w), s.c, GAP)) as [Vec, Vec, Vec],
  n: FTO_NORMAL[s.face],
}));

/** The polygons of a scene: sticker geometry, spun by any move in progress, then turned by the whole-puzzle rotations done so far (latest first — see cube/fto.ts's toStart, which this mirrors). */
export function ftoPolys(scene: FtoScene): Poly[] {
  const spin = scene.anim && scene.anim.op.sel !== 'all' ? scene.anim : null;
  const moving = spin ? new Set(spin.op.moving) : null;
  const rots = scene.anim && scene.anim.op.sel === 'all' ? [...scene.rots, { axis: scene.anim.op.axis, angle: scene.anim.op.angle * scene.anim.k }] : scene.rots;
  return STICKER_GEOM.map((g) => {
    let pts: readonly Vec[] = g.pts;
    let n = g.n;
    if (moving?.has(g.idx)) {
      const t = spin!.op.angle * spin!.k;
      pts = pts.map((p) => rotate(p, spin!.op.axis, t));
      n = rotate(n, spin!.op.axis, t);
    }
    if (rots.length) {
      pts = pts.map((p) => rots.reduceRight((q, r) => rotate(q, r.axis, r.angle), p));
      n = rots.reduceRight((q, r) => rotate(q, r.axis, r.angle), n);
    }
    return { pts, n, fill: FTO_HEX[FTO_FACES[scene.state[g.idx]!]!], idx: g.idx };
  });
}

/** An AnimOp carrying the real FtoOp it came from, so apply/invert can hand it straight to cube/fto.ts. */
interface FtoAnimOp extends AnimOp {
  readonly fop: FtoOp;
}

/** The FTO as an Animatable for mountPlayer: `alg` in `frame`'s notation, starting from `start`. */
export function ftoAnimatable(alg: string, frame: FtoFrame, start: FtoState): Animatable<FtoState> {
  const ops: FtoAnimOp[] = ftoOps(alg, frame).map((fop) => ({ token: fop.token, axis: fop.axis, angle: fop.angle, rotation: fop.sel === 'all', moving: fop.moving, fop }));
  return {
    ops,
    start,
    apply: (state, op) => applyOp(state, (op as FtoAnimOp).fop),
    invert: (op) => {
      const o = op as FtoAnimOp;
      const fop = inverseOp(o.fop);
      return { token: o.token, axis: fop.axis, angle: fop.angle, rotation: o.rotation, moving: o.moving, fop };
    },
    // ftoPolys wants a real FtoOp in scene.anim.op (it reads .sel); unwrap the FtoAnimOp back to it.
    polys: (scene) => ftoPolys({
      state: scene.state,
      rots: scene.rots,
      anim: scene.anim ? { op: (scene.anim.op as FtoAnimOp).fop, k: scene.anim.k } : undefined,
    }),
    // DECISION: nearly straight at the front corner, as the sheet's pictures are, tilted just enough to read as a solid
    scale: 140,
    view: { rx: 8, ry: -10 },
  };
}

/** Mount a play/step viewer for `alg` (in `frame`'s notation) starting from `start`; returns a handle to tear it down. */
export function mountFtoPlayer(host: HTMLElement, opts: { alg: string; frame: FtoFrame; start: FtoState }): { destroy(): void } {
  return mountPlayer(host, ftoAnimatable(opts.alg, opts.frame, opts.start));
}

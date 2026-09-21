// The n×n adapter for the algs sheet's 3D player (player.ts): a state is
// the facelet string cube/nxn.ts uses. Each sticker's quad and normal are
// fixed by its position (stickerPos, cubie-centred: coordinate − (n−1)/2,
// the same convention geometry.ts uses for the 3x3 - so scale 78·3/n makes
// any n fill the view the way the 3x3 does at scale 78); its colour is
// state[idx] and only that changes at the end of a move, the same trick
// fto3d.ts's STICKER_GEOM uses.
//
// Unlike the FTO, a whole-puzzle rotation on the n×n model permutes
// stickers (there is no separate "frame" the later moves are read in - see
// cube/nxn.ts's applyNxN, which undoes rotations by composing them back
// in): nxnOps' `dest` already carries a rotation's full permutation just
// like any other turn, and its `moving` set is every sticker. So apply()
// below runs the same permutation for every op, rotation or not, and
// polys() never reads scene.rots - a rotation animates exactly like a face
// turn that happens to touch the whole cube.

import { rotate, type Vec } from '../cube/fto';
import { NORMAL } from '../cube/geometry';
import { invertTokens, nxnOps, stickerPos } from '../cube/nxn';
import { DEFAULT_VIEW, type Poly } from '../cube/render';
import { faceHex } from '../cube/scheme';
import type { Animatable, AnimOp } from './player';

/** An AnimOp carrying the destination permutation nxnOps computed for it, so apply/invert can use it directly. */
interface NxnOp extends AnimOp {
  readonly dest: number[];
}

function tangents(n: Vec): [Vec, Vec] {
  const a = n.findIndex((v) => v !== 0);
  return a === 0 ? [[0, 1, 0], [0, 0, 1]] : a === 1 ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
}
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

interface Geom { idx: number; pts: readonly [Vec, Vec, Vec, Vec]; n: Vec }

/** Each sticker's fixed quad and outward normal, computed once per n (state only ever changes which colour sits there). */
function stickerGeom(n: number): Geom[] {
  const mid = (n - 1) / 2;
  const total = 6 * n * n;
  return Array.from({ length: total }, (_, idx) => {
    const s = stickerPos(n, idx);
    const nrm = NORMAL[s.face];
    const centre = add([s.x - mid, s.y - mid, s.z - mid], nrm, 0.5);
    const [t1, t2] = tangents(nrm);
    const pts: [Vec, Vec, Vec, Vec] = [
      add(add(centre, t1, .45), t2, .45),
      add(add(centre, t1, -.45), t2, .45),
      add(add(centre, t1, -.45), t2, -.45),
      add(add(centre, t1, .45), t2, -.45),
    ];
    return { idx, pts, n: nrm };
  });
}

/** `Animatable<string>.polys` for a fixed `n`: the moving stickers' quads and normals rotate about the op in
 *  progress; everything else stays at its fixed geometry. scene.rots is unused - see the file comment. */
function nxnPolys(geom: readonly Geom[]) {
  return (scene: { state: string; rots: { axis: Vec; angle: number }[]; anim?: { op: AnimOp; k: number } }): Poly[] => {
    const spin = scene.anim ?? null;
    const moving = spin ? new Set(spin.op.moving) : null;
    return geom.map((g) => {
      let pts: readonly Vec[] = g.pts;
      let n = g.n;
      if (moving?.has(g.idx)) {
        const t = spin!.op.angle * spin!.k;
        pts = pts.map((p) => rotate(p, spin!.op.axis, t));
        n = rotate(n, spin!.op.axis, t);
      }
      return { pts, n, fill: faceHex(scene.state[g.idx]!), idx: g.idx };
    });
  };
}

/** An n×n adapter for mountPlayer: `alg` in cube/nxn.ts's notation, from `start` (the same state caseSvg draws). */
export function nxnAnimatable(n: number, alg: string, start: string): Animatable<string> {
  const ops = nxnOps(n, alg) as NxnOp[];

  const applyDest = (state: string, dest: readonly number[]): string => {
    const out = new Array<string>(state.length);
    for (let i = 0; i < state.length; i++) out[dest[i]!] = state[i]!;
    return out.join('');
  };
  const invertDest = (dest: readonly number[]): number[] => {
    const inv = new Array<number>(dest.length);
    for (let i = 0; i < dest.length; i++) inv[dest[i]!] = i;
    return inv;
  };

  return {
    ops,
    start,
    apply: (state, op) => applyDest(state, (op as NxnOp).dest),
    invert: (op) => {
      const o = op as NxnOp;
      return { token: invertTokens([o.token])[0]!, axis: o.axis, angle: -o.angle, rotation: o.rotation, moving: o.moving, dest: invertDest(o.dest) };
    },
    polys: nxnPolys(stickerGeom(n)),
    scale: (78 * 3) / n,
    view: DEFAULT_VIEW,
  };
}

// The face-turning octahedron (FTO) for the algs sheet: eight triangular
// faces of nine stickers, turned by rotating the stickers' 3D positions.
// Nothing here is a hand-typed cycle table: a move is an axis, an angle and
// a cut depth, the permutation it induces is found by rotating every
// sticker's centroid and matching it to the sticker that sits there, and
// test/fto.test.ts checks the result against cubing.js (Ben Streeter's
// notation, which twizzle uses) and against lowcubes' own FTO model (the
// edge-in-front notation its TCP algs are written in).
//
// The frame is Ben's hold: a corner points at you, the four corners around
// it point diagonally out. The four faces around the front corner are U
// (upper), F (lower), L and R; the back four are D (opposite U), B
// (opposite F), BL (opposite R) and BR (opposite L). A letter turns that
// face 120° clockwise looking at it. Whole-puzzle rotations do not move
// the stickers here: they turn the frame the later moves are read in, so
// the state an alg leaves is always in the frame the alg started in (the
// picture never comes out rotated, and a rotation-free spelling of the alg
// for twizzle falls out of the same bookkeeping).

export type FtoFace = 'U' | 'F' | 'L' | 'R' | 'D' | 'B' | 'BL' | 'BR';
export const FTO_FACES: readonly FtoFace[] = ['U', 'F', 'L', 'R', 'D', 'B', 'BL', 'BR'];
/** twizzle's colours, which is what "play it in 3D" shows */
export const FTO_HEX: Record<FtoFace, string> = { U: '#ffffff', F: '#44ee00', R: '#ff0000', D: '#f4f400', B: '#2266ff', L: '#8800dd', BL: '#ff8000', BR: '#888888' };

/** The alg's notation: Ben's (the sheet's default) or lowcubes' edge-in-front letters (see EIF_TO_BEN). */
export type FtoFrame = 'ben' | 'eif';

/** A state: for each of the 72 sticker positions, the index (into FTO_FACES) of the face whose colour sits there. */
export type FtoState = number[];

export type Vec = readonly [number, number, number];
const S2 = Math.SQRT1_2;
/** The six corners: front and back, and the four diagonals up-left, up-right, down-left, down-right. */
const CORNER: Record<string, Vec> = { N: [0, 0, 1], K: [0, 0, -1], ul: [-S2, S2, 0], ur: [S2, S2, 0], dl: [-S2, -S2, 0], dr: [S2, -S2, 0] };
/** Each face by its three corners (order fixed here so the sticker numbering is stable; winding is irrelevant). */
export const FTO_CORNERS: Record<FtoFace, readonly [string, string, string]> = {
  U: ['N', 'ul', 'ur'], F: ['N', 'dl', 'dr'], L: ['N', 'ul', 'dl'], R: ['N', 'ur', 'dr'],
  D: ['K', 'dl', 'dr'], B: ['K', 'ul', 'ur'], BL: ['K', 'ul', 'dl'], BR: ['K', 'ur', 'dr'],
};

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec): Vec => scale(a, 1 / Math.hypot(...a));
const near = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;

/** Rodrigues: rotation of `p` about the unit axis `k` by `t` radians (right-hand rule). */
export function rotate(p: Vec, k: Vec, t: number): Vec {
  const c = Math.cos(t), s = Math.sin(t), kd = dot(k, p);
  const cross: Vec = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]];
  return [p[0] * c + cross[0] * s + k[0] * kd * (1 - c), p[1] * c + cross[1] * s + k[1] * kd * (1 - c), p[2] * c + cross[2] * s + k[2] * kd * (1 - c)];
}

/** The outward unit normal of each face (the corners are unit vectors, so their sum points out through the face). */
export const FTO_NORMAL: Record<FtoFace, Vec> = Object.fromEntries(FTO_FACES.map((f) => [f, norm(FTO_CORNERS[f].map((c) => CORNER[c]!).reduce(add))])) as Record<FtoFace, Vec>;
/** Distance from the centre to a face plane (the inradius); the cuts sit at a third of it. */
const INRADIUS = dot(FTO_NORMAL.U, CORNER.N!);

export interface FtoSticker {
  idx: number;
  face: FtoFace;
  kind: 'corner' | 'edge' | 'centre';
  /** the sticker's three corners as barycentric weights over FTO_CORNERS[face] */
  bary: readonly [Vec, Vec, Vec];
  /** centroid in 3D */
  c: Vec;
}

// A face trisected along each side gives nine triangles: the three at the corners (corner pieces), the three
// pointing the same way in the middle of each side (edges) and the three inverted ones next to the corners
// (centres). Weights (k1,k2,k3) name them: an upright triangle is {a>k1/3, b>k2/3, c>k3/3} with k1+k2+k3 = 2,
// an inverted one is {a<k1/3, b<k2/3, c<k3/3} with k1+k2+k3 = 4.
const UP = (k: Vec): [Vec, Vec, Vec] => [[(k[0] + 1) / 3, k[1] / 3, k[2] / 3], [k[0] / 3, (k[1] + 1) / 3, k[2] / 3], [k[0] / 3, k[1] / 3, (k[2] + 1) / 3]];
const DOWN = (k: Vec): [Vec, Vec, Vec] => [[k[0] / 3, k[1] / 3, (k[2] - 1) / 3], [k[0] / 3, (k[1] - 1) / 3, k[2] / 3], [(k[0] - 1) / 3, k[1] / 3, k[2] / 3]];
const CELLS: { kind: FtoSticker['kind']; bary: [Vec, Vec, Vec] }[] = [
  { kind: 'corner', bary: UP([2, 0, 0]) }, { kind: 'corner', bary: UP([0, 2, 0]) }, { kind: 'corner', bary: UP([0, 0, 2]) },
  { kind: 'edge', bary: UP([1, 1, 0]) }, { kind: 'edge', bary: UP([0, 1, 1]) }, { kind: 'edge', bary: UP([1, 0, 1]) },
  { kind: 'centre', bary: DOWN([2, 1, 1]) }, { kind: 'centre', bary: DOWN([1, 2, 1]) }, { kind: 'centre', bary: DOWN([1, 1, 2]) },
];

/** A point of face `f` from barycentric weights over its corners. */
export function ftoPoint(f: FtoFace, w: Vec): Vec {
  const [a, b, c] = FTO_CORNERS[f].map((k) => CORNER[k]!) as [Vec, Vec, Vec];
  return add(add(scale(a, w[0]), scale(b, w[1])), scale(c, w[2]));
}

/** All 72 stickers, face by face in FTO_FACES order: corners at the three corners, edges, centres (see CELLS). */
export const FTO_STICKERS: readonly FtoSticker[] = FTO_FACES.flatMap((face, fi) =>
  CELLS.map((cell, k) => ({ idx: fi * 9 + k, face, kind: cell.kind, bary: cell.bary, c: scale(cell.bary.map((w) => ftoPoint(face, w)).reduce(add), 1 / 3) })),
);

export function solvedFto(): FtoState {
  return FTO_STICKERS.map((s) => FTO_FACES.indexOf(s.face));
}

export function pieceTypeFto(idx: number): FtoSticker['kind'] {
  return FTO_STICKERS[idx]!.kind;
}

/** The sticker positions face `f`'s turn moves (the face and the layer under it: 27 of them). */
export function layerFto(f: FtoFace): number[] {
  const n = FTO_NORMAL[f];
  return FTO_STICKERS.filter((s) => dot(s.c, n) > INRADIUS / 3).map((s) => s.idx);
}

// ---- moves ----

type Sel = 'face' | 'slice' | 'wide' | 'all';
interface Op { axis: Vec; angle: number; sel: Sel }

const THIRD = (2 * Math.PI) / 3;
const permCache = new Map<string, number[]>();

/** dest[i] = where the sticker at i goes, for the stickers `op` selects (others map to themselves). */
function permutation(op: Op): number[] {
  const key = `${op.axis.map((v) => v.toFixed(6)).join(',')}|${op.angle.toFixed(6)}|${op.sel}`;
  const hit = permCache.get(key);
  if (hit) return hit;
  const depth = (s: FtoSticker) => dot(s.c, op.axis);
  const picked = (s: FtoSticker) =>
    op.sel === 'all' ? true : op.sel === 'face' ? depth(s) > INRADIUS / 3 : op.sel === 'wide' ? depth(s) > -INRADIUS / 3 : Math.abs(depth(s)) < INRADIUS / 3;
  const dest = FTO_STICKERS.map((s) => s.idx);
  for (const s of FTO_STICKERS) {
    if (!picked(s)) continue;
    const moved = rotate(s.c, op.axis, op.angle);
    const to = FTO_STICKERS.find((t) => near(t.c, moved));
    if (!to) throw new Error(`FTO: no sticker where ${s.face}${s.idx % 9} lands`); // a bad axis or angle; cannot happen for the moves below
    dest[s.idx] = to.idx;
  }
  permCache.set(key, dest);
  return dest;
}

/** lowcubes' edge-in-front letters as Ben's: an edge faces you, U above it, F below, L and R beside F, D opposite U. */
const EIF_TO_BEN: Record<string, FtoFace> = { U: 'B', F: 'U', L: 'L', R: 'R', D: 'F', B: 'D', Bl: 'BL', Br: 'BR' };
// lowcubes' vertex rotations, each by the four faces at its corner and one face it carries onto the next (in EIF letters)
const EIF_VERTEX: Record<string, { faces: string[]; from: string; to: string }> = {
  R: { faces: ['U', 'F', 'R', 'Br'], from: 'F', to: 'U' }, L: { faces: ['U', 'F', 'L', 'Bl'], from: 'U', to: 'F' }, F: { faces: ['F', 'L', 'D', 'R'], from: 'F', to: 'R' },
};

const isFace = (s: string): s is FtoFace => (FTO_FACES as readonly string[]).includes(s);

/** The 90° rotation about the corner shared by `faces` that carries face `from` onto face `to`. */
function vertexRotation(faces: FtoFace[], from: FtoFace, to: FtoFace, times: number): Op {
  const axis = norm(faces.map((f) => FTO_NORMAL[f]).reduce(add));
  const sign = near(norm(rotate(FTO_NORMAL[from], axis, Math.PI / 2)), FTO_NORMAL[to]) ? 1 : -1;
  return { axis, angle: sign * times * (Math.PI / 2), sel: 'all' };
}

function turns(suffix: string | undefined): number {
  return suffix === "'" ? -1 : suffix === '2' ? 2 : suffix === "2'" ? -2 : 1;
}

/** One token as an op, or throws `Could not read: <token>`. */
function parseOp(token: string, frame: FtoFrame): Op {
  if (frame === 'ben') {
    // U F' Lw Rs Bo (Ben's o = whole-puzzle rotation; v is cubing.js's spelling of the same, 2U its spelling of Us), and A_B_C_Dv2, cubing.js's 180° about a corner
    const v = /^([A-Z]+(?:_[A-Z]+){3})v2'?$/.exec(token);
    if (v) {
      const faces = v[1]!.split('_');
      if (!faces.every(isFace)) throw new Error(`Could not read: ${token}`);
      return vertexRotation(faces, faces[0]!, faces[1]!, 2);
    }
    const m = /^(2)?(U|F|L|R|D|B|BL|BR)([wsov])?(2'|2|')?$/.exec(token); // 2U is cubing.js's spelling of the slice Us
    if (!m || (m[1] && m[3])) throw new Error(`Could not read: ${token}`);
    const face = m[2] as FtoFace, sel: Sel = m[1] ? 'slice' : m[3] === 'w' ? 'wide' : m[3] === 's' ? 'slice' : m[3] ? 'all' : 'face';
    return { axis: FTO_NORMAL[face], angle: -turns(m[4]) * THIRD, sel }; // clockwise seen from outside = negative about the outward normal
  }
  const t = /^(R|L|F)t(2'|2|')?$/.exec(token);
  if (t) {
    const v = EIF_VERTEX[t[1]!]!;
    const k = t[2] === "'" ? -1 : t[2] ? 2 : 1; // a 4-fold turn: 2 and 2' are the same half turn
    return vertexRotation(v.faces.map((f) => EIF_TO_BEN[f]!), EIF_TO_BEN[v.from]!, EIF_TO_BEN[v.to]!, k);
  }
  const m = /^(U|F|L|R|D|B|Bl|Br)([wso])?(2'|2|')?$/.exec(token);
  if (!m) throw new Error(`Could not read: ${token}`);
  const face = EIF_TO_BEN[m[1]!]!, sel: Sel = m[2] === 'w' ? 'wide' : m[2] === 's' ? 'slice' : m[2] ? 'all' : 'face';
  return { axis: FTO_NORMAL[face], angle: -turns(m[3]) * THIRD, sel };
}

/** The alg's tokens: whitespace-separated, no brackets (none of the sheet's FTO algs use them). */
export function ftoTokens(alg: string): string[] {
  return alg.trim().split(/\s+/).filter(Boolean);
}

/** The inverse of a token list, reversed with each suffix flipped: a 120° puzzle has `X2` = `X'`, so `X2` inverts to `X2'`. */
export function invertFto(tokens: readonly string[]): string[] {
  return [...tokens].reverse().map((t) => (t.endsWith("2'") ? t.slice(0, -1) : t.endsWith('2') ? `${t}'` : t.endsWith("'") ? t.slice(0, -1) : `${t}'`));
}

/** Composition helper: the frame's rotation as a function on vectors, kept as the list of rotations applied so far. */
type Frame = { axis: Vec; angle: number }[];
const toStart = (frame: Frame, v: Vec): Vec => frame.reduceRight((p, r) => rotate(p, r.axis, -r.angle), v); // undo the rotations, latest first

/** One move of an alg with its axis in the frame the alg started in, which is where the state lives. */
export interface FtoOp {
  token: string;
  axis: Vec;
  /** radians about `axis`, right-hand rule (a clockwise face turn is negative) */
  angle: number;
  /** what turns: the face's layer, the slice under it, both, or the whole puzzle (a rotation, which moves no sticker) */
  sel: 'face' | 'slice' | 'wide' | 'all';
  /** the sticker positions the move carries round (every one for a rotation) */
  moving: number[];
}

/** The alg's moves as ops in the starting frame. Throws `Could not read: <token>` on a bad move. */
export function ftoOps(alg: string, frame: FtoFrame = 'ben'): FtoOp[] {
  const rot: Frame = [];
  const out: FtoOp[] = [];
  for (const token of ftoTokens(alg)) {
    const op = parseOp(token, frame);
    if (op.sel === 'all') { rot.push({ axis: op.axis, angle: op.angle }); }
    const axis = op.sel === 'all' ? toStart(rot.slice(0, -1), op.axis) : toStart(rot, op.axis);
    const moving = op.sel === 'all' ? FTO_STICKERS.map((s) => s.idx) : permutation({ ...op, axis }).map((d, i) => (d === i ? -1 : i)).filter((i) => i >= 0);
    out.push({ token, axis, angle: op.angle, sel: op.sel, moving });
  }
  return out;
}

/** The state after one op (a rotation changes nothing: it is the viewer's business). */
export function applyOp(state: FtoState, op: FtoOp): FtoState {
  if (op.sel === 'all') return state;
  const dest = permutation(op);
  const out = new Array<number>(72);
  for (let i = 0; i < 72; i++) out[dest[i]!] = state[i]!;
  return out;
}

/** The op that undoes `op`, animatable the same way (the layer occupies the same positions after the turn). */
export const inverseOp = (op: FtoOp): FtoOp => ({ ...op, angle: -op.angle });

/**
 * Stickers after `alg` from `state` (default solved), in the frame the alg started in. A whole-puzzle rotation
 * turns the frame the later moves are read in and moves nothing. Throws `Could not read: <token>` on a bad move.
 */
export function applyFto(alg: string, state: FtoState = solvedFto(), frame: FtoFrame = 'ben'): FtoState {
  if (state.length !== 72) throw new Error('state is not an FTO');
  return ftoOps(alg, frame).reduce(applyOp, state);
}

/** Indices of the stickers that differ between two states. */
export function diffFto(a: FtoState, b: FtoState): number[] {
  const out: number[] = [];
  for (let i = 0; i < 72; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/**
 * The alg as twizzle reads it: Ben's letters, no rotations (each rotation is pushed through the moves after it),
 * wide and slice moves as `F 2F` / `2F`. The turns are the same physical turns; only the final orientation of the
 * puzzle is dropped, which the viewer does not show anyway.
 */
export function twizzleFto(alg: string, frame: FtoFrame = 'ben'): string {
  const out: string[] = [];
  const suffix = (k: number) => (k === 1 ? '' : k === -1 ? "'" : k === 2 ? '2' : "2'");
  for (const op of ftoOps(alg, frame)) {
    if (op.sel === 'all') continue;
    const face = FTO_FACES.find((f) => near(FTO_NORMAL[f], op.axis));
    if (!face) throw new Error(`FTO: ${op.token} is not about a face after the rotations before it`); // rotations map faces to faces; cannot happen
    const k = Math.round(-op.angle / THIRD), s = suffix(k);
    if (op.sel !== 'slice') out.push(face + s);
    if (op.sel !== 'face') out.push(`2${face}${s}`);
  }
  return out.join(' ');
}

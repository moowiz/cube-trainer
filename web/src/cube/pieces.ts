// Pieces on a facelet string: where an edge or corner is and which way it
// faces, edge orientation to the F/B axis, and the 12-edge move model the
// EO solver and the EOCross worker share (orientation bits + the four white
// edges' slots, one table of 18 face turns).

import { FACE_MOVES, type Move } from './alg';
import { STICKERS, facesAt, key, posName, type Vec } from './geometry';

/** The 12 edge slots, and for each the facelet on its U/D face (F/B face for the middle layer) then the other. */
export const EDGE_SLOTS = ['UF', 'UR', 'UB', 'UL', 'DF', 'DR', 'DB', 'DL', 'FR', 'FL', 'BR', 'BL'] as const;
const EDGE_FACELETS: readonly [number, number][] = [[7, 19], [5, 10], [1, 46], [3, 37], [28, 25], [32, 16], [34, 52], [30, 43], [23, 12], [21, 41], [48, 14], [50, 39]];
/** Cubie position of each edge slot. */
export const EDGE_POS: readonly Vec[] = EDGE_FACELETS.map(([a]) => STICKERS[a].pos);
/** Slot index by name. */
export const SLOT_INDEX: Record<string, number> = Object.fromEntries(EDGE_SLOTS.map((n, i) => [n, i]));
/** Home slots of the white edges, in the order DF DR DB DL (the cross coordinate's edge order). */
export const CROSS_HOME: readonly number[] = [4, 5, 6, 7];

const isUD = (c: string) => c === 'U' || c === 'D';

/**
 * An edge is oriented (to the F/B axis) iff its primary sticker - the one showing U/D if either does,
 * else the one showing F/B - sits on the U/D face (U/D-layer slot) or the F/B face (middle slot).
 */
function edgeOriented(f: string, slot: number): boolean {
  const [h, o] = EDGE_FACELETS[slot];
  const a = f[h], b = f[o];
  if (isUD(a) || isUD(b)) return isUD(a);
  return a === 'F' || a === 'B';
}

/** Bit i set = edge slot i holds a misoriented edge. */
export function eoCoord(f: string): number {
  let v = 0;
  for (let i = 0; i < 12; i++) if (!edgeOriented(f, i)) v |= 1 << i;
  return v;
}

/** The slot holding the edge with these two letters (any order). */
export function findEdge(f: string, letters: string): number {
  const want = [...letters].sort().join('');
  const i = EDGE_FACELETS.findIndex(([a, b]) => [f[a], f[b]].sort().join('') === want);
  if (i < 0) throw new Error(`no ${letters} edge`);
  return i;
}

/** Where the four white edges are, in the order DF DR DB DL. */
function crossSlots(f: string): number[] {
  return ['DF', 'DR', 'DB', 'DL'].map((e) => findEdge(f, e));
}

/** Corner positions: the cubie at `pos` and its three facelets. */
export const CORNER_POS: readonly Vec[] = [[1, 1, 1], [-1, 1, 1], [-1, 1, -1], [1, 1, -1], [1, -1, 1], [-1, -1, 1], [-1, -1, -1], [1, -1, -1]];

/** Where the corner with these three letters is, and which face its `facing` letter (default D, white) looks at. */
export function findCorner(f: string, letters: string, facing = 'D'): { pos: Vec; name: string; face: string } {
  const want = [...letters].sort().join('');
  for (const pos of CORNER_POS) {
    const idx = facesAt(pos);
    if (idx.map((i) => f[i]).sort().join('') !== want) continue;
    const at = idx.find((i) => f[i] === facing)!;
    return { pos, name: posName(pos), face: STICKERS[at].face };
  }
  throw new Error(`no ${letters} corner`);
}

/** Every sticker on the cubie at `pos` shows the face it is on. */
export function cubieSolved(f: string, pos: Vec): boolean {
  return facesAt(pos).every((i) => f[i] === STICKERS[i].face);
}

// ---- the 12-edge move model ----------------------------------------------------------------

// clockwise 4-cycles of slots for each face
const CYCLE: Record<string, string[]> = {
  U: ['UF', 'UL', 'UB', 'UR'], D: ['DF', 'DR', 'DB', 'DL'], R: ['UR', 'BR', 'DR', 'FR'],
  L: ['UL', 'FL', 'DL', 'BL'], F: ['UF', 'FR', 'DF', 'FL'], B: ['UB', 'BL', 'DB', 'BR'],
};

export interface EdgeMove {
  /** perm[dest] = the slot whose edge lands in dest */
  perm: number[];
  /** a quarter turn of F or B: flips the four edges it moves */
  flip: boolean;
  move: Move;
}

/** The 18 face turns on the edges, in FACE_MOVES order (so an index is a move id shared with the worker). */
export const EDGE_MOVES: readonly EdgeMove[] = FACE_MOVES.map((move) => {
  const perm = Array.from({ length: 12 }, (_, i) => i);
  const c = CYCLE[move.face].map((n) => SLOT_INDEX[n]);
  for (let i = 0; i < 4; i++) perm[c[(i + move.times) % 4]] = c[i];
  return { perm, flip: (move.face === 'F' || move.face === 'B') && move.times !== 2, move };
});

export interface EdgeState {
  eo: number;
  /** slot of each white edge, DF DR DB DL */
  slots: number[];
}

export function edgeState(f: string): EdgeState {
  return { eo: eoCoord(f), slots: crossSlots(f) };
}

export function applyEdgeMove(st: EdgeState, m: EdgeMove): EdgeState {
  const p = m.perm;
  let eo = 0;
  for (let i = 0; i < 12; i++) { let b = (st.eo >> p[i]) & 1; if (m.flip && p[i] !== i) b ^= 1; eo |= b << i; }
  const inv = new Array<number>(12);
  for (let i = 0; i < 12; i++) inv[p[i]] = i;
  return { eo, slots: st.slots.map((s) => inv[s]) };
}

/** The move table entry for a face turn. */
export function edgeMoveOf(m: Move): EdgeMove {
  return EDGE_MOVES[FACE_MOVES.findIndex((x) => x.face === m.face && x.times === m.times)];
}

export const eoSolved = (st: EdgeState): boolean => st.eo === 0;
export const crossSolved = (st: EdgeState): boolean => st.slots.every((s, i) => s === CROSS_HOME[i]);
export const crossCount = (st: EdgeState): number => st.slots.filter((s, i) => s === CROSS_HOME[i]).length;

/** The four edge slots on a face. */
function faceSlots(face: string): number[] {
  return CYCLE[face].map((n) => SLOT_INDEX[n]);
}

/** Bad edges among a face's four slots. */
export function badOnFace(st: EdgeState, face: string): number {
  return faceSlots(face).filter((s) => (st.eo >> s) & 1).length;
}

/** Cubie positions of the bad edges (for marking them in a picture). */
export function badEdgePositions(f: string): Set<string> {
  const eo = eoCoord(f);
  const out = new Set<string>();
  for (let i = 0; i < 12; i++) if ((eo >> i) & 1) out.add(key(EDGE_POS[i]));
  return out;
}

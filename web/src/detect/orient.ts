// Face orientation resolution (M6/M7, pipeline step 7).
//
// The detector outputs each face's 4 corners only up to CYCLIC rotation
// (rotation-invariant training: on a dead-on lone face the starting corner
// is unobservable). Sticker assignment needs each quad in the face's cubejs
// sticker-layout order (TL,TR,BR,BL). This module recovers that rotation
// from geometry: two adjacent faces visible in the same frame share a
// physical edge, and WHICH of each quad's four edges coincides pins both
// faces' rotations absolutely via the cube's corner tables.
//
// Single-face frames carry no constraint - callers keep the last resolved
// rotation per track (the tracker maintains stable corner indexing over
// time, so a rotation, once known, stays valid until the track drops).
//
// Assumes quads wind consistently on screen (a visible face always projects
// with the same winding; the detector is trained that way and the tracker
// preserves it).

import type { FaceId } from '../types';
import { FACE_ORDER } from '../types';

export type Corner = readonly [number, number];
export interface OrientableFace {
  face: FaceId;
  corners: ReadonlyArray<Corner>;
}
export interface OrientationResult {
  /** face -> k such that corners[(t + k) % 4] is sticker-layout corner t
   *  (TL,TR,BR,BL). Only faces that got at least one constraint appear. */
  rotations: Partial<Record<FaceId, number>>;
  pairsUsed: number;
  conflicts: number;
}

// Cube-space corner ids per face in sticker-layout order (TL,TR,BR,BL) -
// same tables as model/gen/scene.mjs FACE_DATA, the single source of truth.
const LAYOUT: Record<FaceId, string[]> = {
  U: ['-1,1,-1', '1,1,-1', '1,1,1', '-1,1,1'],
  R: ['1,1,1', '1,1,-1', '1,-1,-1', '1,-1,1'],
  F: ['-1,1,1', '1,1,1', '1,-1,1', '-1,-1,1'],
  D: ['-1,-1,1', '1,-1,1', '1,-1,-1', '-1,-1,-1'],
  L: ['-1,1,-1', '-1,1,1', '-1,-1,1', '-1,-1,-1'],
  B: ['1,1,-1', '-1,1,-1', '-1,-1,-1', '1,-1,-1'],
};

function faceSize(c: ReadonlyArray<Corner>): number {
  // sqrt of the shoelace area - a scale for distance tolerances
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    s += x0 * y1 - x1 * y0;
  }
  return Math.sqrt(Math.abs(s / 2));
}

function dist(a: Corner, b: Corner): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** For adjacent faces a,b: their shared cube edge as (indexInA, indexInB)
 *  where LAYOUT[a] traverses the edge at (ia, ia+1) and LAYOUT[b] traverses
 *  it reversed at (jb, jb+1). Returns null for non-adjacent (opposite). */
function sharedEdge(a: FaceId, b: FaceId): { ia: number; jb: number } | null {
  const la = LAYOUT[a], lb = LAYOUT[b];
  for (let ia = 0; ia < 4; ia++) {
    const p = la[ia], q = la[(ia + 1) % 4];
    for (let jb = 0; jb < 4; jb++) {
      if (lb[jb] === q && lb[(jb + 1) % 4] === p) return { ia, jb };
    }
  }
  return null;
}

/**
 * Resolve absolute rotations for co-visible faces. Faces with no adjacent
 * partner in the list stay unresolved (caller falls back to the track's
 * remembered rotation). Conflicting constraints are counted, majority wins.
 */
export function resolveOrientations(
  faces: ReadonlyArray<OrientableFace>,
  tolFrac = 0.22,
): OrientationResult {
  const votes: Partial<Record<FaceId, number[]>> = {};
  let pairsUsed = 0;

  for (let x = 0; x < faces.length; x++) {
    for (let y = x + 1; y < faces.length; y++) {
      const A = faces[x], B = faces[y];
      const edge = sharedEdge(A.face, B.face);
      if (!edge) continue; // opposite faces: no shared edge (and co-visibility is itself dubious)
      const tol = tolFrac * ((faceSize(A.corners) + faceSize(B.corners)) / 2);

      // find the image-space edge match: A's edge (i,i+1) coincides with
      // B's edge (j,j+1) traversed the opposite way
      let best: { i: number; j: number; cost: number } | null = null;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const cost = dist(A.corners[i], B.corners[(j + 1) % 4]) + dist(A.corners[(i + 1) % 4], B.corners[j]);
          if (!best || cost < best.cost) best = { i, j, cost };
        }
      }
      if (!best || best.cost > 2 * tol) continue;

      pairsUsed++;
      (votes[A.face] ??= []).push(((best.i - edge.ia) % 4 + 4) % 4);
      (votes[B.face] ??= []).push(((best.j - edge.jb) % 4 + 4) % 4);
    }
  }

  const rotations: Partial<Record<FaceId, number>> = {};
  let conflicts = 0;
  for (const f of FACE_ORDER) {
    const v = votes[f];
    if (!v) continue;
    const counts = [0, 0, 0, 0];
    for (const k of v) counts[k]++;
    const k = counts.indexOf(Math.max(...counts));
    conflicts += v.length - counts[k];
    rotations[f] = k;
  }
  return { rotations, pairsUsed, conflicts };
}

/**
 * Identify a face from its neighbour (adjacency, 2026-09-13). Given a face
 * whose letter AND rotation are known (corners in sticker-layout order) and
 * an anonymous quad that shares an image-space edge with it, the shared edge
 * is a specific cube edge, and the face across that edge is fixed by the
 * cube's geometry: a quad on the right of an oriented white (U) face is R
 * whatever colour it reads. This is how a lone warm face becomes red or
 * orange before the second warm colour has been seen. Returns the neighbour's
 * letter and its rotation, or null when the quads share no edge.
 */
export function identifyNeighbour(
  known: { face: FaceId; corners: ReadonlyArray<Corner> },
  unknown: ReadonlyArray<Corner>,
  tolFrac = 0.22,
): { face: FaceId; rotation: number } | null {
  const tol = tolFrac * ((faceSize(known.corners) + faceSize(unknown)) / 2);
  let best: { i: number; j: number; cost: number } | null = null;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const cost = dist(known.corners[i], unknown[(j + 1) % 4]) + dist(known.corners[(i + 1) % 4], unknown[j]);
      if (!best || cost < best.cost) best = { i, j, cost };
    }
  }
  if (!best || best.cost > 2 * tol) return null;
  // known's layout edge (i, i+1) as cube corner ids; the face across it is
  // the other face whose layout holds both ids
  const p = LAYOUT[known.face][best.i]!;
  const q = LAYOUT[known.face][(best.i + 1) % 4]!;
  for (const f of FACE_ORDER) {
    if (f === known.face) continue;
    const jb = LAYOUT[f].findIndex((c, k) => c === q && LAYOUT[f][(k + 1) % 4] === p);
    if (jb >= 0) return { face: f, rotation: ((best.j - jb) % 4 + 4) % 4 };
  }
  return null;
}

/** Row-major cell indices along sticker-layout edge e (from layout corner e to e+1), in traversal order. */
export const EDGE_CELLS: readonly (readonly number[])[] = [[0, 1, 2], [2, 5, 8], [8, 7, 6], [6, 3, 0]];

const OPPOSITE: Record<FaceId, FaceId> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

/**
 * For adjacent faces a and b (cells in sticker-layout order), the three
 * pairs of cells that sit on their shared cube edge: pairs[k] = [cell of
 * a, cell of b] are two stickers of ONE piece (k = 0 and 2 corners, k = 1
 * the edge piece). Null for opposite faces.
 */
export function sharedEdgeCells(a: FaceId, b: FaceId): [number, number][] | null {
  const e = sharedEdge(a, b);
  if (!e) return null;
  const ca = EDGE_CELLS[e.ia]!;
  const cb = EDGE_CELLS[e.jb]!; // b traverses the edge the other way
  return [0, 1, 2].map((k) => [ca[k]!, cb[2 - k]!]);
}

/**
 * Whether the stickers along the edge shared by two oriented faces can be
 * real pieces: the two visible stickers of one piece are never the same
 * colour nor opposite colours. Unknown cells (null) pass. A frame whose
 * pairing fails this was oriented wrongly (or a quad is not that face) -
 * caught in the frame it happens, before it can vote.
 */
export function edgePiecesPlausible(a: FaceId, cellsA: readonly (FaceId | null)[], b: FaceId, cellsB: readonly (FaceId | null)[]): boolean {
  const pairs = sharedEdgeCells(a, b);
  if (!pairs) return false;
  for (const [i, j] of pairs) {
    const x = cellsA[i];
    const y = cellsB[j];
    if (!x || !y) continue;
    if (x === y || OPPOSITE[x] === y) return false;
  }
  return true;
}

/** Apply a resolved rotation: result[t] is sticker-layout corner t. */
/**
 * Geometry constraint (tier 1): up to 3 visible faces yield 12 corner
 * estimates but only ~7 physical cube vertices - adjacent faces share
 * corners. Given ORIENTED quads (layout order, i.e. after orientQuad),
 * cluster the estimates that are the same physical vertex via the LAYOUT
 * shared-edge tables and snap each cluster to its mean. A pair is only
 * fused when the two estimates agree within tolFrac of the smaller face's
 * size - a huge gap means the orientation (or a quad) is wrong, and fusing
 * would smear the error across faces.
 */
export function fuseSharedCorners(
  faces: ReadonlyArray<{ face: FaceId; corners: ReadonlyArray<Corner> }>,
  tolFrac = 0.25,
): { fused: Map<FaceId, Corner[]>; fusedPairs: number } {
  const out = new Map<FaceId, Corner[]>();
  for (const f of faces) out.set(f.face, f.corners.map((c) => [c[0], c[1]] as Corner));

  // union-find over (face, cornerIndex) nodes
  const key = (f: FaceId, i: number) => `${f}:${i}`;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
  for (const f of faces) for (let i = 0; i < 4; i++) parent.set(key(f.face, i), key(f.face, i));

  let fusedPairs = 0;
  for (let x = 0; x < faces.length; x++) {
    for (let y = x + 1; y < faces.length; y++) {
      const A = faces[x], B = faces[y];
      const se = sharedEdge(A.face, B.face);
      if (!se) continue;
      const tol = tolFrac * Math.min(faceSize(A.corners), faceSize(B.corners));
      const pairs: Array<[number, number]> = [
        [se.ia, (se.jb + 1) % 4],
        [(se.ia + 1) % 4, se.jb],
      ];
      for (const [ia, jb] of pairs) {
        if (dist(A.corners[ia], B.corners[jb]) <= tol) {
          union(key(A.face, ia), key(B.face, jb));
          fusedPairs++;
        }
      }
    }
  }

  // average each cluster, write back
  const groups = new Map<string, Array<[FaceId, number]>>();
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      const r = find(key(f.face, i));
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push([f.face, i]);
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let sx = 0, sy = 0;
    for (const [f, i] of members) {
      const c = out.get(f)![i];
      sx += c[0];
      sy += c[1];
    }
    const m: Corner = [sx / members.length, sy / members.length];
    for (const [f, i] of members) out.get(f)![i] = [m[0], m[1]];
  }
  return { fused: out, fusedPairs };
}

export function orientQuad<T>(corners: ReadonlyArray<T>, k: number): T[] {
  const n = ((k % 4) + 4) % 4;
  return corners.map((_, t) => corners[(t + n) % 4]);
}

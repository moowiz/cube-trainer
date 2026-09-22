// The cube-state side of the scanner: the colour-space constants the
// detector's namer shares, 3x3 rotation helpers, from-scratch cube-piece
// validation, and cubejs-backed solving.
//
// cubejs is NOT trustworthy for validation (see validateState below) so the
// cubie-level checks here are implemented from the facelet string directly,
// cross-checked in tests against real cubejs states.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { WorkerRpc } from './workers/rpc';
import { labMedian } from './color';
import { FACE_ORDER } from './types';
import type { Lab } from './types';

// ---------- the namer's colour space (detect/identify.ts) ----------

// DECISION: cluster in an exposure-normalized space — subtract each face's
// median L (cancels the camera's auto-exposure drift between captures) and
// weight the residual L by 0.15 (color identity lives mostly in a/b; after
// per-face centering, L residual depends on what else shares the face — it is
// more noise dimension than signal, and keeping it heavy lets k-means split
// clusters along it or drown a small a/b separation). On the backlit-kitchen
// frame fixtures normalization fixes a red→orange miss that plain Lab makes,
// and accuracy holds at 44/45 for any L weight from 1 down to 0.15 (see
// test/lowlight.test.ts); well-lit colors stay separated because they differ
// strongly in a/b anyway.
export const CLUSTER_L_WEIGHT = 0.15;

/**
 * Lightness weight for naming a face against fixed exemplars.
 *
 * MEASURED: CLUSTER_L_WEIGHT is right for its own job — clustering all 54
 * stickers RELATIVE to each other, where crushing L cancels auto-exposure
 * drift between captures and lets chroma do the separating. Reusing it to
 * match against an absolute exemplar throws away the one dimension that
 * separates white from a dark color: white sits at a*~0 b*~0, so any weakly
 * chromatic sample lands nearest it. On a phone capture a blue center at
 * L* 18 a* +2 b* -28 (face median L 18) ranked white 29.4 / blue 41.8 at
 * weight 0.15, and white 43.3 / blue 45.7 at weight 1.0 — the crush, not the
 * color, is what named it white. Naming keeps the median-L subtraction (still
 * exposure-invariant) but pays full price for lightness.
 */
export const NAME_L_WEIGHT = 1.0;

/**
 * Map one face's 9 cells into a normalized space: subtract the face's own
 * median lightness (this is what cancels exposure drift) and scale what is
 * left. Default weight is the clustering one assembleState uses; naming
 * passes NAME_L_WEIGHT.
 */
export function normalizeFaceCells(cells: readonly Lab[], lWeight = CLUSTER_L_WEIGHT): Lab[] {
  const medL = labMedian(cells).L;
  return cells.map((c) => ({ L: (c.L - medL) * lWeight, a: c.a, b: c.b }));
}

/**
 * Chroma above this is compressed by CHROMA_SLOPE before stickers are
 * classified. MEASURED 2026-09-13 on the phone sessions: a sticker's chroma
 * swings with illumination far more than its hue - the same blue read
 * (16, -61) lit and (6, -28) in shadow, and in plain ab the shadowed one
 * sat nearer white (27) than blue (34); a pale yellow (-10, 40) was a coin
 * flip between yellow and white. Halving chromatic differences beyond the
 * knee keeps neutrals linear (white vs a dim blue still separates by
 * chroma) while a colour seen dim stays with its hue.
 */
export const CHROMA_KNEE = 20;
export const CHROMA_SLOPE = 0.5;

// DECISION: two centres closer than this in the normalized space are
// treated as the same physical face seen twice (the namer's duplicate
// guard). Calibrated on fixtures: genuinely duplicated or unusable centre
// pairs sit at ~6 (cube-scan-1789101879130), while the hardest legitimate
// pair seen — white under a blue monitor cast vs a real blue centre
// (cube-scan-1789102942492) — sits at 12.8 and must stay apart.
export const CENTER_MIN_DIST = 10;

/** Row-major 3x3 cell index after k quarter turns: rotated[i] = cells[ROT3[k][i]]. */
const ROT3: readonly (readonly number[])[] = (() => {
  const once = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // 90 deg: new (r, c) = old (2 - c, r)
  const out: number[][] = [[0, 1, 2, 3, 4, 5, 6, 7, 8]];
  for (let k = 1; k < 4; k++) out.push(out[k - 1]!.map((_, i) => out[k - 1]![once[i]!]!));
  return out;
})();

export function rotateCells<T>(cells: readonly T[], k: number): T[] {
  return ROT3[k & 3]!.map((j) => cells[j]!);
}

// ---------- validateState ----------
//
// Verified against the installed cubejs (1.3.2) source (lib/cube.js):
// facelet index = faceOffset + (positionOnFace - 1), with faceOffset
// U=0 R=9 F=18 D=27 L=36 B=45, and center facelets at [4,13,22,31,40,49].
// Corner/edge facelet tables below are transcribed straight from cubejs's
// own cornerFacelet/edgeFacelet tables (see cube.js), not re-derived, so
// orientation/permutation math here agrees with what Cube.fromString does —
// except we additionally *validate* (cubejs's fromString silently accepts
// garbage; see module docs above).

export interface ValidationResult {
  ok: boolean;
  error?: string;
  badStickers?: number[];
}

export const CENTER_INDICES: readonly number[] = [4, 13, 22, 31, 40, 49];

// Each triple starts with the slot's U/D facelet, listed clockwise.
export const CORNER_FACELETS: readonly (readonly [number, number, number])[] = [
  [8, 9, 20], // URF
  [6, 18, 38], // UFL
  [0, 36, 47], // ULB
  [2, 45, 11], // UBR
  [29, 26, 15], // DFR
  [27, 44, 24], // DLF
  [33, 53, 42], // DBL
  [35, 17, 51], // DRB
];

export const CORNER_COLORS: readonly (readonly [string, string, string])[] = [
  ['U', 'R', 'F'], // URF
  ['U', 'F', 'L'], // UFL
  ['U', 'L', 'B'], // ULB
  ['U', 'B', 'R'], // UBR
  ['D', 'F', 'R'], // DFR
  ['D', 'L', 'F'], // DLF
  ['D', 'B', 'L'], // DBL
  ['D', 'R', 'B'], // DRB
];

// Each pair is [primary, secondary]: primary = U/D facelet for U/D edges,
// F/B facelet for equator edges (FR, FL, BL, BR).
export const EDGE_FACELETS: readonly (readonly [number, number])[] = [
  [5, 10], // UR
  [7, 19], // UF
  [3, 37], // UL
  [1, 46], // UB
  [32, 16], // DR
  [28, 25], // DF
  [30, 43], // DL
  [34, 52], // DB
  [23, 12], // FR
  [21, 41], // FL
  [50, 39], // BL
  [48, 14], // BR
];

export const EDGE_COLORS: readonly (readonly [string, string])[] = [
  ['U', 'R'],
  ['U', 'F'],
  ['U', 'L'],
  ['U', 'B'],
  ['D', 'R'],
  ['D', 'F'],
  ['D', 'L'],
  ['D', 'B'],
  ['F', 'R'],
  ['F', 'L'],
  ['B', 'L'],
  ['B', 'R'],
];

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== new Set(a).size) return false; // a has a repeated letter -> can't equal a real piece's set
  const bs = new Set(b);
  if (bs.size !== a.length) return false;
  return a.every((c) => bs.has(c));
}

/** Parity (0 even, 1 odd) of a permutation given as slot -> piece-index. */
function permParity(perm: readonly number[]): number {
  const seen = new Array<boolean>(perm.length).fill(false);
  let parity = 0;
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    let j = i;
    while (!seen[j]) {
      seen[j] = true;
      j = perm[j]!;
      len++;
    }
    if (len > 0) parity += len - 1;
  }
  return parity % 2;
}

const PIECE_MISMATCH_ERROR = "These stickers don't form a real cube piece — scan again.";

/** Full solvability check. NEVER uses cubejs solve() for this (see module docs). */
export function validateState(facelets: string): ValidationResult {
  if (facelets.length !== 54) {
    return { ok: false, error: `Expected 54 stickers, got ${facelets.length}.` };
  }
  if (!/^[URFDLB]{54}$/.test(facelets)) {
    return { ok: false, error: 'Invalid sticker colors found — expected only U, R, F, D, L, B.' };
  }
  for (const face of FACE_ORDER) {
    let count = 0;
    for (let i = 0; i < 54; i++) if (facelets[i] === face) count++;
    if (count !== 9) {
      return { ok: false, error: `Face color ${face} appears ${count} times — should be exactly 9.` };
    }
  }
  const centerColors = CENTER_INDICES.map((i) => facelets[i]!);
  if (new Set(centerColors).size !== 6) {
    return { ok: false, error: 'The six center stickers must all be different colors — rescan in better light.' };
  }

  // Corners.
  const cp = new Array<number>(8).fill(-1);
  const co = new Array<number>(8).fill(0);
  const cornerSlotOf = new Array<number>(8).fill(-1); // piece -> slot
  for (let slot = 0; slot < 8; slot++) {
    const idxs = CORNER_FACELETS[slot]!;
    const letters = idxs.map((idx) => facelets[idx]!);
    let piece = -1;
    for (let j = 0; j < 8; j++) {
      if (setEquals(letters, CORNER_COLORS[j]!)) {
        piece = j;
        break;
      }
    }
    if (piece === -1) {
      return { ok: false, error: PIECE_MISMATCH_ERROR, badStickers: [...idxs] };
    }
    if (cornerSlotOf[piece] !== -1) {
      return {
        ok: false,
        error: PIECE_MISMATCH_ERROR,
        badStickers: [...CORNER_FACELETS[cornerSlotOf[piece]]!, ...idxs],
      };
    }
    cornerSlotOf[piece] = slot;
    cp[slot] = piece;
    let ori = -1;
    for (let n = 0; n < 3; n++) {
      if (letters[n] === 'U' || letters[n] === 'D') {
        ori = n;
        break;
      }
    }
    co[slot] = ori;
  }

  // Edges.
  const ep = new Array<number>(12).fill(-1);
  const eo = new Array<number>(12).fill(0);
  const edgeSlotOf = new Array<number>(12).fill(-1); // piece -> slot
  for (let slot = 0; slot < 12; slot++) {
    const idxs = EDGE_FACELETS[slot]!;
    const letters = idxs.map((idx) => facelets[idx]!);
    let piece = -1;
    for (let j = 0; j < 12; j++) {
      if (setEquals(letters, EDGE_COLORS[j]!)) {
        piece = j;
        break;
      }
    }
    if (piece === -1) {
      return { ok: false, error: PIECE_MISMATCH_ERROR, badStickers: [...idxs] };
    }
    if (edgeSlotOf[piece] !== -1) {
      return {
        ok: false,
        error: PIECE_MISMATCH_ERROR,
        badStickers: [...EDGE_FACELETS[edgeSlotOf[piece]]!, ...idxs],
      };
    }
    edgeSlotOf[piece] = slot;
    ep[slot] = piece;
    eo[slot] = letters[0] === EDGE_COLORS[piece]![0] ? 0 : 1;
  }

  // Parity.
  const coSum = co.reduce((a, b) => a + b, 0) % 3;
  if (coSum !== 0) {
    return { ok: false, error: 'A corner is twisted — scan again.' };
  }
  const eoSum = eo.reduce((a, b) => a + b, 0) % 2;
  if (eoSum !== 0) {
    return { ok: false, error: 'An edge is flipped — scan again.' };
  }
  if (permParity(cp) !== permParity(ep)) {
    return { ok: false, error: 'Two pieces are swapped — scan again.' };
  }

  return { ok: true };
}

// ---------- solveState / warmSolver ----------

interface SolveRequest {
  id: number;
  facelets?: string;
  warm?: boolean;
}
interface SolveResponse {
  id: number;
  solution?: string;
  warm?: boolean;
  error?: string;
}

let rpc: WorkerRpc<Omit<SolveRequest, 'id'>, SolveResponse> | null = null;

function getWorker(): WorkerRpc<Omit<SolveRequest, 'id'>, SolveResponse> {
  // Vite worker pattern — this URL must be written literally like this.
  rpc ??= new WorkerRpc(new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' }), { name: 'solver worker' });
  return rpc;
}

let nodeSolverReady = false;
function ensureNodeSolver(): void {
  if (!nodeSolverReady) {
    Cube.initSolver();
    nodeSolverReady = true;
  }
}

/** Kociemba solution via cubejs. Only call with a validateState-ok state. */
export function solveState(facelets: string): Promise<string> {
  if (typeof Worker !== 'undefined') {
    return getWorker().ask({ facelets }).then((r) => {
      if (r.error) throw new Error(r.error);
      return r.solution ?? '';
    });
  }
  // Node / vitest fallback: direct synchronous solve, lazy memoized initSolver.
  ensureNodeSolver();
  try {
    const solution = Cube.fromString(facelets).solve();
    return Promise.resolve(solution);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Pre-warm the solver (kick off initSolver in the worker) — fire and forget. */
export function warmSolver(): void {
  if (typeof Worker !== 'undefined') {
    void getWorker().ask({ warm: true }); // the ack resolves, nobody waits on it
  } else {
    ensureNodeSolver();
  }
}

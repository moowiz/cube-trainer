// The cube-state side of the scanner: from-scratch cube-piece validation
// (the legality oracle every lock goes through) and cubejs-backed solving.
// The piece tables are cube/pieces.ts's (cubejs's own order).
//
// cubejs is NOT trustworthy for validation (see validateState below) so the
// cubie-level checks here are implemented from the facelet string directly,
// cross-checked in tests against real cubejs states.

import Cube from './vendor/cubejs';
import { WorkerRpc } from './workers/rpc';
import { CENTER_INDICES, CORNER_COLORS, CORNER_FACELETS, EDGE_COLORS, EDGE_FACELETS } from './cube/pieces';
import { FACE_ORDER } from './types';

// ---------- validateState ----------
//
// The piece tables (cube/pieces.ts) are transcribed straight from cubejs's
// own cornerFacelet/edgeFacelet tables, so the orientation/permutation math
// here agrees with what Cube.fromString does - except we additionally
// *validate* (cubejs's fromString silently accepts garbage; see module docs
// above).

export interface ValidationResult {
  ok: boolean;
  error?: string;
  badStickers?: number[];
}

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

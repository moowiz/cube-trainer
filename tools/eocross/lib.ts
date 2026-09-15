// The node side of the EOCross tools, on the app's own cube code (no second
// edge model): the 12-edge move tables from web/src/cube/pieces.ts, states
// from web/src/cube/state.ts, and the worker's table builder loaded as a
// plain module (it exports itself as globalThis.EOCross outside a Worker).
// Run the scripts with vite-node from web/, which resolves the TS imports:
//   cd web && npx vite-node ../tools/eocross/analyse.ts

import { faceMoves, movesStr, moveStr } from '../../web/src/cube/alg';
import { CROSS_HOME, EDGE_MOVES, applyEdgeMove, edgeState, type EdgeState } from '../../web/src/cube/pieces';
import { state } from '../../web/src/cube/state';
import { applyMoves, eoDistance, randomScramble as randomScrambleMoves } from '../../web/src/eo/solver';
import '../../web/public/eocross-worker.js';

export type { EdgeState };
/** The 18 face turns in move-id order, with what the scripts read off them. */
export const MOVES = EDGE_MOVES.map((m) => ({ perm: m.perm, flip: m.flip, face: m.move.face, name: moveStr(m.move) }));
export const HOME: readonly number[] = CROSS_HOME;
export const SOLVED = (): EdgeState => ({ eo: 0, slots: [...CROSS_HOME] });
export const apply = (st: EdgeState, m: { perm: number[]; flip: boolean }): EdgeState => applyEdgeMove(st, m as never);
/** The edge state after an alg of face turns (from the solved cube, via the real facelet model). */
export const run = (_st: EdgeState, alg: string): EdgeState => edgeState(state(alg));
export const runMoves = (st: EdgeState, ids: number[]): EdgeState => applyMoves(st, ids.map((i) => EDGE_MOVES[i].move));
export const randomScramble = (rng: () => number = Math.random): string => movesStr(randomScrambleMoves(rng));
export const eoDist = eoDistance;
export { faceMoves };

interface WorkerApi {
  build(perm: number[][], flip: boolean[], home: readonly number[]): { hist: number[]; ms: number };
  solve(eo: number, slots: number[], cap: number): { length: number; count: number; solutions: number[][]; truncated: boolean };
  dist(eo: number, slots: number[]): number;
  setPost(f: (m: unknown) => void): void;
}
export const W = (globalThis as unknown as { EOCross: WorkerApi }).EOCross;
/** Build the exact EOCross table once (quietly). */
export function buildTable(): { hist: number[]; ms: number } {
  W.setPost(() => undefined);
  return W.build(MOVES.map((m) => m.perm), MOVES.map((m) => m.flip), HOME);
}

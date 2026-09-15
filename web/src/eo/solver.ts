// EO solving on the 12-edge model: the 2^12 distance table, every optimal
// solution of a state, and the ways the trainer summarises a solution set -
// families (turns whose direction doesn't matter, commuting pairs), F/B
// plans, and the EOCross grouping by cross tail.

import { flipMove, isEoFlip, moveStr, type Move } from '../cube/alg';
import { EDGE_MOVES, applyEdgeMove, badOnFace, crossCount, edgeMoveOf, type EdgeState } from '../cube/pieces';

// distance of every orientation vector from solved, by BFS over the 18 face turns
const DIST = new Int8Array(4096).fill(-1);
DIST[0] = 0;
{
  let q = [0];
  while (q.length) {
    const nq: number[] = [];
    for (const s of q) for (const m of EDGE_MOVES) {
      const n = applyEdgeMove({ eo: s, slots: [] }, m).eo;
      if (DIST[n] < 0) { DIST[n] = DIST[s] + 1; nq.push(n); }
    }
    q = nq;
  }
}

export interface SolutionSet {
  length: number;
  solutions: Move[][];
  /** exact number of optimal solutions (the list may be capped) */
  count: number;
  truncated: boolean;
}

/** Every optimal EO solution: the DFS only takes distance-decreasing turns, so the tree is exactly the optimal set (at most ~1500). */
export function solveEO(eo: number): SolutionSet {
  const res: Move[][] = [];
  const path: Move[] = [];
  (function dfs(s: number, lastFace: string | null) {
    if (DIST[s] === 0) { res.push(path.slice()); return; }
    for (const m of EDGE_MOVES) {
      if (m.move.face === lastFace) continue;
      const n = applyEdgeMove({ eo: s, slots: [] }, m).eo;
      if (DIST[n] !== DIST[s] - 1) continue;
      path.push(m.move); dfs(n, m.move.face); path.pop();
    }
  })(eo, null);
  return { length: DIST[eo], solutions: res, count: res.length, truncated: false };
}

export const eoDistance = (eo: number): number => DIST[eo];

export function applyMoves(st: EdgeState, moves: readonly Move[]): EdgeState {
  return moves.reduce((s, m) => applyEdgeMove(s, edgeMoveOf(m)), st);
}

/** The line a solution is shown as: R* for a turn whose direction doesn't matter, commuting pairs in a fixed order. */
export interface Family { txt: string; moves: Move[]; starred: boolean[] }

const ORDER: Record<string, number> = { U: 0, D: 1, R: 0, L: 1, F: 0, B: 1 };
const OPP: Record<string, string> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

/**
 * One line per family of solutions: a quarter turn is written R* when its direction doesn't matter, and
 * the stars on a line are a promise about the whole family (every combination of the starred directions
 * reaches the goal), so they are added greedily left to right and each candidate is checked against all
 * 2^k combinations; and opposite faces commute (R L = L R), so each such pair is written in a fixed order.
 */
export function canonical(start: EdgeState, sol: readonly Move[], solved: (st: EdgeState) => boolean): Family {
  const free: number[] = [];
  const familySolves = (): boolean => {
    for (let bits = 0; bits < 1 << free.length; bits++) {
      const alt = sol.slice();
      free.forEach((j, b) => { if ((bits >> b) & 1) alt[j] = flipMove(sol[j]); });
      if (!solved(applyMoves(start, alt))) return false;
    }
    return true;
  };
  const starred = sol.map(() => false);
  sol.forEach((m, i) => {
    if (m.times === 2) return;
    free.push(i);
    if (familySolves()) starred[i] = true; else free.pop();
  });
  const moves = sol.map((m, i) => (starred[i] ? { face: m.face, times: 1 as const } : m));
  for (let i = 0; i + 1 < moves.length; i++) {
    if (OPP[moves[i].face] === moves[i + 1].face && ORDER[moves[i].face] > ORDER[moves[i + 1].face]) {
      [moves[i], moves[i + 1]] = [moves[i + 1], moves[i]];
      [starred[i], starred[i + 1]] = [starred[i + 1], starred[i]];
    }
  }
  const txt = moves.map((m, i) => (starred[i] ? `${m.face}*` : moveStr(m))).join(' ');
  return { txt, moves, starred };
}

export interface Group { key: string; text: string; order: number }

/** The F/B plan of a solution: how many bad edges sit on the face at each F/B quarter turn. */
export function fbPlan(start: EdgeState, sol: readonly Move[]): Group {
  const counts: number[] = [];
  let st = start;
  for (const m of sol) {
    if (isEoFlip(m)) counts.push(badOnFace(st, m.face));
    st = applyEdgeMove(st, edgeMoveOf(m));
  }
  const text = counts.length ? `${counts.length} F/B turn${counts.length === 1 ? '' : 's'}: ${counts.join(' then ')}` : '';
  return { key: counts.join('-'), text, order: 0 };
}

/** Index of the last F/B quarter turn (-1 if none): where EO is finished. */
export function lastEoTurn(sol: readonly Move[]): number {
  let k = -1;
  sol.forEach((m, i) => { if (isEoFlip(m)) k = i; });
  return k;
}

/** The EOCross grouping: how many cross-only moves follow the last EO turn. */
export function crossTail(sol: readonly Move[]): Group {
  const tail = sol.length - 1 - lastEoTurn(sol);
  return { key: `t${tail}`, text: tail === 0 ? 'the last EO turn finishes the cross' : `${tail} cross move${tail === 1 ? '' : 's'} after EO`, order: tail };
}

/** For each optimal solution, the shape stats the per-scramble strategy hint describes. */
export function solutionShape(start: EdgeState, sol: readonly Move[]): { eoLen: number; tail: Move[]; before: number; atEO: number } {
  const k = lastEoTurn(sol);
  const st = applyMoves(start, sol.slice(0, k));
  const before = crossCount(st);
  const atEO = k >= 0 ? crossCount(applyEdgeMove(st, edgeMoveOf(sol[k]))) : before;
  return { eoLen: k + 1, tail: sol.slice(k + 1), before, atEO };
}

/** Random scramble with the trainer's rules: 20-24 turns, never the same face twice, never F B F on one axis. */
export function randomScramble(rng: () => number = Math.random): Move[] {
  const opp = OPP;
  const seq: Move[] = [];
  let last: string | null = null, last2: string | null = null;
  const n = 20 + Math.floor(rng() * 5);
  while (seq.length < n) {
    const f = 'URFDLB'[Math.floor(rng() * 6)];
    if (f === last) continue;
    if (last && f === opp[last] && f === last2) continue;
    seq.push({ face: f, times: [1, 3, 2][Math.floor(rng() * 3)] as 1 | 2 | 3 });
    last2 = last; last = f;
  }
  return seq;
}

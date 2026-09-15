// Scrambles for last-layer drills: a short face-turn sequence that takes a
// solved cube to a given PLL state, so the drill can be set up on a real
// cube without rotations, slices, or the case's own alg read backwards.
//
// A PLL state is in Kociemba's G1 (every piece oriented, the middle-layer
// edges in the middle layer), so it is solved by his phase 2 alone: the ten
// moves <U, U2, U', D, D2, D', R2, L2, F2, B2>, which keep G1. This is an
// optimal phase-2 solver (IDA*, pruned by the two tables Kociemba used:
// corner permutation x middle-layer edges and U/D edges x middle-layer
// edges, 967 680 entries each, BFS-built on first use) and the scramble is
// its solution inverted. cubejs's solve() is not used: its phase-1 search
// starts at depth 1, so a state already in G1 gets a five-move detour and
// an 18-21 move answer.
//
// The piece permutations come from cubejs's cube model (cp = where each
// corner slot's cubie came from, ep likewise for edges) so the facelet
// letters and move names agree with the rest of the trainer.

/// <reference path="../cubejs.d.ts" />
import Cube from 'cubejs';

const MOVES = ['U', 'U2', "U'", 'D', 'D2', "D'", 'R2', 'L2', 'F2', 'B2'] as const;
const FACE_OF = [0, 0, 0, 1, 1, 1, 2, 3, 4, 5]; // U D R L F B
const OPPOSITE = [1, 0, 3, 2, 5, 4];
const N_PERM8 = 40320, N_SLICE = 24;

// ---- permutation coordinates: Lehmer rank of a permutation of n items ----
function rank(p: readonly number[]): number {
  let r = 0;
  for (let i = 0; i < p.length; i++) {
    let smaller = 0;
    for (let j = i + 1; j < p.length; j++) if (p[j]! < p[i]!) smaller++;
    r = r * (p.length - i) + smaller;
  }
  return r;
}
function unrank(r: number, n: number, out: number[]): number[] {
  const digits: number[] = [];
  for (let i = 1; i <= n; i++) { digits.unshift(r % i); r = Math.floor(r / i); }
  const free: number[] = []; for (let i = 0; i < n; i++) free.push(i);
  for (let i = 0; i < n; i++) out[i] = free.splice(digits[i]!, 1)[0]!;
  return out;
}

interface Tables {
  cpMove: Uint16Array; // [perm * 10 + move] -> perm, for the corner permutation
  epMove: Uint16Array; // the U/D edge permutation (edges 0..7 in cubejs's order)
  slMove: Uint8Array;  // the middle-layer edge permutation (edges 8..11)
  pruneCp: Uint8Array; // [cp * 24 + slice] -> moves to solve those two, at least
  pruneEp: Uint8Array; // [ep * 24 + slice]
}
let tables: Tables | null = null;

function buildTables(): Tables {
  // one cubejs cube per move: cp[i] / ep[i] is which cubie sits in slot i after the move from solved
  const mv = MOVES.map((m) => new Cube().move(m));
  const cpMove = new Uint16Array(N_PERM8 * 10), epMove = new Uint16Array(N_PERM8 * 10), slMove = new Uint8Array(N_SLICE * 10);
  const p: number[] = [], q: number[] = [];
  for (let r = 0; r < N_PERM8; r++) {
    unrank(r, 8, p);
    for (let m = 0; m < 10; m++) {
      const c = mv[m]!;
      for (let i = 0; i < 8; i++) q[i] = p[c.cp[i]!]!; // apply the move after the state (cubejs multiply order)
      cpMove[r * 10 + m] = rank(q);
      for (let i = 0; i < 8; i++) q[i] = p[c.ep[i]!]!; // in G1 slots 0..7 hold edges 0..7
      epMove[r * 10 + m] = rank(q);
    }
  }
  const p4: number[] = [], q4: number[] = [];
  for (let r = 0; r < N_SLICE; r++) {
    unrank(r, 4, p4);
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < 4; i++) q4[i] = p4[mv[m]!.ep[8 + i]! - 8]!;
      slMove[r * 10 + m] = rank(q4);
    }
  }
  const bfs = (permMove: Uint16Array): Uint8Array => {
    const t = new Uint8Array(N_PERM8 * N_SLICE).fill(255);
    let frontier = [0]; t[0] = 0;
    for (let d = 0; frontier.length; d++) {
      const next: number[] = [];
      for (const s of frontier) {
        const perm = Math.floor(s / N_SLICE), sl = s % N_SLICE;
        for (let m = 0; m < 10; m++) {
          const n = permMove[perm * 10 + m]! * N_SLICE + slMove[sl * 10 + m]!;
          if (t[n] === 255) { t[n] = d + 1; next.push(n); }
        }
      }
      frontier = next;
    }
    return t;
  };
  return { cpMove, epMove, slMove, pruneCp: bfs(cpMove), pruneEp: bfs(epMove) };
}

/** The phase-2 coordinates of a G1 facelet string, or null when it is not in G1. */
function coords(facelets: string): { cp: number; ep: number; sl: number } | null {
  const c = Cube.fromString(facelets);
  if (c.co.some((o) => o) || c.eo.some((o) => o)) return null;
  if (c.ep.slice(8).some((e) => e < 8)) return null;
  return { cp: rank(c.cp), ep: rank(c.ep.slice(0, 8)), sl: rank(c.ep.slice(8).map((e) => e - 8)) };
}

/**
 * An optimal phase-2 solution for a G1 state, as a move string ('' when solved), or null when the
 * state is not in G1. Equal-length solutions are tried in a random order, so the same case does
 * not always draw the same one.
 */
export function solveG1(facelets: string, rng: () => number = Math.random): string | null {
  const st = coords(facelets);
  if (!st) return null;
  const t = (tables ??= buildTables());
  const order = MOVES.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const path: number[] = [];
  const search = (cp: number, ep: number, sl: number, depth: number, lastFace: number): boolean => {
    const h = Math.max(t.pruneCp[cp * N_SLICE + sl]!, t.pruneEp[ep * N_SLICE + sl]!);
    if (h > depth) return false;
    if (depth === 0) return true;
    for (const m of order) {
      const f = FACE_OF[m]!;
      if (f === lastFace || (OPPOSITE[f] === lastFace && f < lastFace)) continue; // no U U, and U D only in one order
      path.push(m);
      if (search(t.cpMove[cp * 10 + m]!, t.epMove[ep * 10 + m]!, t.slMove[sl * 10 + m]!, depth - 1, f)) return true;
      path.pop();
    }
    return false;
  };
  for (let depth = 0; depth <= 18; depth++) if (search(st.cp, st.ep, st.sl, depth, -1)) return path.map((m) => MOVES[m]).join(' ');
  return null; // phase 2 needs at most 18 moves: unreachable for a G1 state
}

/** Build the pruning tables ahead of the first solve (~100 ms). */
export function warmG1(): void { tables ??= buildTables(); }

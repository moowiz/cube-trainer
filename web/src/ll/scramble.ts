// Scrambles for the last-layer drills: a short face-turn sequence that
// takes a solved cube to a given state, so the drill can be set up on a
// real cube without rotations, slices, or the case's own alg read
// backwards (which gives the case away - user, 2026-09-21).
//
// Kociemba's two-phase algorithm, run for the shortest total rather than
// the first answer: phase 1 takes the cube into G1 (every piece oriented,
// the middle-layer edges in the middle layer) with any of the 18 moves,
// phase 2 finishes it with the ten moves <U, U2, U', D, D2, D', R2, L2,
// F2, B2>, which keep G1. Every phase-1 solution of each length is tried
// with an optimal phase 2, longer phase-1 solutions only while they could
// still beat the best total, under a node budget. A PLL state is in G1
// already (phase 1 is empty: the answer is the optimal phase 2); an OCLL
// or last-pair state needs a few phase-1 moves and the answer mixes the
// orientation and the permutation into one sequence, which is the point.
// Equal-length answers are tried in a random order, so the same case does
// not always draw the same one. The scramble is the answer inverted.
//
// Options (user, 2026-09-24): the faces phase 2 may turn (the PLL drill
// keeps U, D, R2 and L2: every PLL state is reachable with those, measured
// over all 84, and F2 and B2 are the awkward double turns with the cube in
// hand), an exact answer
// length (every scramble the same length, and a random answer of that
// length rather than the one or two shortest ones, so the scramble does
// not name the case), and no U as the answer's first move (the scramble
// does not end in an AUF, which the drill would trim off).
//
// Pruning: the classic tables, BFS-built on first use - phase 1 by corner
// orientation x middle-layer edge positions (2187 x 495) and edge
// orientation x the same (2048 x 495); phase 2 by corner permutation x
// middle-layer edge permutation and U/D edge permutation x the same
// (40320 x 24 each). cubejs's solve() is not used: its phase-1 search
// starts at depth 1, so a state already in G1 gets a five-move detour and
// an 18-21 move answer, and a low depth cap makes it search for minutes.
//
// The piece permutations come from cubejs's cube model (cp = where each
// corner slot's cubie came from, ep likewise for edges) so the facelet
// letters and move names agree with the rest of the trainer.

import Cube from '../vendor/cubejs';

const MOVES = ['U', 'U2', "U'", 'D', 'D2', "D'", 'R2', 'L2', 'F2', 'B2'] as const;
const FACE_OF = [0, 0, 0, 1, 1, 1, 2, 3, 4, 5]; // U D R L F B
const OPPOSITE = [1, 0, 3, 2, 5, 4];
const N_PERM8 = 40320, N_SLICE = 24;
// phase 1: all 18 moves, three per face in the same face order
const ALL = ['U', 'U2', "U'", 'D', 'D2', "D'", 'R', 'R2', "R'", 'L', 'L2', "L'", 'F', 'F2', "F'", 'B', 'B2', "B'"] as const;
const FACE_OF_ALL = ALL.map((_, i) => Math.floor(i / 3));
const IS_PHASE2 = ALL.map((m) => (MOVES as readonly string[]).includes(m));
const N_CO = 2187, N_EO = 2048, N_SLPOS = 495;

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
/** Build once, on the main thread, and say how long it took: the load-time freeze on a phone (2026-09-26) is measured here. */
function once<T>(name: string, build: () => T): T {
  const t0 = performance.now();
  const t = build();
  console.info(`[ll] Kociemba ${name} tables built in ${(performance.now() - t0).toFixed(0)} ms`);
  return t;
}

/** The full piece state: cubejs's cp / co / ep / eo, as one array. */
type Pieces = Uint8Array; // [cp 0..7, co 8..15, ep 16..27, eo 28..39]
const piecesOf = (c: Cube): Pieces => Uint8Array.from([...c.cp, ...c.co, ...c.ep, ...c.eo]);
/** The pieces after `mv` (a move's pieces from solved) applied after `p` (cubejs multiply order). */
function applyPieces(p: Pieces, mv: Pieces, out: Pieces): Pieces {
  for (let i = 0; i < 8; i++) { const from = mv[i]!; out[i] = p[from]!; out[8 + i] = (p[8 + from]! + mv[8 + i]!) % 3; }
  for (let i = 0; i < 12; i++) { const from = mv[16 + i]!; out[16 + i] = p[16 + from]!; out[28 + i] = (p[28 + from]! + mv[28 + i]!) % 2; }
  return out;
}
// phase-1 coordinates off the pieces: corner twist (base 3, seven corners), edge flip (bits, eleven edges),
// which four edge slots hold the middle-layer edges (a 4-of-12 combination, ranked)
const coOf = (p: Pieces): number => { let r = 0; for (let i = 0; i < 7; i++) r = r * 3 + p[8 + i]!; return r; };
const eoOf = (p: Pieces): number => { let r = 0; for (let i = 0; i < 11; i++) r = (r << 1) | p[28 + i]!; return r; };
const COMB_RANK = (() => { const t = new Int16Array(4096).fill(-1); let n = 0; for (let m = 0; m < 4096; m++) { let b = 0; for (let v = m; v; v &= v - 1) b++; if (b === 4) t[m] = n++; } return t; })();
const slPosOf = (p: Pieces): number => { let m = 0; for (let i = 0; i < 12; i++) if (p[16 + i]! >= 8) m |= 1 << i; return COMB_RANK[m]!; };

interface Tables1 {
  moves: Pieces[];      // the 18 moves' pieces from solved
  coMove: Uint16Array;  // [co * 18 + move] -> co
  eoMove: Uint16Array;  // [eo * 18 + move] -> eo
  slMove: Uint16Array;  // [slicePos * 18 + move] -> slicePos
  pruneCo: Uint8Array;  // [co * 495 + slicePos] -> moves to orient the corners and bring the slice edges home, at least
  pruneEo: Uint8Array;  // [eo * 495 + slicePos]
}
let tables1: Tables1 | null = null;

function buildTables1(): Tables1 {
  const moves = ALL.map((m) => piecesOf(new Cube().move(m)));
  const solved = piecesOf(new Cube());
  // a coordinate's move table from one representative pieces array per value (the other coordinates are
  // irrelevant to it: a move changes each coordinate on its own)
  const moveTable = (size: number, set: (p: Pieces, v: number) => void, get: (p: Pieces) => number): Uint16Array => {
    const t = new Uint16Array(size * ALL.length);
    const p = Uint8Array.from(solved), q = new Uint8Array(40);
    for (let v = 0; v < size; v++) {
      set(p, v);
      for (let m = 0; m < ALL.length; m++) t[v * ALL.length + m] = get(applyPieces(p, moves[m]!, q));
    }
    return t;
  };
  const setCo = (p: Pieces, v: number) => { let sum = 0; for (let i = 6; i >= 0; i--) { p[8 + i] = v % 3; sum += v % 3; v = Math.floor(v / 3); } p[15] = (3 - (sum % 3)) % 3; };
  const setEo = (p: Pieces, v: number) => { let sum = 0; for (let i = 10; i >= 0; i--) { p[28 + i] = v & 1; sum += v & 1; v >>= 1; } p[39] = sum & 1; };
  const COMB_MASK = (() => { const t = new Uint16Array(N_SLPOS); for (let m = 0; m < 4096; m++) if (COMB_RANK[m]! >= 0) t[COMB_RANK[m]!] = m; return t; })();
  const setSl = (p: Pieces, v: number) => { const mask = COMB_MASK[v]!; let lo = 0, hi = 8; for (let i = 0; i < 12; i++) p[16 + i] = mask & (1 << i) ? hi++ : lo++; };
  const coMove = moveTable(N_CO, setCo, coOf), eoMove = moveTable(N_EO, setEo, eoOf), slMove = moveTable(N_SLPOS, setSl, slPosOf);
  const SL_HOME = slPosOf(solved); // the slice edges in the slice: the last combination, not rank 0
  const bfs = (size: number, cMove: Uint16Array): Uint8Array => {
    const t = new Uint8Array(size * N_SLPOS).fill(255);
    let frontier = [SL_HOME]; t[SL_HOME] = 0; // coordinate 0 (all oriented) x the slice home
    for (let d = 0; frontier.length; d++) {
      const next: number[] = [];
      for (const s of frontier) {
        const c = Math.floor(s / N_SLPOS), sl = s % N_SLPOS;
        for (let m = 0; m < ALL.length; m++) {
          const n = cMove[c * ALL.length + m]! * N_SLPOS + slMove[sl * ALL.length + m]!;
          if (t[n] === 255) { t[n] = d + 1; next.push(n); }
        }
      }
      frontier = next;
    }
    return t;
  };
  return { moves, coMove, eoMove, slMove, pruneCo: bfs(N_CO, coMove), pruneEo: bfs(N_EO, eoMove) };
}

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

const inG1 = (p: Pieces): boolean => coOf(p) === 0 && eoOf(p) === 0 && p[16 + 8]! >= 8 && p[16 + 9]! >= 8 && p[16 + 10]! >= 8 && p[16 + 11]! >= 8;
/** The phase-2 coordinates of pieces in G1. */
function coords2(p: Pieces): { cp: number; ep: number; sl: number } {
  const cp = Array.from(p.subarray(0, 8)), ep = Array.from(p.subarray(16, 24)), sl = Array.from(p.subarray(24, 28), (e) => e - 8);
  return { cp: rank(cp), ep: rank(ep), sl: rank(sl) };
}

const shuffled = (n: number, rng: () => number): number[] => {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  return order;
};

/**
 * A phase-2 solution (move indices into MOVES) for G1 coordinates: the first found of `minDepth`
 * moves, else of one more, up to `maxDepth`, or null. `lastFace` is the face the moves before it
 * ended on (no U after a U); `order` is the moves tried, in that order (a subset drops faces).
 */
function searchG1(st: { cp: number; ep: number; sl: number }, minDepth: number, maxDepth: number, lastFace: number, order: readonly number[], slices?: 'none' | 'paired', budget = Infinity, counter = { n: 0 }): number[] | null {
  const t = (tables ??= once('phase 2', buildTables));
  const path: number[] = [];
  const start = counter.n;
  const search = (cp: number, ep: number, sl: number, depth: number, last: number): boolean => {
    if (++counter.n > budget) return false;
    const h = Math.max(t.pruneCp[cp * N_SLICE + sl]!, t.pruneEp[ep * N_SLICE + sl]!);
    if (h > depth) return false;
    if (depth === 0) return h === 0 && slicesOk(path, slices);
    for (const m of order) {
      const f = FACE_OF[m]!;
      if (f === last || (OPPOSITE[f] === last && f < last)) continue; // no U U, and U D only in one order
      if (slices === 'none' && OPPOSITE[f] === last && f >= 2) continue; // no L2 straight after R2
      path.push(m);
      if (search(t.cpMove[cp * 10 + m]!, t.epMove[ep * 10 + m]!, t.slMove[sl * 10 + m]!, depth - 1, f)) return true;
      path.pop();
    }
    return false;
  };
  for (let depth = Math.max(0, minDepth); depth <= maxDepth && counter.n <= budget; depth++) if (search(st.cp, st.ep, st.sl, depth, lastFace)) { stats.phase2 += counter.n - start; return path; }
  stats.phase2 += counter.n - start;
  if (counter.n > budget && start <= budget) stats.gaveUp++;
  if (counter.n > budget && start <= budget) console.info(`[ll] phase 2 search gave up after ${budget} nodes (depth ${minDepth}..${maxDepth}, ${order.length} moves, slices ${slices ?? 'free'}${lastFace >= 0 ? ', no leading U' : ''}): a looser search stands in`);
  return null;
}

// DECISION: a constrained phase-2 search (a subset of the faces, an exact length, the slice rule, no
// leading U) is capped: the pruning tables know all ten moves, so with faces dropped they under-estimate,
// and a length with no answer under the rules is a full tree walk (U and D alone never solve an H perm:
// depths 0..30, for ever). Past the cap the next looser search stands in; the last one (every move, no
// rules) is exact and fast. Measured 2026-09-26 over every PLL setup with an AUF each side, U D R2 L2:
// the drill's searches finish under 6M nodes (~120 ms on a desktop), so 20M is a safety net, not a trim.
const G1_BUDGET = 20_000_000;
// The phase-2 tails the two-phase search runs at each phase-1 leaf share one budget of their own: they
// had none, and a Performance trace of 2026-09-25 put a 45 s freeze at page load entirely in them
// (scrambleFor -> solveAny -> search1 -> searchG1). Over 400 drill setups the tails total under 3.1M
// nodes; with the faces restricted (the PLL drill's rebase) up to 15M, ~800 ms, so this trims those.
const TAIL_BUDGET = 5_000_000;

/** What the last solveAny / solveG1 cost: for the drills' console line and the tests' budget checks. */
export interface SearchStats { phase1: number; phase2: number; gaveUp: number }
const stats: SearchStats = { phase1: 0, phase2: 0, gaveUp: 0 };
export const lastSearchStats = (): SearchStats => ({ ...stats });

export interface SolveOpts {
  /** the faces phase 2 may turn, as letters (default every face: 'UDRLFB'); U and D are always in */
  faces?: string;
  /** an answer of exactly this many moves, when there is one (else the shortest, as without) */
  length?: number;
  /** an answer this many moves past the shortest, the count drawn from [min, max] (a G1 state; else ignored) */
  longer?: [number, number];
  /** no U as the first move of the answer: the scramble (the answer backwards) then never ends in an AUF */
  noLeadingU?: boolean;
  /**
   * An R2 next to an L2 is an M2 in two turns (the drill shows it as one). 'none' forbids the pair;
   * 'paired' allows it but wants an even number (each one turns the cube over in hand, the last
   * layer must end up on top) and not an answer made of U, D and pairs alone - that is the <M2, U>
   * family, and H, Z, Ua and Ub would come out as their own algs (user, 2026-09-24).
   */
  slices?: 'none' | 'paired';
}
/** The `slices` rule on a finished path: the pairs are R2 then L2 (the canonical order allows only that way round). */
function slicesOk(path: readonly number[], rule: 'none' | 'paired' | undefined): boolean {
  if (!rule) return true;
  let pairs = 0, other = 0;
  for (let i = 0; i < path.length; i++) {
    const f = FACE_OF[path[i]!]!, g = i + 1 < path.length ? FACE_OF[path[i + 1]!]! : -1;
    if (f >= 2 && g >= 2 && g !== f) { pairs++; i++; continue; }
    if (f >= 2) other++;
  }
  if (rule === 'none') return pairs === 0;
  return pairs % 2 === 0 && (pairs === 0 || other > 0);
}
/** The MOVES kept by `faces`, in a random order. */
function movesOf(opts: SolveOpts, rng: () => number): number[] {
  const faces = (opts.faces ?? 'UDRLFB').toUpperCase();
  return shuffled(MOVES.length, rng).filter((m) => 'UDRLFB'[FACE_OF[m]!]!.match(/[UD]/) || faces.includes('UDRLFB'[FACE_OF[m]!]!));
}
/** The phase-1 moves kept by `faces`, in a random order (a face dropped from phase 2 is dropped here too). */
function moves1Of(opts: SolveOpts, rng: () => number): number[] {
  const faces = (opts.faces ?? 'UDRLFB').toUpperCase();
  return shuffled(ALL.length, rng).filter((m) => 'UDRLFB'[FACE_OF_ALL[m]!]!.match(/[UD]/) || faces.includes('UDRLFB'[FACE_OF_ALL[m]!]!));
}

/**
 * An optimal phase-2 solution for a G1 state, as a move string ('' when solved), or null when the
 * state is not in G1. Equal-length solutions are tried in a random order, so the same case does
 * not always draw the same one.
 */
function solveG1(facelets: string, rng: () => number = Math.random, opts: SolveOpts = {}): string | null {
  const p = piecesOf(Cube.fromString(facelets));
  if (!inG1(p)) return null;
  const order = movesOf(opts, rng), last = opts.noLeadingU ? 0 : -1;
  const st = coords2(p);
  const ns = opts.slices;
  let length = opts.length;
  if (length === undefined && opts.longer) {
    const shortest = searchG1(st, 0, 30, last, order, ns, G1_BUDGET);
    const [lo, hi] = opts.longer;
    if (shortest) length = shortest.length + lo + Math.floor(rng() * (hi - lo + 1));
  }
  // DECISION: the asked length first; when nothing has that length (too short, or the wrong parity for
  // the moves allowed) the shortest answer stands in - a scramble that works beats one of the right length
  const path = (length !== undefined ? searchG1(st, length, length, last, order, ns, G1_BUDGET) : null)
    ?? searchG1(st, 0, 30, last, order, ns, G1_BUDGET) ?? searchG1(st, 0, 30, -1, shuffled(MOVES.length, rng));
  return path ? path.map((m) => MOVES[m]).join(' ') : null; // phase 2 needs at most 18 moves with every face: never null for a G1 state
}

// DECISION: the two-phase search stops after this many phase-1 nodes (~50 ms) and returns the best
// total so far: 14-17 moves for a PLL with the corners twisted, where 2M nodes gain nothing and
// 40M (4 s) find 11 for one case in four. Short enough to apply, and not an alg backwards.
const NODE_BUDGET = 400_000;

/**
 * A short solution for any state, as a move string ('' when solved): Kociemba's two phases, the
 * best total found within the node budget (optimal in practice for the drills' states, which are a
 * few moves out of G1). Equal-length solutions come up in a random order.
 */
export function solveAny(facelets: string, rng: () => number = Math.random, opts: SolveOpts = {}): string {
  stats.phase1 = 0; stats.phase2 = 0; stats.gaveUp = 0;
  return solveAnyInner(facelets, rng, opts);
}
function solveAnyInner(facelets: string, rng: () => number, opts: SolveOpts): string {
  const p0 = piecesOf(Cube.fromString(facelets));
  if (inG1(p0)) return solveG1(facelets, rng, opts)!;
  const t1 = (tables1 ??= once('phase 1', buildTables1));
  tables ??= once('phase 2', buildTables);
  const order1 = moves1Of(opts, rng), order2 = movesOf(opts, rng);
  const first = opts.noLeadingU ? 0 : -1;
  // an exact total: each phase-1 answer gets a phase-2 tail of exactly the rest (the first found), and
  // the search stops at the first total that fits; else the shortest total, as before
  const exact = opts.length;
  const found: { best: string[] | null } = { best: null };
  let nodes = 0;
  const tails = { n: 0 }; // phase-2 nodes over every tail, against TAIL_BUDGET
  const stack: Pieces[] = Array.from({ length: 20 }, () => new Uint8Array(40));
  const path: number[] = [];
  // every phase-1 solution of exactly `depth` more moves (h == 0 at the end); a phase-1 solution ending in a
  // phase-2 move was found one shorter already, with a total no worse
  const search1 = (p: Pieces, depth: number, lastFace: number, level: number): void => {
    if (nodes++ > NODE_BUDGET) return;
    const sl = slPosOf(p);
    const h = Math.max(t1.pruneCo[coOf(p) * N_SLPOS + sl]!, t1.pruneEo[eoOf(p) * N_SLPOS + sl]!);
    if (h > depth) return;
    if (depth === 0) {
      if (h !== 0 || (path.length && IS_PHASE2[path[path.length - 1]!])) return;
      if (exact !== undefined) {
        const rest = exact - path.length;
        if (rest < 0) return;
        const tail = searchG1(coords2(p), rest, rest, lastFace, order2, undefined, TAIL_BUDGET, tails);
        if (tail) { found.best = [...path.map((m) => ALL[m]!), ...tail.map((m) => MOVES[m]!)]; nodes = NODE_BUDGET + 1; }
        if (tails.n > TAIL_BUDGET) nodes = NODE_BUDGET + 1; // the tails are spent: stop phase 1 too
        return;
      }
      const cap = found.best ? found.best.length - path.length - 1 : 18;
      if (cap < 0) return;
      const tail = searchG1(coords2(p), 0, cap, lastFace, order2, undefined, TAIL_BUDGET, tails);
      if (tail) found.best = [...path.map((m) => ALL[m]!), ...tail.map((m) => MOVES[m]!)];
      if (tails.n > TAIL_BUDGET) nodes = NODE_BUDGET + 1;
      return;
    }
    for (const m of order1) {
      const f = FACE_OF_ALL[m]!;
      if (f === lastFace || (OPPOSITE[f] === lastFace && f < lastFace)) continue;
      path.push(m);
      search1(applyPieces(p, t1.moves[m]!, stack[level]!), depth - 1, f, level + 1);
      path.pop();
      if (nodes > NODE_BUDGET) return;
    }
  };
  for (let d1 = 1; d1 <= 12 && nodes <= NODE_BUDGET; d1++) {
    if (found.best && d1 >= found.best.length) break;
    search1(p0, d1, first, 0);
  }
  stats.phase1 += nodes;
  if (!found.best && (exact !== undefined || opts.noLeadingU || opts.faces)) return solveAnyInner(facelets, rng, exact !== undefined ? { ...opts, length: undefined } : {}); // nothing of that length (or with those faces): the shortest stands in
  return found.best!.join(' '); // phase 1 finds a solution by depth 12 for any state, far inside the budget
}

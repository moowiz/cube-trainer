// Targeted F2L practice: a scramble that puts a chosen slot's pair in a chosen
// case (or several slots' pairs, each in its own), with EO and the cross solved
// and everything else at random - drawn as a whole cube state, then a short
// Kociemba solution of it read backwards as the scramble, so the scramble never
// reads as the case's alg undone. Pure; the trainer owns the pool's UI.
//
// Frame: the trainer's (white down), as everywhere in f2l/.

import { inverse } from '../cube/alg';
import { CORNER_COLORS, CORNER_FACELETS, EDGE_COLORS, EDGE_FACELETS } from '../cube/pieces';
import { state } from '../cube/state';
import { solveAny } from '../ll/scramble';
import { caseId, caseOf, fullAlg, invert, SLOTS, type SlotName } from './model';

/** A case to practise: the pair of `slot` in the sheet's case `n` for that slot. */
export interface Target { slot: SlotName; n: number }

/** Where the pieces of a state sit: at each corner position the piece and its twist, at each edge position the piece and its flip. */
interface Cubies { cp: number[]; co: number[]; ep: number[]; eo: number[] }

const isUD = (c: string) => c === 'U' || c === 'D';

function readCubies(f: string): Cubies {
  const cp: number[] = [], co: number[] = [], ep: number[] = [], eo: number[] = [];
  CORNER_FACELETS.forEach((fs, i) => {
    const o = fs.findIndex((x) => isUD(f[x]!));
    const cols = [0, 1, 2].map((k) => f[fs[(o + k) % 3]!]).join('');
    cp[i] = CORNER_COLORS.findIndex((c) => c.join('') === cols); co[i] = o;
  });
  EDGE_FACELETS.forEach(([a, b], i) => {
    const j = EDGE_COLORS.findIndex(([x, y]) => x === f[a] && y === f[b]);
    ep[i] = j >= 0 ? j : EDGE_COLORS.findIndex(([x, y]) => x === f[b] && y === f[a]); eo[i] = j >= 0 ? 0 : 1;
  });
  return { cp, co, ep, eo };
}

function writeCubies(p: Cubies): string {
  const f = state('').split('');
  CORNER_FACELETS.forEach((fs, i) => { for (let k = 0; k < 3; k++) f[fs[(p.co[i]! + k) % 3]!] = CORNER_COLORS[p.cp[i]!]![k]!; });
  EDGE_FACELETS.forEach(([a, b], i) => { const [x, y] = EDGE_COLORS[p.ep[i]!]!; if (p.eo[i]) { f[a] = y; f[b] = x; } else { f[a] = x; f[b] = y; } });
  return f.join('');
}

/** The flip that orients edge piece `piece` at position `pos` to the F/B axis (the ZZ sense of EO, pieces.ts's eoCoord). */
function goodFlip(piece: number): number {
  // the sticker EO follows is the U/D one, else the F/B one; oriented when it is on the position's first facelet
  // (a U/D-layer position's first facelet is on U/D, a middle one's on F/B)
  const [x, y] = EDGE_COLORS[piece]!;
  const prim = isUD(x) || isUD(y) ? (isUD(x) ? x : y) : (x === 'F' || x === 'B' ? x : y);
  return prim === x ? 0 : 1;
}

const parity = (p: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i]! > p[j]!) s ^= 1;
  return s;
};

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!]; }
  return xs;
}

/** The corner and edge piece indices (cubejs's order) of a slot's pair. */
function pairPieces(slot: SlotName): { corner: number; edge: number } {
  const want = (s: string) => [...s].sort().join('');
  return {
    corner: CORNER_COLORS.findIndex((c) => want(c.join('')) === want(`D${slot}`)),
    edge: EDGE_COLORS.findIndex((c) => want(c.join('')) === want(slot)),
  };
}
const CROSS_EDGES = [4, 5, 6, 7]; // DR DF DL DB, home at their own index

/** Every placement of a case: one per AUF when its pieces are on top, as the lookup lists them. */
function placements(t: Target): Cubies[] {
  const hit = caseOf(caseId(t.slot, t.n));
  if (!hit) throw new Error(`no case ${t.slot} ${t.n}`);
  const setup = invert(fullAlg('', hit.c.algs[0]!));
  const seen = new Set<string>(), out: Cubies[] = [];
  for (const u of ['', 'U', 'U2', "U'"]) {
    const p = readCubies(state(`${setup} ${u}`));
    const { corner, edge } = pairPieces(t.slot);
    const k = `${p.cp.indexOf(corner)}.${p.co[p.cp.indexOf(corner)]}|${p.ep.indexOf(edge)}`;
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

export interface TargetOpts {
  /** the pairs not targeted: 'mixed' anywhere (as the plain practice scramble), or 'solved' where they can be */
  rest?: 'mixed' | 'solved';
}

/**
 * A cube state (trainer frame) with each target's pair in its case, at a random AUF where the case has
 * one; EO and the cross solved; the other pieces random (or the other pairs home, `rest: 'solved'`).
 * Null when the targets want the same spot (two cases each putting a piece in the same slot).
 */
export function targetState(targets: readonly Target[], rnd: () => number = Math.random, opts: TargetOpts = {}): string | null {
  if (new Set(targets.map((t) => t.slot)).size !== targets.length) return null; // one case per slot
  // every combination of the targets' AUFs (at most 4^4), in a random order: the first that fits
  const choices = targets.map(placements);
  let combos: Cubies[][] = [[]];
  for (const ch of choices) combos = combos.flatMap((c) => ch.map((p) => [...c, p]));
  for (const combo of shuffle(combos, rnd)) {
    const cp = Array<number>(8).fill(-1), co = Array<number>(8).fill(0), ep = Array<number>(12).fill(-1), eo = Array<number>(12).fill(0);
    for (const e of CROSS_EDGES) ep[e] = e;
    let clash = false;
    targets.forEach((t, i) => {
      const p = combo[i]!, { corner, edge } = pairPieces(t.slot);
      const ci = p.cp.indexOf(corner), ei = p.ep.indexOf(edge);
      if (cp[ci] !== -1 || ep[ei] !== -1) { clash = true; return; }
      cp[ci] = corner; co[ci] = p.co[ci]!; ep[ei] = edge; eo[ei] = p.eo[ei]!;
    });
    if (clash) continue;
    const placedC = new Set(cp.filter((x) => x >= 0)), placedE = new Set(ep.filter((x) => x >= 0));
    if (opts.rest === 'solved') {
      // the other pairs home where their spot is free, the rest of the pieces random below
      for (const s of SLOTS) {
        const { corner, edge } = pairPieces(s);
        if (!placedC.has(corner) && cp[corner] === -1) { cp[corner] = corner; co[corner] = 0; placedC.add(corner); }
        if (!placedE.has(edge) && ep[edge] === -1) { ep[edge] = edge; eo[edge] = 0; placedE.add(edge); }
      }
    }
    const freeCPos = cp.flatMap((x, i) => (x === -1 ? [i] : [])), freeC = shuffle([...Array(8).keys()].filter((j) => !placedC.has(j)), rnd);
    const freeEPos = ep.flatMap((x, i) => (x === -1 ? [i] : [])), freeE = shuffle([...Array(12).keys()].filter((j) => !placedE.has(j)), rnd);
    freeCPos.forEach((pos, k) => { cp[pos] = freeC[k]!; co[pos] = Math.floor(rnd() * 3); });
    freeEPos.forEach((pos, k) => { ep[pos] = freeE[k]!; });
    // a legal cube: the permutations' parities agree (else swap two free edges), the twists sum to 0 mod 3
    if (parity(cp) !== parity(ep)) {
      if (freeEPos.length >= 2) { const [a, b] = freeEPos; [ep[a!], ep[b!]] = [ep[b!]!, ep[a!]!]; }
      else if (freeCPos.length >= 2) { const [a, b] = freeCPos; [cp[a!], cp[b!]] = [cp[b!]!, cp[a!]!]; }
      else continue;
    }
    const twist = co.reduce((a, b) => a + b, 0) % 3;
    if (twist) {
      if (!freeCPos.length) continue;
      const last = freeCPos[freeCPos.length - 1]!;
      co[last] = (co[last]! + 3 - twist) % 3;
    }
    for (const pos of freeEPos) eo[pos] = goodFlip(ep[pos]!);
    return writeCubies({ cp, co, ep, eo });
  }
  return null;
}

/** A scramble (trainer frame) for `facelets`: a short solution of it, backwards. */
export function scrambleTo(facelets: string, rnd: () => number = Math.random): string {
  return inverse(solveAny(facelets, rnd));
}

/** A targeted practice scramble: `targetState` and the scramble that makes it, or null when the targets clash. */
export function genTargeted(targets: readonly Target[], rnd: () => number = Math.random, opts: TargetOpts = {}): { scramble: string; facelets: string } | null {
  const facelets = targetState(targets, rnd, opts);
  return facelets ? { facelets, scramble: scrambleTo(facelets, rnd) } : null;
}

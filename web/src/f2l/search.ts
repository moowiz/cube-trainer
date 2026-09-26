// The fewest R, L and U turns that solve a pair, keeping the cross and the pairs asked to be kept: what the
// sheet's algs are checked against, so a shorter one is never missed (user, 2026-09-26: case 31 on front-left
// listed only the sheet's 7-move alg; R L' U R' L does it in 5). The sheet is a list of good algs, not a
// proof that none is shorter.
// IDA* on the pieces that matter (the pair, the cross edges, the kept pairs), everything else free. The heuristic
// is the largest of the kept pairs' pattern tables: one per slot and move set, the distance to home of that slot's
// pair with the two side cross edges (R and L never touch the front and back ones, U none of them; EO is kept by
// every turn in the set). Other move sets (own side only, + D, + F2) are for scripts/f2l-derive.ts, which measures
// the sheet against each. Pure; a table is built once per slot and move set (~330k entries, a byte each).

import { SOLVED, state } from '../cube/state';
import type { F2LCase, SlotName } from './data';
import { moveCount } from '../cube/alg';
import { crossSolved, edgeState } from '../cube/pieces';
import { fullAlg, invert, SLOTS, slotSolved } from './model';
import { idAt, perm, stickersOf } from './ownside';

/** The move set the finder searches: ZZ's F2L turns, which keep EO and the front and back cross edges. */
export const RLU = ['U', "U'", 'U2', 'R', "R'", 'R2', 'L', "L'", 'L2'] as const;
const PERMS = new Map<string, number[][]>();
const P = (moves: readonly string[]) => { const k = moves.join(' '); let p = PERMS.get(k); if (!p) PERMS.set(k, (p = moves.map(perm))); return p; };
const OPP: Record<string, string> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

/** One sticker per piece: where it sits says where the piece is and which way it is turned. */
const ref = (name: string) => stickersOf(name)[0]!;
const CORNER_NAMES = ['UFR', 'UFL', 'UBR', 'UBL', 'DFR', 'DFL', 'DBR', 'DBL'];
const EDGE_NAMES = ['UF', 'UB', 'UR', 'UL', 'DF', 'DB', 'DR', 'DL', 'FR', 'FL', 'BR', 'BL'];
let cIdx: Int8Array | null = null, eIdx: Int8Array | null = null;
/** A sticker on a corner (edge) cubie as 0..23: the piece's place and twist (flip) in one number. */
function indices(): [Int8Array, Int8Array] {
  if (!cIdx || !eIdx) {
    cIdx = new Int8Array(54).fill(-1); eIdx = new Int8Array(54).fill(-1);
    CORNER_NAMES.flatMap((n) => stickersOf(n)).forEach((s, i) => { cIdx![s] = i; });
    EDGE_NAMES.flatMap((n) => stickersOf(n)).forEach((s, i) => { eIdx![s] = i; });
  }
  return [cIdx, eIdx];
}

/** The pieces a slot's table follows, as their home reference stickers: the pair's corner and edge, then DR, DL. */
const tablePieces = (slot: SlotName) => [ref(`D${slot}`), ref(slot), ref('DR'), ref('DL')];
const tableKey = (c: Int8Array, e: Int8Array, a: number, b: number, x: number, y: number) => ((c[a]! * 24 + e[b]!) * 24 + e[x]!) * 24 + e[y]!;

const TABLES = new Map<string, Uint8Array>();
/** Distance to home for every place of the slot's pair and the side cross edges, in `moves` (255: unreachable). */
function table(slot: SlotName, moves: readonly string[]): Uint8Array {
  const key = `${slot}|${moves.join(' ')}`;
  let t = TABLES.get(key);
  if (t) return t;
  const [c, e] = indices(), p = P(moves);
  t = new Uint8Array(24 ** 4).fill(255);
  let frontier = [tablePieces(slot)];
  t[tableKey(c, e, frontier[0]![0]!, frontier[0]![1]!, frontier[0]![2]!, frontier[0]![3]!)] = 0;
  for (let d = 1; frontier.length; d++) {
    const next: number[][] = [];
    for (const s of frontier) {
      for (const m of p) {
        const n = [m[s[0]!]!, m[s[1]!]!, m[s[2]!]!, m[s[3]!]!];
        const k = tableKey(c, e, n[0]!, n[1]!, n[2]!, n[3]!);
        if (t[k] !== 255) continue;
        t[k] = d; next.push(n);
      }
    }
    frontier = next;
  }
  TABLES.set(key, t);
  return t;
}

/** Where a slot's pair and the side cross edges sit, as reference-sticker positions: the pieces the search follows. */
export interface Placed { slot: SlotName; corner: number; edge: number }

/**
 * The fewest turns of `moves` (R/L/U by default) that put `pair`'s pieces home with the whole cross and every pair in
 * `keep` home at the end, those starting home (a kept pair may be lifted on the way; the other slots are free). Up
 * to `limit` of the shortest (all of one length, the first found first); [] past `maxDepth`.
 */
export function shortestAlgs(pair: Placed, keep: readonly SlotName[], opts: { moves?: readonly string[]; maxDepth?: number; limit?: number } = {}): string[] {
  const moves = opts.moves ?? RLU, maxDepth = opts.maxDepth ?? 14, limit = opts.limit ?? 1;
  const [c, e] = indices(), p = P(moves);
  const faces = moves.map((m) => m[0]!);
  const slots = [pair.slot, ...keep.filter((s) => s !== pair.slot)];
  const tabs = slots.map((s) => table(s, moves));
  /** state: [DR, DL, DF, DB, corner0, edge0, corner1, edge1, ...] */
  const home = [ref('DR'), ref('DL'), ref('DF'), ref('DB'), ...slots.flatMap((s) => [ref(`D${s}`), ref(s)])];
  const cur = [...home.slice(0, 4), pair.corner, pair.edge, ...home.slice(6)];
  const h = (s: number[]) => {
    let m = 0;
    for (let i = 0; i < tabs.length; i++) m = Math.max(m, tabs[i]![tableKey(c, e, s[4 + 2 * i]!, s[5 + 2 * i]!, s[0]!, s[1]!)]!);
    return m;
  };
  const done = (s: number[]) => s.every((x, i) => x === home[i]);
  const path: number[] = [], out: string[] = [];
  const dfs = (s: number[], g: number, bound: number, last: number): boolean => {
    const hs = h(s);
    if (g + hs > bound) return false;
    if (g === bound) { if (done(s)) out.push(path.map((m) => moves[m]).join(' ')); return out.length >= limit; }
    for (let m = 0; m < moves.length; m++) {
      const f = faces[m]!, lf = last < 0 ? '' : faces[last]!;
      if (f === lf || (OPP[f] === lf && f > lf)) continue; // no face twice; opposite faces commute, so one order only (R before L)
      const pm = p[m]!;
      path.push(m);
      if (dfs(s.map((x) => pm[x]!), g + 1, bound, m)) return true;
      path.pop();
    }
    return false;
  };
  if (h(cur) === 255) return [];
  for (let bound = h(cur); bound <= maxDepth; bound++) { dfs(cur, 0, bound, -1); if (out.length) return out; }
  return [];
}
/** The first of the shortest R/L/U algs (shortestAlgs), or null. */
export const shortestRLU = (pair: Placed, keep: readonly SlotName[], maxDepth = 14): string | null => shortestAlgs(pair, keep, { maxDepth })[0] ?? null;

/** The shortest alg in the form the sheet writes them: leading U turns as the AUF in brackets ('(U) R U R''). */
export function asSheetAlg(alg: string): string {
  const toks = alg.split(' ').filter(Boolean);
  return toks[0]?.[0] === 'U' ? `(${toks[0]}) ${toks.slice(1).join(' ')}` : toks.join(' ');
}

/**
 * Where a case puts its pair (the sheet's canonical AUF), read off its first alg undone: every alg of a case
 * solves the pair from the same place, whatever else it does - some go through other slots, so the rest of that
 * state is not the case's picture.
 */
export function casePair(slot: SlotName, c: F2LCase): Placed {
  const f = state(invert(fullAlg('', c.algs[0]!)));
  const where = new Map<string, number>();
  for (let i = 0; i < 54; i++) where.set(idAt(f, i), i);
  return { slot, corner: where.get(idAt(SOLVED, ref(`D${slot}`)))!, edge: where.get(idAt(SOLVED, ref(slot)))! };
}
/** The other slots the case's own pieces sit in: those are not solved to begin with, so there is nothing to keep. */
export function occupiedSlots(slot: SlotName, c: F2LCase): SlotName[] {
  const pos = new Set([c.corner.slice(1), c.edge]);
  return SLOTS.filter((s) => s !== slot && pos.has(s));
}
/** The slots a case keeps by default: every other one its pieces are not in. */
const others = (slot: SlotName, c: F2LCase) => SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));

const CACHE = new Map<string, string | null>();
/**
 * A case's shortest R/L/U alg from its picture (the sheet's AUF) with the cross and the pairs in `keep` kept (all the
 * others it is not in, by default), in sheet form. Cached.
 */
export function shortestFor(slot: SlotName, c: F2LCase, keep: readonly SlotName[] = others(slot, c)): string | null {
  const kept = keep.filter((s) => others(slot, c).includes(s));
  const k = `${slot}-${c.n}-${[...kept].sort().join('')}`;
  if (!CACHE.has(k)) {
    const found = shortestRLU(casePair(slot, c), kept);
    CACHE.set(k, found === null ? null : asSheetAlg(found));
  }
  return CACHE.get(k)!;
}

/**
 * The case as a whole cube (trainer frame, the sheet's AUF): the pair where the case puts it, the cross and every
 * slot it is not in solved - its shortest all-keeping alg undone.
 */
export function casePicture(slot: SlotName, c: F2LCase): string {
  return state(invert(fullAlg('', shortestFor(slot, c) ?? c.algs[0]!)));
}

/**
 * What an alg of a case leaves undone, from the case's picture: the other slots (not the ones the pair is in) whose
 * pair is off home at the end, and whether the cross is. [] and true for an alg that keeps everything.
 */
export function leftBroken(slot: SlotName, c: F2LCase, alg: string): { slots: SlotName[]; cross: boolean } {
  const end = state(`${invert(fullAlg('', shortestFor(slot, c) ?? c.algs[0]!))} ${fullAlg('', alg)}`);
  return { slots: others(slot, c).filter((s) => !slotSolved(end, s)), cross: crossSolved(edgeState(end)) };
}

/**
 * The fewest R/L/U turns for a case keeping only the pairs in `keep` (the solved ones), when that is shorter than
 * keeping every pair: a shortcut through the open slots, with the slots it leaves disturbed (from the case's
 * picture: what it does to the pieces really in them is theirs to be moved, they are not solved). Null when
 * keeping everything costs nothing more.
 */
export function openSlotShortcut(slot: SlotName, c: F2LCase, keep: readonly SlotName[]): { alg: string; free: SlotName[] } | null {
  const open = shortestFor(slot, c, keep), all = shortestFor(slot, c);
  if (!open || (all && moveCount(fullAlg('', all)) <= moveCount(fullAlg('', open)))) return null;
  const free = leftBroken(slot, c, open).slots;
  return free.length ? { alg: open, free } : null;
}

// The fewest R, L and U turns that solve a pair, keeping the cross and the pairs asked to be kept: what the
// sheet's algs are checked against, so a shorter one is never missed (user, 2026-09-26: case 31 on front-left
// listed only the sheet's 7-move alg; R L' U R' L does it in 5). The sheet is a list of good algs, not a
// proof that none is shorter.
// IDA* on the pieces that matter (the pair, the side cross edges, the kept pairs), everything else free. The
// heuristic is the largest of the kept pairs' pattern tables: one per slot, the distance to home of that slot's
// pair with the two side cross edges (R and L never touch the front and back ones, U none of them; EO is kept
// by every turn in the set). Pure; a table is built once per slot (~330k entries, a byte each).

import { SOLVED, state } from '../cube/state';
import type { F2LCase, SlotName } from './data';
import { moveCount } from '../cube/alg';
import { crossSolved, edgeState } from '../cube/pieces';
import { fullAlg, invert, SLOTS, slotSolved } from './model';
import { idAt, perm, stickersOf } from './ownside';

const MOVES = ['U', "U'", 'U2', 'R', "R'", 'R2', 'L', "L'", 'L2'] as const;
let perms: number[][] | null = null;
const P = () => (perms ??= MOVES.map(perm));

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

const TABLES = new Map<SlotName, Uint8Array>();
/** Distance to home for every place of the slot's pair and the side cross edges, R/L/U only (255: unreachable). */
function table(slot: SlotName): Uint8Array {
  let t = TABLES.get(slot);
  if (t) return t;
  const [c, e] = indices(), p = P();
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
  TABLES.set(slot, t);
  return t;
}

/** Where a slot's pair and the side cross edges sit, as reference-sticker positions: the pieces the search follows. */
export interface Placed { slot: SlotName; corner: number; edge: number }

/**
 * The fewest R, L and U turns that put `pair`'s pieces home with the cross and every pair in `keep` home at the end,
 * the kept pairs and the side cross edges starting home (a kept pair may be lifted on the way; the other slots are
 * free). One of the shortest when there are several; null past `maxDepth`.
 */
export function shortestRLU(pair: Placed, keep: readonly SlotName[], maxDepth = 14): string | null {
  const [c, e] = indices(), p = P();
  const slots = [pair.slot, ...keep.filter((s) => s !== pair.slot)];
  const tabs = slots.map(table);
  /** state: [DR, DL, corner0, edge0, corner1, edge1, ...] */
  const cur = [ref('DR'), ref('DL'), pair.corner, pair.edge, ...slots.slice(1).flatMap((s) => [ref(`D${s}`), ref(s)])];
  const h = (s: number[]) => {
    let m = 0;
    for (let i = 0; i < tabs.length; i++) m = Math.max(m, tabs[i]![tableKey(c, e, s[2 + 2 * i]!, s[3 + 2 * i]!, s[0]!, s[1]!)]!);
    return m;
  };
  const path: number[] = [];
  const dfs = (s: number[], g: number, bound: number, last: number): boolean => {
    const hs = h(s);
    if (hs === 0) return true;
    if (g + hs > bound) return false;
    for (let m = 0; m < MOVES.length; m++) {
      const f = (m / 3) | 0, lf = last < 0 ? -1 : (last / 3) | 0;
      if (f === lf || (f === 1 && lf === 2)) continue; // no face twice; R and L commute, so R never straight after L
      const pm = p[m]!;
      path.push(m);
      if (dfs(s.map((x) => pm[x]!), g + 1, bound, m)) return true;
      path.pop();
    }
    return false;
  };
  const h0 = h(cur);
  if (h0 === 255) return null;
  for (let bound = h0; bound <= maxDepth; bound++) if (dfs(cur, 0, bound, -1)) return path.map((m) => MOVES[m]).join(' ');
  return null;
}

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

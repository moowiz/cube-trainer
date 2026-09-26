// The shortest alg that solves a pair with its own side's turns and U alone (R and U for a right-hand slot, L and U
// for a left-hand one) and never lifts the neighbouring pair on that side into the top layer: what the sheet's
// "borrow a neighbouring slot" algs are measured against (user, 2026-09-26: show it, so the saving is visible).
// A breadth-first search on where the pieces that matter are - the pair, the neighbour's pair, the side's cross edge -
// with the rest of the top layer free. Pure; small (a few thousand states for most cases).

import { facesAt, key, STICKERS } from '../cube/geometry';
import { SOLVED, state } from '../cube/state';
import type { F2LCase, SlotName } from './data';
import { fullAlg, invert, SLOT_WORD } from './model';

/** For a move, where each sticker goes: to[i] = the index sticker i lands on. */
const PERMS = new Map<string, number[]>();
/** A sticker's identity on a facelet string: its cubie's colours and its own. */
const idAt = (f: string, i: number) => `${facesAt(STICKERS[i]!.pos).map((k) => f[k]).sort().join('')}:${f[i]}`;
const HOME = new Map(STICKERS.map((_, i) => [idAt(SOLVED, i), i]));
function perm(move: string): number[] {
  let p = PERMS.get(move);
  if (!p) {
    const f = state(move);
    p = Array<number>(54);
    for (let i = 0; i < 54; i++) p[HOME.get(idAt(f, i))!] = i;
    PERMS.set(move, p);
  }
  return p;
}

/** The sticker indices (at home) of the cubies at these positions. */
const stickersOf = (...names: string[]) => names.flatMap((n) => STICKERS.flatMap((s, i) => (key(s.pos) === key(posOf(n)) ? [i] : [])));
function posOf(name: string): readonly [number, number, number] {
  return [name.includes('R') ? 1 : name.includes('L') ? -1 : 0, name.includes('U') ? 1 : name.includes('D') ? -1 : 0, name.includes('F') ? 1 : name.includes('B') ? -1 : 0];
}

export interface OwnSide { alg: string; moves: number }

/**
 * The shortest own-side alg from `facelets` (trainer frame) that solves `slot`'s pair and leaves the neighbouring pair
 * home without ever lifting it; null when none within `maxDepth` (a piece in a slot on the other side, say).
 */
export function ownSideAlg(facelets: string, slot: SlotName, maxDepth = 16): OwnSide | null {
  const side = slot[1]!, other = (slot[0] === 'F' ? 'B' : 'F') + side;
  const pair = stickersOf(`D${slot}`, slot), nb = stickersOf(`D${other}`, other), cross = stickersOf(`D${side}`);
  const tracked = [...pair, ...nb, ...cross];
  // where each tracked sticker is now, by identity
  const where = new Map<string, number>();
  for (let i = 0; i < 54; i++) where.set(idAt(facelets, i), i);
  const start = tracked.map((h) => where.get(idAt(SOLVED, h))!);
  const goal = tracked.join(',');
  const nbAt = pair.length, nbEnd = pair.length + nb.length;
  const moves = ['U', "U'", 'U2', side, `${side}'`, `${side}2`];
  const perms = moves.map(perm);
  const k0 = start.join(',');
  if (k0 === goal) return { alg: '', moves: 0 };
  const seen = new Map<string, { prev: string; move: number }>([[k0, { prev: '', move: -1 }]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: number[][] = [];
    for (const s of frontier) {
      const ks = s.join(','), last = seen.get(ks)!.move;
      for (let m = 0; m < moves.length; m++) {
        if (last >= 0 && moves[m]![0] === moves[last]![0]) continue;
        const p = perms[m]!, t = s.map((x) => p[x]!);
        let lifted = false;
        for (let j = nbAt; j < nbEnd; j++) if (STICKERS[t[j]!]!.pos[1] === 1) { lifted = true; break; }
        if (lifted) continue;
        const kt = t.join(',');
        if (seen.has(kt)) continue;
        seen.set(kt, { prev: ks, move: m });
        if (kt === goal) {
          const out: string[] = [];
          for (let k = kt; seen.get(k)!.move >= 0; k = seen.get(k)!.prev) out.unshift(moves[seen.get(k)!.move]!);
          return { alg: out.join(' '), moves: out.length };
        }
        next.push(t);
      }
    }
    frontier = next;
  }
  return null;
}

const CACHE = new Map<string, OwnSide | null>();
/**
 * The own-side alg for a case from the position at hand (`auf` the lookup's), the other slots solved: the case's
 * picture at that AUF is set up by its own first alg undone, so the neighbour is home to begin with.
 */
export function ownSideFor(slot: SlotName, c: F2LCase, auf = ''): OwnSide | null {
  const k = `${slot}-${c.n}-${auf}`;
  if (!CACHE.has(k)) CACHE.set(k, ownSideAlg(state(invert(fullAlg(auf, c.algs[0]!))), slot));
  return CACHE.get(k)!;
}
/** Which way the own side turns, and the pair it must not lift: "R and U", "front-right". */
export function ownSideWords(slot: SlotName): { moves: string; neighbour: string } {
  const other = `${slot[0] === 'F' ? 'B' : 'F'}${slot[1]}` as SlotName;
  return { moves: `${slot[1]} and U`, neighbour: SLOT_WORD[other] };
}

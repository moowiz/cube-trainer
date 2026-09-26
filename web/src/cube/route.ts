// Following an alg on a cube (docs/smart-cube-design.md 4.1, the alg half):
// pure functions of a setup (an alg from solved), a route (the alg's
// tokens) and what the cube has done since the setup. The last-layer
// drills and the F2L finder both mark the moves done, call a wrong turn
// and say how to undo it; the bookkeeping lives here once.

import { faceMoves, inverse, mergeMoves, movesStr, tokens } from './alg';
import { frameMap, relabel, type FaceId } from './frame';
import { CENTRE, rawFacelets, state } from './state';

export interface RouteProgress {
  /** moves of the route the cube has made (the earliest prefix that matches: a rotation is not done before it is made) */
  done: number;
  /** a quarter turn into the double turn at index `done` */
  half: boolean;
  /** the cube's state is on the route (a prefix or halfway through one) */
  onRoute: boolean;
}

/** Where `cur` (a facelet string, null when unknown) sits along `route` done from `setup`. */
export function routeProgress(setup: string, route: readonly string[], cur: string | null): RouteProgress {
  if (cur === null) return { done: 0, half: false, onRoute: false };
  const states = [state(setup)];
  for (let i = 1; i <= route.length; i++) states.push(state(`${setup} ${route.slice(0, i).join(' ')}`));
  const k = states.indexOf(cur);
  if (k >= 0) return { done: k, half: false, onRoute: true };
  for (let i = 0; i < route.length; i++) {
    const m = route[i]!;
    if (!m.endsWith('2')) continue;
    const before = `${setup} ${route.slice(0, i).join(' ')}`;
    if (state(`${before} ${m[0]}`) === cur || state(`${before} ${m[0]}'`) === cur) return { done: i, half: true, onRoute: true };
  }
  return { done: 0, half: false, onRoute: false };
}

/**
 * The moves done (`text`, from `setup`) after the last of them that left the cube on `route`: the
 * wrong turns, in order, and `at`, the route index of the state they left from.
 */
export function offRoute(setup: string, route: readonly string[], text: string): { bad: string[]; at: number } {
  let toks: string[];
  try { toks = tokens(text); } catch { return { bad: [], at: 0 }; }
  const onIt = new Map<string, number>();
  for (let i = route.length; i >= 0; i--) onIt.set(state(`${setup} ${route.slice(0, i).join(' ')}`), i); // the earliest index wins
  for (let k = toks.length; k >= 0; k--) { const i = onIt.get(state(`${setup} ${toks.slice(0, k).join(' ')}`)); if (i !== undefined) return { bad: toks.slice(k), at: i }; }
  return { bad: toks, at: 0 };
}

/**
 * The cube's fixed letters (what a smart cube reports) as the letters of the frame the route's rotations
 * up to index `at` leave the cube in: after an x, the user's "U" is the cube's F. Identity without rotations.
 */
export function inHand(route: readonly string[], at: number, alg: string): string {
  const rots = route.slice(0, at).filter((m) => /^[xyz]/.test(m));
  if (!rots.length) return alg;
  const raw = rawFacelets(rots.join(' '));
  return relabel(alg, frameMap(raw[CENTRE.D!]! as FaceId, raw[CENTRE.F!]! as FaceId));
}

// a middle-slice turn reaches the cube as its two outer layers the other way (M = L' R, the core turning with the
// slice), each as quarter turns
const SLICE_OF_PAIR: Record<string, string> = {
  "L' R": 'M', "R L'": 'M', "L R'": "M'", "R' L": "M'", 'L2 R2': 'M2', 'R2 L2': 'M2',
  "F' B": 'S', "B F'": 'S', "F B'": "S'", "B' F": "S'", 'F2 B2': 'S2', 'B2 F2': 'S2',
  "D' U": 'E', "U D'": 'E', "D U'": "E'", "U' D": "E'", 'D2 U2': 'E2', 'U2 D2': 'E2',
};
/** Adjacent outer-layer pairs that are a slice (L' R -> M), the rest as they are. */
export function foldSlices(moves: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    const pair = i + 1 < moves.length ? SLICE_OF_PAIR[`${moves[i]} ${moves[i + 1]}`] : undefined;
    if (pair) { out.push(pair); i++; } else out.push(moves[i]!);
  }
  return out;
}

/** The turns as said and shown: consecutive turns of one face merged (R R -> R2), or as given when one is not a face turn. */
export function offList(turns: readonly string[]): string[] {
  const fm = faceMoves(turns.join(' '));
  return fm ? movesStr(mergeMoves(fm)).split(' ').filter(Boolean) : turns.slice();
}

/**
 * The wrong turns (`bad`, the cube's letters, as offRoute lists them) and their undo, both in the letters of the
 * hand's frame at route index `at`, slices folded back: what to show and say when the cube is off the alg.
 */
export function wrongTurns(route: readonly string[], at: number, bad: readonly string[]): { bad: string[]; undo: string[] } {
  const b = foldSlices(tokens(inHand(route, at, offList(bad).join(' '))));
  return { bad: b, undo: b.length ? foldSlices(tokens(inverse(b.join(' ')))) : [] };
}

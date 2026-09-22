// Recognition features of a PLL case, read off its facelet string: how the
// corners and edges are permuted (as cycle types) and what the four sides
// show (a bar of three, headlights, a bar of two, nothing). All of it is
// the same in every AUF, so a case has one set of features whichever way
// the layer is turned. The reference sheet filters and tags cases by them.

import { inverse } from '../cube/alg';
import { faceColorName } from '../cube/scheme';
import { aufToSolve, state } from '../cube/state';
import type { LLCase } from './cases';
import { pllArrows } from './model';

type CornerPerm = 'solved' | '3-cycle' | 'adjacent swap' | 'diagonal swap' | 'two swaps';
type EdgePerm = 'solved' | '3-cycle' | 'adjacent swap' | 'opposite swap' | 'two swaps';
interface Sides { bar3: number; headlights: number; bar2: number; none: number }
export interface Features { corners: CornerPerm; edges: EdgePerm; sides: Sides }

// the four side strips of the top layer, left to right as seen from that side (Kociemba indices)
const STRIPS = [[47, 46, 45], [11, 10, 9], [18, 19, 20], [36, 37, 38]];

/** Features of the state `f` (a PLL: corners oriented), or null when it is not one. */
export function features(f: string): Features | null {
  const arrows = pllArrows(f);
  if (!arrows) return null;
  const corner = (p: readonly number[]) => p[0] !== 0 && p[2] !== 0;
  const cornerArrows = arrows.filter((a) => corner(a.from)), edgeArrows = arrows.filter((a) => !corner(a.from));
  const isSwap = (a: { from: readonly number[]; to: readonly number[] }) => arrows.some((b) => b.from[0] === a.to[0] && b.from[2] === a.to[2] && b.to[0] === a.from[0] && b.to[2] === a.from[2]);
  // corners: a 2-cycle between neighbours (one coordinate differs) or across the diagonal (both)
  let corners: CornerPerm;
  if (cornerArrows.length === 0) corners = 'solved';
  else if (cornerArrows.length === 3) corners = '3-cycle';
  else if (cornerArrows.length === 2) corners = cornerArrows[0]!.from[0] !== cornerArrows[0]!.to[0] && cornerArrows[0]!.from[2] !== cornerArrows[0]!.to[2] ? 'diagonal swap' : 'adjacent swap';
  else corners = cornerArrows.every(isSwap) ? 'two swaps' : '3-cycle'; // a 4-cycle would be illegal with the edges here
  // edges: a 2-cycle between neighbours (both coordinates change) or across (one flips sign)
  let edges: EdgePerm;
  if (edgeArrows.length === 0) edges = 'solved';
  else if (edgeArrows.length === 3) edges = '3-cycle';
  else if (edgeArrows.length === 2) edges = edgeArrows[0]!.from[0] === -edgeArrows[0]!.to[0] && edgeArrows[0]!.from[2] === -edgeArrows[0]!.to[2] ? 'opposite swap' : 'adjacent swap';
  else edges = edgeArrows.every(isSwap) ? 'two swaps' : '3-cycle';
  const sides: Sides = { bar3: 0, headlights: 0, bar2: 0, none: 0 };
  for (const [a, b, c] of STRIPS) {
    const l = f[a!], m = f[b!], r = f[c!];
    if (l === m && m === r) sides.bar3++;
    else if (l === r) sides.headlights++;
    else if (l === m || m === r) sides.bar2++;
    else sides.none++;
  }
  return { corners, edges, sides };
}

// the side strips left to right AS SEEN FROM THAT SIDE (F1 F2 F3; R1 R2 R3 runs front to back, seen from the right
// the front is on your left; B1 B2 B3 runs from the right side; L1 L2 L3 from the back)
const SEEN: { where: string; strip: number[] }[] = [
  { where: 'facing you', strip: [18, 19, 20] }, { where: 'on your right', strip: [9, 10, 11] }, { where: 'at the back', strip: [45, 46, 47] }, { where: 'on your left', strip: [36, 37, 38] },
];
type Pattern = 'bar3' | 'headlights' | 'bar2' | 'none';
const patternOf = (f: string, [a, b, c]: number[]): Pattern => { const l = f[a!], m = f[b!], r = f[c!]; return l === m && m === r ? 'bar3' : l === r ? 'headlights' : l === m || m === r ? 'bar2' : 'none'; };

/**
 * Where to hold the case for its alg (the hints say what to look for from any angle; the alg
 * needs one): the one bar of three or the one side of headlights and where it is, the two bars
 * of two, else the front's three colours in the current scheme. With a note when the alg works
 * from more than one angle.
 */
export function algAngle(c: LLCase): string {
  const f = state(inverse(c.alg));
  const angles = ['', 'U', 'U2', "U'"].filter((k) => aufToSolve(`${inverse(c.alg)} ${k} ${c.alg}`) !== null).length;
  if (angles === 4) return 'from any side';
  const sides = SEEN.map((s) => ({ where: s.where, pat: patternOf(f, s.strip) }));
  const only = (p: Pattern) => { const hits = sides.filter((s) => s.pat === p); return hits.length === 1 ? hits[0]! : null; };
  const also = angles === 2 ? ' (or the opposite side)' : '';
  const bar3 = only('bar3'), head = only('headlights');
  if (bar3) return `the bar of three ${bar3.where}${also}`;
  if (head) return `the headlights ${head.where}${also}`;
  const bars = sides.filter((s) => s.pat === 'bar2');
  if (bars.length === 2) return `the bars of two ${bars[0]!.where} and ${bars[1]!.where}${also}`;
  const [a, b, d] = SEEN[0]!.strip.map((i) => faceColorName(f[i]!));
  return `the side facing you reads ${a}, ${b}, ${d} left to right${also}`;
}

// Recognition features of a PLL case, read off its facelet string: how the
// corners and edges are permuted (as cycle types) and what the four sides
// show (a bar of three, headlights, a bar of two, nothing). All of it is
// the same in every AUF, so a case has one set of features whichever way
// the layer is turned. The reference sheet filters and tags cases by them.

import { pllArrows } from './model';

export type CornerPerm = 'solved' | '3-cycle' | 'adjacent swap' | 'diagonal swap' | 'two swaps';
export type EdgePerm = 'solved' | '3-cycle' | 'adjacent swap' | 'opposite swap' | 'two swaps';
export interface Sides { bar3: number; headlights: number; bar2: number; none: number }
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

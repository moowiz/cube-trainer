// Last-layer case tables for ZZ: after EOCross and F2L the edges are already
// oriented, so the last layer is OCLL (orient the corners, 7 cases) then PLL
// (21 cases). Each alg is verified by test/ll.test.ts: applied to a solved
// cube it must keep F2L and edge orientation, and the 7 (21) cases must be
// distinct up to AUF. The case a drill shows is the INVERSE of its alg, so
// the alg listed always solves it. The hints hold in every AUF: they were
// checked against the sides of each case (bar of three, headlights, bar of
// two, nothing) and say where things are relative to the distinctive one.
// "Seen from a side" reads left to right facing that side: R1 is the front
// end of the right face, B1 the right end of the back, L1 the back end of
// the left (test/ll.test.ts checks Ja / Jb's block end this way; the J
// hints had it mirrored until 2026-09-21).

export type LLKind = 'ocll' | 'pll';

export interface LLCase {
  id: string;
  name: string;
  /** the standard alg that solves the case */
  alg: string;
  /** what to look for */
  hint: string;
}

export const OCLL_CASES: LLCase[] = [
  { id: 'S', name: 'Sune', alg: "R U R' U R U2 R'", hint: 'one corner has yellow on top. Turn the top layer so it sits front-left: the front face then shows a yellow sticker at its top-right (the other two yellows are on the right and back faces)' },
  { id: 'AS', name: 'Anti-Sune', alg: "R U2 R' U' R U' R'", hint: 'one corner has yellow on top. Turn the top layer so it sits front-left: the front face then shows no yellow; the yellow sits at the front end of the right face (and on the back and left faces)' },
  { id: 'H', name: 'H', alg: "R U2 R' U' R U R' U' R U' R'", hint: 'no corner oriented; yellow headlights on two opposite sides' },
  { id: 'Pi', name: 'Pi', alg: "R U2 R2 U' R2 U' R2 U2 R", hint: 'no corner oriented; yellow headlights on one side, nothing on the far side, and the two other yellows on the sides in between, at their far ends' },
  { id: 'U', name: 'U (headlights)', alg: "R2 D R' U2 R D' R' U2 R'", hint: 'two adjacent corners oriented; the other two show yellow headlights on the side they share' },
  { id: 'T', name: 'T', alg: "r U R' U' r' F R F'", hint: 'two adjacent corners oriented; face the other two: their yellows point left and right, none toward you' },
  { id: 'L', name: 'L (bowtie)', alg: "F' r U R' U' r' F R", hint: 'two diagonal corners oriented' },
];

export const PLL_CASES: LLCase[] = [
  { id: 'Aa', name: 'Aa', alg: "x R' U R' D2 R U' R' D2 R2 x'", hint: 'three corners cycle: headlights on one side, and a 2x2 block (a corner with both its edges) elsewhere. Face the headlights: the block is on the side to your right, at its far end' },
  { id: 'Ab', name: 'Ab', alg: "x R2 D2 R U R' D2 R U' R x'", hint: 'three corners cycle: headlights on one side, and a 2x2 block (a corner with both its edges) elsewhere. Face the headlights: the block is on the side to your left, at its far end' },
  { id: 'E', name: 'E', alg: "x' R U' R' D R U R' D' R U R' D R U' R' D' x", hint: 'every side shows three different colours: no headlights, no bars. The corners swap in two pairs' },
  { id: 'F', name: 'F', alg: "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", hint: 'one bar of three and nothing else: the other three sides show three colours each' },
  { id: 'Ga', name: 'Ga', alg: "R2 U R' U R' U' R U' R2 U' D R' U R D'", hint: 'headlights and one bar of two. Face the headlights: the bar is on the side to your right, at its far end' },
  { id: 'Gb', name: 'Gb', alg: "R' U' R U D' R2 U R' U R U' R U' R2 D", hint: 'headlights and one bar of two. Face the headlights: the bar is on the far side, toward your left' },
  { id: 'Gc', name: 'Gc', alg: "R2 U' R U' R U R' U R2 U D' R U' R' D", hint: 'headlights and one bar of two. Face the headlights: the bar is on the side to your left, at its far end' },
  { id: 'Gd', name: 'Gd', alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'", hint: 'headlights and one bar of two. Face the headlights: the bar is on the far side, toward your right' },
  { id: 'H', name: 'H', alg: 'M2 U M2 U2 M2 U M2', hint: 'headlights on all four sides, every edge opposite its colour' },
  { id: 'Ja', name: 'Ja', alg: "L' U' L F L' U' L U L F' L2 U L", hint: 'a bar of three with a 2x2 block at one end (the corner there matches the edge on the next side too). Face the bar of three: the block is at its right end. The other three sides each show a bar of two' },
  { id: 'Jb', name: 'Jb', alg: "R U R' F' R U R' U' R' F R2 U' R'", hint: 'a bar of three with a 2x2 block at one end (the corner there matches the edge on the next side too). Face the bar of three: the block is at its left end. The other three sides each show a bar of two' },
  { id: 'Na', name: 'Na', alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", hint: 'a bar of two on every side, on your right as you face it; diagonal corners and opposite edges swap' },
  { id: 'Nb', name: 'Nb', alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R", hint: 'a bar of two on every side, on your left as you face it; diagonal corners and opposite edges swap' },
  { id: 'Ra', name: 'Ra', alg: "R U' R' U' R U R D R' U' R D' R' U2 R'", hint: 'headlights and one bar of two. Face the headlights: the bar is on the side to your right, at the end nearest you' },
  { id: 'Rb', name: 'Rb', alg: "R' U2 R U2 R' F R U R' U' R' F' R2", hint: 'headlights and one bar of two. Face the headlights: the bar is on the side to your left, at the end nearest you' },
  { id: 'T', name: 'T', alg: "R U R' U' R' F R2 U' R' U' R U R' F'", hint: 'headlights, with a bar of two on each of the two sides next to them, both at the end nearest the headlights; the far side shows nothing' },
  { id: 'Ua', name: 'Ua', alg: 'M2 U M U2 M\' U M2', hint: 'one bar of three, headlights on the other three sides; the three edges cycle counter-clockwise seen from above' },
  { id: 'Ub', name: 'Ub', alg: "M2 U' M U2 M' U' M2", hint: 'one bar of three, headlights on the other three sides; the three edges cycle clockwise seen from above' },
  { id: 'V', name: 'V', alg: "R' U R' U' y R' F' R2 U' R' U R' F R F", hint: 'diagonal corner swap; two bars of two meeting at one corner (a 2x2 block with the centre), nothing else' },
  { id: 'Y', name: 'Y', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", hint: 'diagonal corner swap; two bars of two on adjacent sides that do not share a corner' },
  { id: 'Z', name: 'Z', alg: "M' U M2 U M2 U M' U2 M2", hint: 'headlights on all four sides; the edges swap with their neighbours, in two pairs' },
];

export const CASES: Record<LLKind, LLCase[]> = { ocll: OCLL_CASES, pll: PLL_CASES };

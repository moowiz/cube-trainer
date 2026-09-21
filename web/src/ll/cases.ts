// Last-layer case tables for ZZ: after EOCross and F2L the edges are already
// oriented, so the last layer is OCLL (orient the corners, 7 cases) then PLL
// (21 cases). Each alg is verified by test/ll.test.ts: applied to a solved
// cube it must keep F2L and edge orientation, and the 7 (21) cases must be
// distinct up to AUF. The case a drill shows is the INVERSE of its alg, so
// the alg listed always solves it. The PLL hints hold in every AUF and each
// one's FIRST sentence tells the case from all twenty others: test/ll.test.ts
// encodes every hint as a predicate on the sides (bar of three, headlights,
// bar of two and its end, nothing, and which side an edge's colour belongs
// to) and checks it holds for its case and fails for the rest.
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
  /** other algs for the case, each verified by test; `note` says how it is built from blocks (user, 2026-09-21: blocks are what get memorised) */
  alts?: { alg: string; note: string }[];
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
  { id: 'Aa', name: 'Aa', alg: "x R' U R' D2 R U' R' D2 R2 x'", hint: 'headlights on one side and a 2x2 block (a corner with both its edges) at the far right: face the headlights, the block is on the side to your right, at its far end. Three corners cycle', alts: [{ alg: "R' F R' B2 R F' R' B2 R2", note: 'the same commutator with F and B instead of a rotation: R\' F R\', B2, undo, B2, R2' }] },
  { id: 'Ab', name: 'Ab', alg: "x R2 D2 R U R' D2 R U' R x'", hint: 'headlights on one side and a 2x2 block (a corner with both its edges) at the far left: face the headlights, the block is on the side to your left, at its far end. Three corners cycle', alts: [{ alg: "R B' R F2 R' B R F2 R2", note: 'the mirror of Aa\'s F/B version' }] },
  { id: 'E', name: 'E', alg: "x' R U' R' D R U R' D' R U R' D R U' R' D' x", hint: 'no headlights and no bars at all: every side shows three different colours. The corners swap in two pairs', alts: [{ alg: "R2 U R' U' y R U R' U' R U R' U' R U R' y' R U' R2", note: 'R2 U R\' U\', y, then sexy twice and R U R\', then y\' R U\' R2' }, { alg: "z U2 R2 F R U R' U' R U R' U' R U R' U' F' R2 U2 z'", note: 'z U2 R2, then F, sexy three times, F\', then R2 U2 z\'' }] },
  { id: 'F', name: 'F', alg: "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", hint: 'one bar of three and nothing else: the other three sides show three colours each', alts: [{ alg: "R' U R U' R2 F' U' F U R F R' F' R2 U'", note: 'R\' U R U\' R2, then F\' U\' F U (reverse sexy on F), R F R\' F\', R2 U\'' }] },
  { id: 'Ga', name: 'Ga', alg: "R2 U R' U R' U' R U' R2 U' D R' U R D'", hint: 'headlights and one bar of two, on the side to your right at its far end (face the headlights)', alts: [{ alg: "R2 u R' U R' U' R u' R2 y' R' U R", note: 'R2 u, then R\' U R\' U\' R, then u\' R2; a y\' and R\' U R to finish' }] },
  { id: 'Gb', name: 'Gb', alg: "R' U' R U D' R2 U R' U R U' R U' R2 D", hint: 'headlights and one bar of two, on the far side toward your left (face the headlights)', alts: [{ alg: "R' U' R y R2 u R' U R U' R u' R2", note: 'R\' U\' R, y, then R2 u, R\' U R U\' R, u\' R2' }] },
  { id: 'Gc', name: 'Gc', alg: "R2 U' R U' R U R' U R2 U D' R U' R' D", hint: 'headlights and one bar of two, on the side to your left at its far end (face the headlights)', alts: [{ alg: "R2 u' R U' R U R' u R2 y R U' R'", note: 'R2 u\', then R U\' R U R\', then u R2; a y and R U\' R\' to finish' }] },
  { id: 'Gd', name: 'Gd', alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'", hint: 'headlights and one bar of two, on the far side toward your right (face the headlights)', alts: [{ alg: "R U R' y' R2 u' R U' R' U R' u R2", note: 'R U R\', y\', then R2 u\', R U\' R\' U R\', u R2' }] },
  { id: 'H', name: 'H', alg: 'M2 U M2 U2 M2 U M2', hint: 'headlights on all four sides, every edge the opposite side\'s colour', alts: [{ alg: "R2 U2 R U2 R2 U2 R2 U2 R U2 R2", note: 'R2 U2 R U2 R2 U2, then the same backwards: a palindrome' }] },
  { id: 'Ja', name: 'Ja', alg: "L' U' L F L' U' L U L F' L2 U L", hint: 'a bar of three with a 2x2 block at its right end (face the bar of three: the corner on your right matches the next side\'s edge too). The other three sides each show a bar of two', alts: [{ alg: "R' U L' U2 R U' R' U2 R L", note: 'ten moves: R\' U L\' U2 R U\' R\' U2 R L - the R and L moves alternate' }, { alg: "L U' R' U L' U2 R U' R' U2 R", note: 'the mirror of the R U2 R\' Jb: L U\' R\' U L\' U2, then R U\' R\' U2 R' }] },
  { id: 'Jb', name: 'Jb', alg: "R U R' F' R U R' U' R' F R2 U' R'", hint: 'a bar of three with a 2x2 block at its left end (face the bar of three: the corner on your left matches the next side\'s edge too). The other three sides each show a bar of two', alts: [{ alg: "R U2 R' U' R U2 L' U R' U' L", note: 'R U2 R\', U\', R U2, then L\' U R\' U\' L' }] },
  { id: 'Na', name: 'Na', alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", hint: 'a bar of two on every side, at the right end as you face each; diagonal corners and opposite edges swap', alts: [{ alg: "L U' R U2 L' U R' L U' R U2 L' U R'", note: 'one block twice: L U\' R U2 L\' U R\', again' }, { alg: "z U R' D R2 U' R D' U R' D R2 U' R D' z'", note: 'in a z: U R\' D R2 U\' R D\', twice' }] },
  { id: 'Nb', name: 'Nb', alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R", hint: 'a bar of two on every side, at the left end as you face each; diagonal corners and opposite edges swap', alts: [{ alg: "R' U L' U2 R U' L R' U L' U2 R U' L", note: 'one block twice: R\' U L\' U2 R U\' L, again' }, { alg: "z D' R U' R2 D R' U D' R U' R2 D R' U z'", note: 'in a z: D\' R U\' R2 D R\' U, twice' }] },
  { id: 'Ra', name: 'Ra', alg: "R U' R' U' R U R D R' U' R D' R' U2 R'", hint: 'headlights and one bar of two, on the side to your right at the end nearest you (face the headlights)', alts: [{ alg: "L U2 L' U2 L F' L' U' L U L F L2", note: 'the mirror of Rb: L U2 L\' U2, then L F\' (left sexy) L F L2' }] },
  { id: 'Rb', name: 'Rb', alg: "R' U2 R U2 R' F R U R' U' R' F' R2", hint: 'headlights and one bar of two, on the side to your left at the end nearest you (face the headlights)', alts: [{ alg: "R' U2 R' D' R U' R' D R U R U' R' U' R", note: 'R\' U2, then the commutator R\' D\' R U\' R\' D R (R\' D\' R under U\'), then U R U\' R\' U\' R' }] },
  { id: 'T', name: 'T', alg: "R U R' U' R' F R2 U' R' U' R U R' F'", hint: 'headlights with a bar of two on each side next to them, both at the end touching the headlights; the far side shows nothing', alts: [{ alg: "F R U' R' U R U R2 F' R U R U' R'", note: 'F, then R U\' R\' U R U R2, F\', then R U R U\' R\'' }] },
  { id: 'Ua', name: 'Ua', alg: "R U' R U R U R U' R' U' R2", hint: 'a bar of three and headlights on the other three sides, the edges cycling counter-clockwise seen from above: face the bar, the edge on your left belongs on your right', alts: [{ alg: "M2 U M U2 M' U M2", note: 'with the M slice: M2 U M U2 M\' U M2' }, { alg: "F2 U' L R' F2 L' R U' F2", note: 'Allan (Lars Petrus\'s name for it): F2 U\', both hands (L R\'), F2, both hands back (L\' R), U\' F2' }] },
  { id: 'Ub', name: 'Ub', alg: "R2 U R U R' U' R' U' R' U R'", hint: 'a bar of three and headlights on the other three sides, the edges cycling clockwise seen from above: face the bar, the edge on your right belongs on your left', alts: [{ alg: "M2 U' M U2 M' U' M2", note: 'with the M slice: M2 U\' M U2 M\' U\' M2' }, { alg: "F2 U L R' F2 L' R U F2", note: 'Allan backwards: F2 U, both hands (L R\'), F2, both hands back (L\' R), U F2' }] },
  { id: 'V', name: 'V', alg: "R' U R' U' y R' F' R2 U' R' U R' F R F", hint: 'two bars of two meeting at one corner (a 2x2 block) and nothing else; diagonal corners swap', alts: [{ alg: "R U' R U R' D R D' R U' D R2 U R2 D' R2", note: 'R U\' R U R\', then R D R D\' R U\' D (a D pattern), R2 U R2 D\' R2' }] },
  { id: 'Y', name: 'Y', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", hint: 'two bars of two on adjacent sides that do not share a corner, and nothing else; diagonal corners swap', alts: [{ alg: "F R' F R2 U' R' U' R U R' F' R U R' U' F'", note: 'F R\' F R2 U\' R\' U\' R U R\' F\', then sexy, F\'' }] },
  { id: 'Z', name: 'Z', alg: "M' U M2 U M2 U M' U2 M2", hint: 'headlights on all four sides, every edge a neighbouring side\'s colour (the edges swap in two adjacent pairs)', alts: [{ alg: "R' U' R2 U R U R' U' R U R U' R U' R'", note: 'no slices: R\' U\' R2 U R U R\' U\' R U R U\' R U\' R\'' }] },
];

export const CASES: Record<LLKind, LLCase[]> = { ocll: OCLL_CASES, pll: PLL_CASES };

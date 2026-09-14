// Last-layer case tables for ZZ: after EOCross and F2L the edges are already
// oriented, so the last layer is OCLL (orient the corners, 7 cases) then PLL
// (21 cases). Each alg is verified by test/ll.test.ts: applied to a solved
// cube it must keep F2L and edge orientation, and the 7 (21) cases must be
// distinct up to AUF. The case a drill shows is the INVERSE of its alg, so
// the alg listed always solves it.

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
  { id: 'S', name: 'Sune', alg: "R U R' U R U2 R'", hint: 'one corner oriented, its neighbours show yellow on the left' },
  { id: 'AS', name: 'Anti-Sune', alg: "R U2 R' U' R U' R'", hint: 'one corner oriented, its neighbours show yellow on the right' },
  { id: 'H', name: 'H', alg: "R U2 R' U' R U R' U' R U' R'", hint: 'no corner oriented, two yellow bars on opposite sides' },
  { id: 'Pi', name: 'Pi', alg: "R U2 R2 U' R2 U' R2 U2 R", hint: 'no corner oriented, one bar of yellow and two singles on the opposite side' },
  { id: 'U', name: 'U (headlights)', alg: "R2 D R' U2 R D' R' U2 R'", hint: 'two adjacent corners oriented, headlights facing you on the other two' },
  { id: 'T', name: 'T', alg: "r U R' U' r' F R F'", hint: 'two adjacent corners oriented, the other two show yellow left and right' },
  { id: 'L', name: 'L (bowtie)', alg: "F' r U R' U' r' F R", hint: 'two diagonal corners oriented' },
];

export const PLL_CASES: LLCase[] = [
  { id: 'Aa', name: 'Aa', alg: "x R' U R' D2 R U' R' D2 R2 x'", hint: 'three corners cycle, headlights on the left' },
  { id: 'Ab', name: 'Ab', alg: "x R2 D2 R U R' D2 R U' R x'", hint: 'three corners cycle, headlights on the right' },
  { id: 'E', name: 'E', alg: "x' R U' R' D R U R' D' R U R' D R U' R' D' x", hint: 'all four corners swap, no headlights anywhere' },
  { id: 'F', name: 'F', alg: "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", hint: 'one bar of three, the opposite side has a corner swap' },
  { id: 'Ga', name: 'Ga', alg: "R2 U R' U R' U' R U' R2 U' D R' U R D'", hint: 'headlights on the left with the matching edge next to them' },
  { id: 'Gb', name: 'Gb', alg: "R' U' R U D' R2 U R' U R U' R U' R2 D", hint: 'headlights on the right, the odd edge in front' },
  { id: 'Gc', name: 'Gc', alg: "R2 U' R U' R U R' U R2 U D' R U' R' D", hint: 'headlights on the right with the matching edge next to them' },
  { id: 'Gd', name: 'Gd', alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'", hint: 'headlights on the left, the odd edge in front' },
  { id: 'H', name: 'H', alg: 'M2 U M2 U2 M2 U M2', hint: 'every edge opposite; all four sides have matching corners' },
  { id: 'Ja', name: 'Ja', alg: "L' U' L F L' U' L U L F' L2 U L", hint: 'a bar of three on the left, corner and edge swap on the right' },
  { id: 'Jb', name: 'Jb', alg: "R U R' F' R U R' U' R' F R2 U' R'", hint: 'a bar of three on the right, corner and edge swap on the left' },
  { id: 'Na', name: 'Na', alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", hint: 'diagonal corners and two opposite edges swap; bars of two on the left' },
  { id: 'Nb', name: 'Nb', alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R", hint: 'diagonal corners and two opposite edges swap; bars of two on the right' },
  { id: 'Ra', name: 'Ra', alg: "R U' R' U' R U R D R' U' R D' R' U2 R'", hint: 'headlights with a bar of two elsewhere; the odd edge on the left' },
  { id: 'Rb', name: 'Rb', alg: "R' U2 R U2 R' F R U R' U' R' F' R2", hint: 'headlights with a bar of two elsewhere; the odd edge on the right' },
  { id: 'T', name: 'T', alg: "R U R' U' R' F R2 U' R' U' R U R' F'", hint: 'headlights, and a bar of two opposite them' },
  { id: 'Ua', name: 'Ua', alg: 'M2 U M U2 M\' U M2', hint: 'three edges cycle counter-clockwise, one side solved' },
  { id: 'Ub', name: 'Ub', alg: "M2 U' M U2 M' U' M2", hint: 'three edges cycle clockwise, one side solved' },
  { id: 'V', name: 'V', alg: "R' U R' U' y R' F' R2 U' R' U R' F R F", hint: 'diagonal corner swap with a bar of two on two sides' },
  { id: 'Y', name: 'Y', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", hint: 'diagonal corner swap with no bars of two' },
  { id: 'Z', name: 'Z', alg: "M' U M2 U M2 U M' U2 M2", hint: 'adjacent edges swap in pairs; all four sides have matching corners' },
];

export const CASES: Record<LLKind, LLCase[]> = { ocll: OCLL_CASES, pll: PLL_CASES };

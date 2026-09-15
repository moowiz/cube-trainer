// Which ZZ stage a cube is at, read straight off a cubejs/Kociemba facelet
// string, with the piece tables of cube/pieces.ts.

import { CORNER_POS, EDGE_POS, cubieSolved, eoCoord } from './cube/pieces';
//
// `facelets` must already be in the TRAINER's frame: white is D, the EO
// axis is F/B. Centres are in place, so a letter is a colour.

export type Stage = 'eo' | 'f2l' | 'ocll' | 'pll' | 'solved';

export interface StageReport {
  stage: Stage;
  /** edges not oriented to the F/B axis (0..12) */
  eoBad: number;
  /** white-cross edges solved (0..4) */
  cross: number;
  /** F2L slots (corner + edge) solved (0..4) */
  pairs: number;
  /** every U-face sticker is U (corners of the last layer oriented) */
  ocll: boolean;
}


const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
// the white edges' slots (DF DR DB DL) and, per F2L slot, the middle-layer edge and the white corner under it
const CROSS = [4, 5, 6, 7];
const SLOTS: { edge: number; corner: number }[] = [
  { edge: 8, corner: 4 },  // FR + DFR
  { edge: 9, corner: 5 },  // FL + DLF
  { edge: 11, corner: 6 }, // BL + DBL
  { edge: 10, corner: 7 }, // BR + DRB
];
const popcount = (v: number): number => { let n = 0; for (; v; v &= v - 1) n++; return n; };

export function stageOf(facelets: string): StageReport {
  if (!/^[URFDLB]{54}$/.test(facelets)) {
    throw new Error(`not a 54-letter URFDLB facelet string: ${JSON.stringify(facelets)}`);
  }

  const eoBad = popcount(eoCoord(facelets));
  const cross = CROSS.filter((slot) => cubieSolved(facelets, EDGE_POS[slot])).length;
  const pairs = SLOTS.filter(({ edge, corner }) => cubieSolved(facelets, EDGE_POS[edge]) && cubieSolved(facelets, CORNER_POS[corner])).length;
  const ocll = facelets.slice(0, 9) === 'UUUUUUUUU';

  let stage: Stage;
  if (eoBad > 0 || cross < 4) stage = 'eo';
  else if (pairs < 4) stage = 'f2l';
  else if (!ocll) stage = 'ocll';
  else if (facelets !== SOLVED) stage = 'pll';
  else stage = 'solved';

  return { stage, eoBad, cross, pairs, ocll };
}

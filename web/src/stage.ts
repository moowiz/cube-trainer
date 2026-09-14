// Which ZZ stage a cube is at, read straight off a cubejs/Kociemba facelet
// string. Pure string indexing - no cube library needed here (cubejs only
// shows up in the tests, to build sample states).
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

const FACES = 'URFDLB'; // index -> letter: face = FACES[floor(idx/9)]
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** The face a facelet position belongs to (U1..U9 = 0..8, R1..R9 = 9..17, ...). */
function faceOf(i: number): string {
  return FACES[Math.floor(i / 9)];
}

/** True iff the sticker at `i` shows the letter of the face it sits on. */
function solvedAt(facelets: string, i: number): boolean {
  return facelets[i] === faceOf(i);
}

// U/D-layer edges as [home, other]: `home` is the position structurally on
// the U or D face. Order: UR UF UL UB DR DF DL DB.
const UD_EDGES: [number, number][] = [
  [5, 10], [7, 19], [3, 37], [1, 46], // UR UF UL UB
  [32, 16], [28, 25], [30, 43], [34, 52], // DR DF DL DB
];
// E-layer edges as [home, other]: `home` is the position on the F or B
// face - FR FL BL BR never touch U or D. Order: FR FL BL BR.
const E_EDGES: [number, number][] = [
  [23, 12], [21, 41], [50, 39], [48, 14],
];

/**
 * An edge is oriented (to the F/B axis) iff its "primary" sticker - the one
 * currently showing U/D if either does, else the one showing F/B - sits at
 * `home`. For a U/D-layer edge `home` is the U/D-face position, so this is
 * the usual "is the U/D colour on the U/D face" EO check; for an E-layer
 * edge `home` is the F/B-face position, so it asks the same question about
 * the F/B colour instead. Expressed on facelet positions, not tracked cubie
 * identity, per the design note above.
 */
function edgeOriented(facelets: string, home: number, other: number): boolean {
  const a = facelets[home];
  const b = facelets[other];
  const isUD = (c: string) => c === 'U' || c === 'D';
  if (isUD(a) || isUD(b)) return isUD(a); // primary is whichever shows U/D
  return a === 'F' || a === 'B'; // neither shows U/D: primary is the F/B one
}

// F2L slots: an E-layer edge paired with the corner underneath it, each as
// facelet positions. FR+DFR, FL+DLF, BL+DBL, BR+DRB.
const SLOTS: { edge: [number, number]; corner: [number, number, number] }[] = [
  { edge: [23, 12], corner: [29, 26, 15] }, // FR + DFR (D3,F9,R7)
  { edge: [21, 41], corner: [27, 44, 24] }, // FL + DLF (D1,L9,F7)
  { edge: [50, 39], corner: [33, 53, 42] }, // BL + DBL (D7,B9,L7)
  { edge: [48, 14], corner: [35, 17, 51] }, // BR + DRB (D9,R9,B7)
];

// Cross edges DR DF DL DB, each [D-face position, side position].
const CROSS_EDGES: [number, number][] = [[32, 16], [28, 25], [30, 43], [34, 52]];

export function stageOf(facelets: string): StageReport {
  if (!/^[URFDLB]{54}$/.test(facelets)) {
    throw new Error(`not a 54-letter URFDLB facelet string: ${JSON.stringify(facelets)}`);
  }

  const eoBad = [...UD_EDGES, ...E_EDGES].filter(([h, o]) => !edgeOriented(facelets, h, o)).length;
  const cross = CROSS_EDGES.filter(([h, o]) => solvedAt(facelets, h) && solvedAt(facelets, o)).length;
  const pairs = SLOTS.filter(
    ({ edge: [h, o], corner: [c1, c2, c3] }) =>
      solvedAt(facelets, h) && solvedAt(facelets, o)
      && solvedAt(facelets, c1) && solvedAt(facelets, c2) && solvedAt(facelets, c3),
  ).length;
  const ocll = facelets.slice(0, 9) === 'UUUUUUUUU';

  let stage: Stage;
  if (eoBad > 0 || cross < 4) stage = 'eo';
  else if (pairs < 4) stage = 'f2l';
  else if (!ocll) stage = 'ocll';
  else if (facelets !== SOLVED) stage = 'pll';
  else stage = 'solved';

  return { stage, eoBad, cross, pairs, ocll };
}

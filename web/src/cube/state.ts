// Cube states as facelet strings (cubejs / Kociemba order: U1..U9 R1..R9
// F1..F9 D1..D9 L1..L9 B1..B9), always reached by an alg from solved - so
// there is never an invalid state to keep consistent. Letters are the face
// a sticker is home on, which in the trainers' frame (white down, chosen
// colour in front) is also its colour.

import Cube from '../vendor/cubejs';
import { faceMoves, mergeMoves, movesStr, tokens } from './alg';

export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const FACES = 'URFDLB';
/** Facelet index of each face's centre. */
export const CENTRE: Record<string, number> = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };

/** Facelets after `alg` from solved, exactly as cubejs applies it (a rotation moves the centres). */
export function rawFacelets(alg: string): string {
  return new Cube().move(tokens(alg).join(' ')).asString();
}

/** Facelets after each token of `alg` applied in turn to `start`, as cubejs applies them (centres move with wide moves and rotations). */
export function stepStates(start: string, alg: string): string[] {
  const c = Cube.fromString(start);
  return tokens(alg).map((t) => c.move(t).asString());
}

const centresHome = (f: string): boolean => FACES.split('').every((face) => f[CENTRE[face]] === face);

// the 24 whole-cube rotations, as move strings (64 products, duplicates harmless)
const TURNS = ['', 'x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];
let rotations: string[] | null = null;
function allRotations(): string[] {
  if (rotations) return rotations;
  const seen = new Map<string, string>();
  for (const a of TURNS) for (const b of TURNS) {
    const rot = `${a} ${b}`.trim();
    const key = new Cube().move(rot).asString();
    if (!seen.has(key)) seen.set(key, rot);
  }
  rotations = [...seen.values()];
  return rotations;
}

/**
 * Facelets after `alg` with any whole-cube rotation undone, so the centres are home and the string
 * reads in the frame the alg started in: x, y, z, and rotations hidden in wide moves just work.
 */
export function state(alg: string): string {
  const raw = rawFacelets(alg);
  if (centresHome(raw)) return raw;
  const toks = tokens(alg).join(' ');
  for (const rot of allRotations()) {
    const f = new Cube().move(`${toks} ${rot}`).asString();
    if (centresHome(f)) return f;
  }
  throw new Error('no rotation brings the centres home'); // cannot happen for a real cube
}

// a wide move or a slice is the outer layer(s) the other way plus a whole-cube rotation: r = L x, M = L' R x'
const WIDE_ROT: Record<string, string> = { R: 'x', L: "x'", U: 'y', D: "y'", F: 'z', B: "z'" };
const SLICE_LIKE: Record<string, string> = { M: 'L', E: 'D', S: 'F' };
const OPP: Record<string, string> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
const flipSuffix = (s: string): string => (s === "'" ? '' : s === '' ? "'" : s);
const withSuffix = (rot: string, suf: string): string => (rot.endsWith("'") ? rot[0] + flipSuffix(suf) : rot + suf);

/**
 * `alg` as face turns only, in the frame it started in: rotations are dropped and the moves after
 * them relabelled, a wide move becomes the opposite face (r = L x), a slice both outer layers
 * (M = L' R x'); same-face turns merged. The same cube as state(alg), by test. What a smart cube
 * sees (it reports the layers that turned, in fixed letters) and what a scramble should read as.
 */
export function faceTurns(alg: string): string {
  const rots: string[] = [];
  const out: string[] = [];
  let centres = SOLVED; // which face's centre sits at each position after the rotations so far
  const phys = (face: string): string => centres[CENTRE[face]!]!;
  const turn = (rot: string) => { rots.push(rot); centres = rawFacelets(rots.join(' ')); };
  for (const t of tokens(alg)) {
    const base = t[0]!, suf = t.slice(1);
    if ('xyz'.includes(base)) { turn(t); continue; }
    if ('URFDLB'.includes(base)) { out.push(phys(base) + suf); continue; }
    const like = SLICE_LIKE[base] ?? base.toUpperCase();
    if (base in SLICE_LIKE) out.push(phys(like) + flipSuffix(suf), phys(OPP[like]!) + suf);
    else out.push(phys(OPP[like]!) + suf);
    turn(withSuffix(WIDE_ROT[like]!, suf));
  }
  return movesStr(mergeMoves(faceMoves(out.join(' '))!));
}

/** '' when `alg` solves the cube, the U turn that would finish it, or null. */
export function aufToSolve(alg: string): string | null {
  for (const auf of ['', 'U', "U'", 'U2']) if (state(`${alg} ${auf}`) === SOLVED) return auf;
  return null;
}

// Cube states as facelet strings (cubejs / Kociemba order: U1..U9 R1..R9
// F1..F9 D1..D9 L1..L9 B1..B9), always reached by an alg from solved - so
// there is never an invalid state to keep consistent. Letters are the face
// a sticker is home on, which in the trainers' frame (white down, chosen
// colour in front) is also its colour.

/// <reference path="../cubejs.d.ts" />
import Cube from 'cubejs';
import { tokens } from './alg';

export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
export const FACES = 'URFDLB';
/** Facelet index of each face's centre. */
export const CENTRE: Record<string, number> = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };

/** Facelets after `alg` from solved, exactly as cubejs applies it (a rotation moves the centres). */
export function rawFacelets(alg: string): string {
  return new Cube().move(tokens(alg).join(' ')).asString();
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

/** '' when `alg` solves the cube, the U turn that would finish it, or null. */
export function aufToSolve(alg: string): string | null {
  for (const auf of ['', 'U', "U'", 'U2']) if (state(`${alg} ${auf}`) === SOLVED) return auf;
  return null;
}

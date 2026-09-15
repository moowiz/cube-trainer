// The scanned cube as a scramble for the ZZ trainer.
//
// The solver's facelet string names faces by their geometry (cubejs's
// U R F D L B; on a standard cube the white centre is U and green is F).
// The trainer holds the cube white DOWN with a chosen colour in front and
// reads its scrambles in that frame. The physical turns are the same; only
// the names of the faces differ, by a whole-cube rotation - so the scanned
// state's scramble is relabelled move by move, never re-solved.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import type { ColorName, FaceId } from './types';
import { FACE_ORDER } from './types';

export interface ScannedCube {
  /** URFDLB facelet string, letters by geometry (the solver's). */
  facelets: string;
  /** The colour each letter's centre carries (from the solver's naming). */
  colourOf: Record<FaceId, ColorName>;
  /** cubejs solution of `facelets`, in the same letters. */
  solution: string;
}

/** How the trainer holds the cube: which colour is underneath, which faces you. */
export interface Hold {
  down: ColorName;
  front: ColorName;
}

export { frameMap, relabel as relabelMoves } from './cube/frame';
import { frameMap, invertMap, relabel } from './cube/frame';

/**
 * A scramble that reproduces the scanned cube when applied to a solved cube
 * held with `hold.down` underneath and `hold.front` facing you - the
 * trainer's frame. Throws when the scan has no such colours or they are not
 * on adjacent faces (a non-standard scheme the trainer cannot show).
 */
export function trainerScramble(scan: ScannedCube, hold: Hold): string {
  const letter = (c: ColorName): FaceId => {
    const f = FACE_ORDER.find((k) => scan.colourOf[k] === c);
    if (!f) throw new Error(`the scan has no ${c} centre`);
    return f;
  };
  return relabel(Cube.inverse(scan.solution), frameMap(letter(hold.down), letter(hold.front)));
}

/**
 * The other direction: the facelets the solver should see for a cube that had `scramble` applied
 * while held `hold`, in the solver's letters (`colourOf` = the colour on each of its faces' centres).
 * Throws when a colour is missing or the hold is impossible. Used to check a scan against the
 * trainer's scramble, live and at the lock.
 */
export function expectedFacelets(scramble: string, hold: Hold, colourOf: Record<FaceId, ColorName>): string {
  const letter = (c: ColorName): FaceId => {
    const f = FACE_ORDER.find((k) => colourOf[k] === c);
    if (!f) throw new Error(`no ${c} centre`);
    return f;
  };
  return new Cube().move(relabel(scramble, invertMap(frameMap(letter(hold.down), letter(hold.front))))).asString();
}

/** How a (possibly partial) reading compares with an expected state: stickers read, and which of them differ. */
export function diffFacelets(expected: string, got: readonly (string | null)[]): { read: number; wrong: number[] } {
  const wrong: number[] = [];
  let read = 0;
  got.forEach((g, i) => { if (g === null || g === undefined) return; read++; if (g !== expected[i]) wrong.push(i); });
  return { read, wrong };
}

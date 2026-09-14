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

type Vec = readonly [number, number, number];
const NORMAL: Record<FaceId, Vec> = { U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1], R: [1, 0, 0], L: [-1, 0, 0] };

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function letterOf(n: Vec): FaceId {
  const f = FACE_ORDER.find((k) => NORMAL[k].every((v, i) => v === n[i]));
  if (!f) throw new Error(`no face has normal ${n.join(',')}`);
  return f;
}

function opposite(f: FaceId): FaceId {
  return letterOf(NORMAL[f].map((v) => -v) as unknown as Vec);
}

/**
 * The rotation that puts the face called `down` underneath and `front` in
 * front, as a map from the letters of one frame to the letters of the
 * standard frame (down -> D, front -> F, the rest by the right-hand rule:
 * R = U x F). Throws when the two are not adjacent.
 */
export function frameMap(down: FaceId, front: FaceId): Record<FaceId, FaceId> {
  if (down === front || opposite(down) === front) throw new Error(`${down} and ${front} are not adjacent faces`);
  const up = opposite(down);
  const right = letterOf(cross(NORMAL[up], NORMAL[front]));
  return {
    [down]: 'D', [up]: 'U', [front]: 'F', [opposite(front)]: 'B', [right]: 'R', [opposite(right)]: 'L',
  } as Record<FaceId, FaceId>;
}

/** The same face turns with each face called by its letter in the other frame. */
export function relabelMoves(alg: string, map: Record<FaceId, FaceId>): string {
  return alg.trim().split(/\s+/).filter(Boolean).map((m) => {
    const face = m[0] as FaceId;
    if (!(face in map)) throw new Error(`not a face turn: ${m}`);
    return map[face] + m.slice(1);
  }).join(' ');
}

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
  return relabelMoves(Cube.inverse(scan.solution), frameMap(letter(hold.down), letter(hold.front)));
}

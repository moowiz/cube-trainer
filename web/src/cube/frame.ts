// Frames: the same physical turns called by different face letters,
// depending on how the cube is held. Three frames matter here:
//   trainer  - white down, the chosen colour in front (the pictures, the moves you type)
//   WCA      - white up, green in front (how every scramble is shown, as in competitions)
//   solver   - the scanner's letters, by geometry, with the colour of each centre known
// A frame map is a whole-cube rotation given as letter -> letter; relabelling an alg by it
// keeps the physical turns and renames them, for face turns, wide moves, slices and rotations.

import { faceColorName } from './scheme';
import { tokens } from './alg';

export type FaceId = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';
const FACE_IDS: readonly FaceId[] = ['U', 'R', 'F', 'D', 'L', 'B'];
type Vec = readonly [number, number, number];
const NORMAL: Record<FaceId, Vec> = { U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1], R: [1, 0, 0], L: [-1, 0, 0] };

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function letterOf(n: Vec): FaceId {
  const f = FACE_IDS.find((k) => NORMAL[k].every((v, i) => v === n[i]));
  if (!f) throw new Error(`no face has normal ${n.join(',')}`);
  return f;
}
function opposite(f: FaceId): FaceId {
  return letterOf(NORMAL[f].map((v) => -v) as unknown as Vec);
}

export type FrameMap = Record<FaceId, FaceId>;

/**
 * The rotation that puts the face called `down` underneath and `front` in front, as a map from the
 * letters of one frame to the letters of the standard frame (down -> D, front -> F, the rest by the
 * right-hand rule: R = U x F). Throws when the two are not adjacent.
 */
export function frameMap(down: FaceId, front: FaceId): FrameMap {
  if (down === front || opposite(down) === front) throw new Error(`${down} and ${front} are not adjacent faces`);
  const up = opposite(down);
  const right = letterOf(cross(NORMAL[up], NORMAL[front]));
  return { [down]: 'D', [up]: 'U', [front]: 'F', [opposite(front)]: 'B', [right]: 'R', [opposite(right)]: 'L' } as FrameMap;
}

export function invertMap(m: FrameMap): FrameMap {
  return Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a])) as FrameMap;
}

// a slice or rotation turns like one face: M like L, E like D, S like F, x like R, y like U, z like F
const TURNS_LIKE: Record<string, FaceId> = { M: 'L', E: 'D', S: 'F', x: 'R', y: 'U', z: 'F' };
// the slice / rotation on each axis and which face it turns like
const SLICE_OF: Record<FaceId, [string, boolean]> = { L: ['M', false], R: ['M', true], D: ['E', false], U: ['E', true], F: ['S', false], B: ['S', true] };
const ROT_OF: Record<FaceId, [string, boolean]> = { R: ['x', false], L: ['x', true], U: ['y', false], D: ['y', true], F: ['z', false], B: ['z', true] };

/** Every turn of `alg` called by the letters of the other frame. Accepts anything tokens() does. */
export function relabel(alg: string, map: FrameMap): string {
  return tokens(alg).map((t) => {
    const base = t[0], suf = t.slice(1);
    const flip = (s: string) => (s === "'" ? '' : s === '' ? "'" : s);
    if (base in map) return map[base as FaceId] + suf;                       // face turn
    if (base.toUpperCase() in map) return map[base.toUpperCase() as FaceId].toLowerCase() + suf; // wide
    const like = map[TURNS_LIKE[base]];                                        // slice or rotation
    const [name, reversed] = ('MES'.includes(base) ? SLICE_OF : ROT_OF)[like];
    return name + (reversed ? flip(suf) : suf);
  }).join(' ');
}

/** WCA scrambling orientation: white up, green front. */
const WCA_COLOUR: Record<FaceId, string> = { U: 'white', D: 'yellow', F: 'green', B: 'blue', R: 'red', L: 'orange' };

/** trainer letter -> WCA letter for the current colour scheme. */
function trainerToWca(): FrameMap {
  const out = {} as FrameMap;
  for (const t of FACE_IDS) {
    const colour = faceColorName(t);
    const w = FACE_IDS.find((k) => WCA_COLOUR[k] === colour);
    if (!w) throw new Error(`no WCA face is ${colour}`);
    out[t] = w;
  }
  return out;
}

/** A trainer-frame alg as it should be applied holding the cube white up, green front. */
export function toWca(alg: string): string { return relabel(alg, trainerToWca()); }
/** A WCA-frame alg (white up, green front) in the trainer's letters. */
export function fromWca(alg: string): string { return relabel(alg, invertMap(trainerToWca())); }

/** How to hold the cube for a WCA scramble, in words. */
export const WCA_HOLD = 'white on top, green facing you';

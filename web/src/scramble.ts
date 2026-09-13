// Random scrambles for the scan page. Shown at the top and regenerated on
// Reset so a session has a known truth: apply the scramble to a SOLVED cube
// (white up, green front, or any orientation - the facelet string is
// centre-relative) and the capture's `scrambleTruth` is the state the
// solver must find. That is what turns a phone capture into a regression
// fixture without any hand labelling.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';

const FACES = ['U', 'D', 'L', 'R', 'F', 'B'] as const;
const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };
const SUFFIX = ['', "'", '2'] as const;

/**
 * `n` random moves: never the same face twice in a row, never three moves
 * on one axis in a row (U D U is a wasted move).
 */
export function randomScramble(n = 20, rnd: () => number = Math.random): string {
  const moves: string[] = [];
  let prev = '';
  let prev2 = '';
  while (moves.length < n) {
    const f = FACES[Math.floor(rnd() * 6)]!;
    if (f === prev) continue;
    if (prev && prev2 && AXIS[f] === AXIS[prev] && AXIS[f] === AXIS[prev2]) continue;
    moves.push(f + SUFFIX[Math.floor(rnd() * 3)]);
    prev2 = prev;
    prev = f;
  }
  return moves.join(' ');
}

/** The URFDLB facelet string a solved cube reaches after `scramble`. */
export function scrambleState(scramble: string): string {
  return new Cube().move(scramble).asString();
}

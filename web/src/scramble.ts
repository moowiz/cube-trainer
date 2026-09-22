// Random scrambles for the scan page. Shown at the top and regenerated on
// Reset so a session has a known truth: apply the scramble to a SOLVED cube
// (white up, green front, or any orientation - the facelet string is
// centre-relative) and the capture's `scrambleTruth` is the state the
// solver must find. That is what turns a phone capture into a regression
// fixture without any hand labelling.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { movesStr, randomMoves } from './cube/alg';

/** `n` random face turns as a string (cube/alg.ts's randomMoves: no face twice, no three on one axis). */
export function randomScramble(n = 20, rnd: () => number = Math.random): string {
  return movesStr(randomMoves(n, rnd));
}

/** The URFDLB facelet string a solved cube reaches after `scramble`. */
export function scrambleState(scramble: string): string {
  return new Cube().move(scramble).asString();
}

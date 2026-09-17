// Scramble following (docs/smart-cube-design.md 4.1): which prefix of the
// scramble the cube has applied, read off the cube's belief against the
// states the scramble's prefixes reach from solved. Off the scramble
// (no prefix matches) means a wrong turn: the fix is to undo back to the
// last prefix that matched. Pure; the scramble is in the cube's letters.

import { applySeq, parseAlg, type Move } from '../moves/moves';
import { SOLVED } from '../cube/state';

export interface TrackStatus {
  /** moves of the scramble applied so far */
  applied: number;
  total: number;
  /** the cube is at no prefix of the scramble */
  off: boolean;
  /** the scramble is fully applied */
  matched: boolean;
}

export class ScrambleTracker {
  readonly moves: Move[];
  /** state after each prefix, [0] = solved */
  private readonly states: string[];
  private last = 0;

  constructor(scramble: string) {
    this.moves = parseAlg(scramble);
    this.states = [SOLVED];
    for (const m of this.moves) this.states.push(applySeq(this.states[this.states.length - 1]!, [m]));
  }

  /** The state the finished scramble reaches. */
  target(): string { return this.states[this.states.length - 1]!; }

  status(belief: string | null): TrackStatus {
    const total = this.moves.length;
    if (belief === null) return { applied: 0, total, off: false, matched: false };
    // the next prefix first (the usual case), then the current, then anywhere (an undo, a half-turn done as two)
    const order = [this.last + 1, this.last, ...this.states.keys()];
    for (const k of order) {
      if (k >= 0 && k < this.states.length && this.states[k] === belief) {
        this.last = k;
        return { applied: k, total, off: false, matched: k === total };
      }
    }
    return { applied: this.last, total, off: true, matched: false };
  }
}

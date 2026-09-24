// Scramble following (docs/smart-cube-design.md 4.1): which prefix of the
// scramble the cube has applied, read off the cube's belief against the
// states the scramble's prefixes reach from solved. A double turn done as
// two quarter turns passes through a state that is no prefix: those
// halfway states (either direction) count as still on the scramble, as
// does one turn of an R2 L2 pair done as an M2. Off
// the scramble (no prefix or halfway state matches) means a wrong turn:
// the fix is to undo back to the last prefix that matched. Pure; the
// scramble is in the cube's letters.

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
  /** one quarter turn into the double turn at index `applied` (not off: the same turn again finishes it) */
  half: boolean;
}

export class ScrambleTracker {
  readonly moves: Move[];
  /** state after each prefix, [0] = solved */
  private readonly states: string[];
  /** halfway states of move k when it is a double turn (a quarter turn either way from states[k]), else empty */
  private readonly halves: string[][];
  private last = 0;

  constructor(scramble: string) {
    this.moves = parseAlg(scramble);
    this.states = [SOLVED];
    this.halves = [];
    for (const m of this.moves) {
      const before = this.states[this.states.length - 1]!;
      this.states.push(applySeq(before, [m]));
      const face = m[0] as Move;
      this.halves.push(m.endsWith('2') ? [applySeq(before, [face]), applySeq(before, [`${face}'` as Move])] : []);
    }
    // an R2 L2 pair is done as one M2, which the cube reports as its two outer turns in either order: the
    // other one first is halfway through the pair, not off
    for (let k = 0; k + 1 < this.moves.length; k++) {
      const a = this.moves[k]!, b = this.moves[k + 1]!;
      if (/^[RL]2$/.test(a) && /^[RL]2$/.test(b) && a[0] !== b[0]) this.halves[k]!.push(applySeq(this.states[k]!, [b]));
    }
  }

  /** The state the finished scramble reaches. */
  target(): string { return this.states[this.states.length - 1]!; }

  status(belief: string | null): TrackStatus {
    const total = this.moves.length;
    if (belief === null) return { applied: 0, total, off: false, matched: false, half: false };
    // the next prefix first (the usual case), then the current, then anywhere (an undo)
    const order = [this.last + 1, this.last, ...this.states.keys()];
    for (const k of order) {
      if (k >= 0 && k < this.states.length && this.states[k] === belief) {
        this.last = k;
        return { applied: k, total, off: false, matched: k === total, half: false };
      }
    }
    // halfway through a double turn: the current move first, then any
    for (const k of [this.last, ...this.halves.keys()]) {
      if (k >= 0 && k < this.halves.length && this.halves[k]!.includes(belief)) {
        this.last = k;
        return { applied: k, total, off: false, matched: false, half: true };
      }
    }
    return { applied: this.last, total, off: true, matched: false, half: false };
  }
}

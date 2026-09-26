// A solve's splits: how long each ZZ stage took, off the turns and their times.
// A stage ends the first time the cube is past it (the follow's rule, follow.ts:
// a solve's furthest stage so far), so an alg that dips back through an earlier
// stage never moves a split; M11's analysis will define the exact boundary as
// the last time a stage became true and stayed true. A stage skipped (an OCLL
// skip) takes no time. Pure: the cube rail keeps one per attempt, and a stored
// solve's splits are read back from its moves the same way.

import { tokens } from '../cube/alg';
import { fromWca } from '../cube/frame';
import { state } from '../cube/state';
import { applySeq, type Move } from '../moves/moves';
import { stageOf, type Stage } from '../stage';

export const SPLIT_STAGES = ['eo', 'f2l', 'ocll', 'pll'] as const;
export type SplitStage = (typeof SPLIT_STAGES)[number];
const RANK: Record<Stage, number> = { eo: 0, f2l: 1, ocll: 2, pll: 3, solved: 4 };

/** When each stage ended (ms from the first turn), and so how long each took. */
export class SplitClock {
  private rank: number;
  private readonly ends: Partial<Record<SplitStage, number>> = {};
  /** `from`: the stage the cube is at when the clock starts. */
  constructor(from: Stage) { this.rank = RANK[from]; }
  /** The cube reached `stage` at `t` (ms from the first turn); true when that ended a stage. */
  turned(stage: Stage, t: number): boolean {
    const r = RANK[stage];
    if (r <= this.rank) return false;
    for (let k = this.rank; k < r; k++) this.ends[SPLIT_STAGES[k]!] = t;
    this.rank = r;
    return true;
  }
  /** The stage the cube is in now (the furthest reached); 'solved' at the end. */
  current(): Stage { return this.rank >= 4 ? 'solved' : SPLIT_STAGES[this.rank]!; }
  /** ms each finished stage took; a stage before the start is absent, a skipped one is 0. */
  splits(): Partial<Record<SplitStage, number>> {
    const out: Partial<Record<SplitStage, number>> = {};
    let prev = 0;
    for (const s of SPLIT_STAGES) {
      const e = this.ends[s];
      if (e === undefined) continue;
      out[s] = Math.max(0, e - prev);
      prev = e;
    }
    return out;
  }
}

/**
 * A stored solve's splits: its scramble and its turns (WCA letters, `t` ms from the first turn).
 * Null when the turns cannot be read (a solve typed or imported without them).
 */
export function splitsOf(scrambleWca: string, moves: readonly { m: string; t: number }[]): Partial<Record<SplitStage, number>> | null {
  if (!moves.length) return null;
  try {
    let f = state(fromWca(scrambleWca));
    const clock = new SplitClock(stageOf(f).stage);
    for (const mv of moves) {
      for (const m of tokens(fromWca(mv.m))) f = applySeq(f, [m as Move]);
      clock.turned(stageOf(f).stage, mv.t);
    }
    return clock.splits();
  } catch { return null; }
}

/** Seconds, one decimal: a split as the strip shows it. */
export const splitText = (ms: number): string => (ms / 1000).toFixed(1);

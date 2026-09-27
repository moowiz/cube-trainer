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

// DECISION: behind the furthest point for this many quarter turns in a row is a real step back, not an alg passing
// through earlier stages. Measured on the 33 recorded solves (2026-09-26): an alg's dip lasts at most 19 (a two-look
// PLL's second alg, 7.6 s); the longest tabled alg is about 23 (Na, its half turns as two); the one solve that broke
// its F2L and redid it stayed behind for 59.
export const BACK_TURNS = 32;

/**
 * When each stage ended (ms from the first turn), and so how long each took; and where the solve is, as the rail's
 * strip shows it. A stage ends the first time the cube is past it, and an alg dipping back through an earlier stage
 * (a Sune breaks the cross on its first turn) moves nothing. The pairs likewise count up as they are made and do not
 * drop when the next pair's R or L lifts one for a few turns. Only a real step back - the cube behind its furthest
 * point for BACK_TURNS turns in a row - moves the solve back there: the stages after it lose their splits (they are
 * timed again when crossed again), and `back()` says so until the solve gets past that stage.
 */
export class SplitClock {
  private rank: number;
  private readonly ends: Partial<Record<SplitStage, number>> = {};
  private pairMark = 0;
  private behind = 0;
  private backAt: number | null = null;
  /** `from`: the stage the cube is at when the clock starts. */
  constructor(from: Stage, pairs = 0) { this.rank = RANK[from]; this.pairMark = from === 'f2l' ? pairs : 0; }
  private level(rank: number, pairs: number): number { return rank * 5 + (rank === 1 ? pairs : 0); }
  /** The cube reached `stage` (with `pairs` F2L pairs in) at `t` (ms from the first turn); true when that ended a stage. */
  turned(stage: Stage, t: number, pairs = 0): boolean {
    const r = RANK[stage];
    if (this.level(r, pairs) >= this.level(this.rank, this.pairMark)) this.behind = 0;
    else if (++this.behind >= BACK_TURNS) {
      // a real step back: the solve is where the cube is
      for (let k = r; k < SPLIT_STAGES.length; k++) delete this.ends[SPLIT_STAGES[k]!];
      this.rank = r; this.pairMark = pairs; this.behind = 0; this.backAt = r;
      return false;
    }
    if (r === 1 && this.rank === 1) this.pairMark = Math.max(this.pairMark, pairs);
    if (r <= this.rank) return false;
    for (let k = this.rank; k < r; k++) this.ends[SPLIT_STAGES[k]!] = t;
    this.rank = r;
    this.pairMark = r === 1 ? pairs : 0;
    if (this.backAt !== null && r > this.backAt) this.backAt = null;
    return true;
  }
  /** The stage the cube is in now (the furthest reached); 'solved' at the end. */
  current(): Stage { return this.rank >= 4 ? 'solved' : SPLIT_STAGES[this.rank]!; }
  /** The F2L pairs made so far (while in F2L). */
  pairs(): number { return this.pairMark; }
  /** The solve stepped back to the current stage and has not got past it again. */
  back(): boolean { return this.backAt !== null; }
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
    const r0 = stageOf(f);
    const clock = new SplitClock(r0.stage, r0.pairs);
    for (const mv of moves) {
      for (const m of tokens(fromWca(mv.m))) f = applySeq(f, [m as Move]);
      const r = stageOf(f);
      clock.turned(r.stage, mv.t, r.pairs);
    }
    return clock.splits();
  } catch { return null; }
}

/** Seconds, one decimal: a split as the strip shows it. */
export const splitText = (ms: number): string => (ms / 1000).toFixed(1);

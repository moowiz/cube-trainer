// Following a solve: the cube the app believes is in your hands - the last
// lock plus the turns the move reader has read since - as a scramble in
// the trainer's frame, and the moment it crosses into another ZZ stage.
//
// Nothing here looks at the camera. The scanner hands over a lock (a
// ScannedCube) and, a few times a second, the reader's moves in the
// solver's letters; this turns them into what the stages consume.

import Cube from './vendor/cubejs';
import { relabelTurns, trainerScramble, type Hold, type ScannedCube } from './handoff';
import type { Move } from './moves/moves';
import { stageOf, type Stage, type StageReport } from './stage';
import type { ColorName, FaceId } from './types';

/**
 * The trainer-frame scramble that reaches the followed cube: the lock's
 * scramble, then the read turns called by the trainer's letters (a turn is
 * the same physical turn in either frame; only the face's name changes).
 */
export function followScramble(scan: ScannedCube, moves: readonly Move[], hold: Hold): string {
  const base = trainerScramble(scan, hold);
  if (moves.length === 0) return base;
  const turned = relabelTurns(scan.colourOf, moves, hold);
  return base ? `${base} ${turned}` : turned;
}

/** The stage a trainer-frame scramble leaves the cube at. */
export function followReport(scramble: string): StageReport {
  return stageOf(new Cube().move(scramble).asString());
}

/**
 * A state as the colours on its 54 stickers, so two locks can be compared
 * even when the solver named the faces with different letters.
 */
export function colourString(facelets: string, colourOf: Record<FaceId, ColorName>): string {
  return facelets.split('').map((l) => colourOf[l as FaceId] ?? '?').join(',');
}

/**
 * Debounces the stage the followed cube is at: a switch is reported only
 * once the same new stage has been seen `settle` polls in a row, so a turn
 * caught mid-way (the reader's leading path flips while the layer is
 * between frames) does not bounce the tabs.
 */
export class StageFollower {
  private current: Stage | null = null;
  private candidate: Stage | null = null;
  private seen = 0;

  constructor(private readonly settle = 2) {}

  /** Start following from a known stage (a lock routed by the host). */
  reset(stage: Stage | null): void {
    this.current = stage;
    this.candidate = null;
    this.seen = 0;
  }

  /** The stage being shown. */
  stage(): Stage | null { return this.current; }

  /** Feed the stage of the latest poll; returns the stage to switch to, or null to stay. */
  update(stage: Stage): Stage | null {
    if (stage === this.current) { this.candidate = null; this.seen = 0; return null; }
    if (stage !== this.candidate) { this.candidate = stage; this.seen = 0; }
    if (++this.seen < this.settle) return null;
    this.current = stage;
    this.candidate = null;
    this.seen = 0;
    return stage;
  }
}

/** What a stage report says in words, for the toast: the stage to solve, no hints about the state. */
export function describeStage(r: StageReport): string {
  if (r.stage === 'solved') return 'Your cube is solved.';
  if (r.stage === 'eo') return 'EOCross to solve → EO trainer';
  if (r.stage === 'f2l') return 'EOCross done → F2L';
  if (r.stage === 'ocll') return 'F2L done → OCLL';
  return 'Corners oriented → PLL';
}

const STAGE_RANK: Record<Stage, number> = { eo: 0, f2l: 1, ocll: 2, pll: 3, solved: 4 };
/** How far along a ZZ solve a stage is (EO first, solved last). */
export const stageRank = (s: Stage): number => STAGE_RANK[s];

/**
 * Follows a solve on a source whose every item is a whole turn (the smart
 * cube): no debounce is needed, but an alg passes through earlier stages
 * on its way (a Sune breaks the cross on its first move and rebuilds it on
 * its last), so a solve is followed by its furthest stage so far - the
 * MARK - and a tab is switched to only when the cube crosses into a stage
 * beyond it. Falling behind the mark is either mid-alg (the next crossing
 * catches up) or a new scramble: the host decides which at a pause, with
 * `paused`, and tells the follower where a new solve starts with `restart`
 * (the cube reached the open tab's scramble, or a state was loaded).
 */
export class SolveFollower {
  private mark_: Stage | null = null;

  /** The furthest stage this solve has reached; null before the first state is known. */
  mark(): Stage | null { return this.mark_; }

  /** A new solve starts here (a scramble matched, a state loaded, the follow engaged). */
  restart(stage: Stage | null): void { this.mark_ = stage; }

  /** After a turn: the stage crossed into when it is beyond the mark (a tab to open), else null. */
  turned(stage: Stage): Stage | null {
    if (this.mark_ === null) { this.mark_ = stage; return null; }
    if (stageRank(stage) <= stageRank(this.mark_)) return null;
    this.mark_ = stage;
    return stage;
  }

  /**
   * At a pause (the cube idle a while, off any scramble path): the stage to restart from when the
   * cube has fallen behind the mark - a new scramble by hand - else null. The first pause after
   * the follow engaged just takes the stage as the mark, unless the cube is solved (nothing to
   * load: the tab's scramble is about to be applied).
   */
  paused(stage: Stage): Stage | null {
    if (this.mark_ === null) { this.mark_ = stage; return stage === 'solved' ? null : stage; }
    if (stageRank(stage) >= stageRank(this.mark_)) return null;
    this.mark_ = stage;
    return stage;
  }
}

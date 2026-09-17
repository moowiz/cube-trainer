// Following a solve: the cube the app believes is in your hands - the last
// lock plus the turns the move reader has read since - as a scramble in
// the trainer's frame, and the moment it crosses into another ZZ stage.
//
// Nothing here looks at the camera. The scanner hands over a lock (a
// ScannedCube) and, a few times a second, the reader's moves in the
// solver's letters; this turns them into what the stages consume.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
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

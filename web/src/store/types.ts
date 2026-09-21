// The solve store's records (docs/smart-cube-design.md 4.1, 7): what a
// timed solve keeps, and the sessions it belongs to. Times and moves are
// in WCA notation (white up, green front - a standard smart cube's own
// letters); the analysis rotates into the trainer's frame when it needs
// to. Records are edited rarely (a penalty, a comment, a delete) and never
// merged field by field: the later `editedAt` wins, whichever device it
// came from.

export type Penalty = 0 | 2 | -1; // none, +2, DNF

/** Which puzzle a record is for; only the 3x3 exists today, the rest are reserved names. */
export type PuzzleId = '333' | '222' | '444' | '555' | 'skewb' | 'pyram' | 'minx';
export const DEFAULT_PUZZLE: PuzzleId = '333';

export interface SolveMove {
  /** the turn, WCA letters */
  m: string;
  /** ms since the first turn (host clock) */
  t: number;
  /** the cube's own ms counter, when it had one */
  tRaw?: number;
}

export interface SolveRecord {
  id: string;
  puzzle: PuzzleId;
  session: string;
  /** wall clock at the first turn (or the timer start), ms */
  when: number;
  /** WCA notation */
  scramble: string;
  /** the raw time, ms, penalty not included (kept for a DNF too) */
  time: number;
  penalty: Penalty;
  comment?: string;
  /** every turn, when a source supplied them */
  moves?: SolveMove[];
  source: 'cube' | 'keyboard' | 'camera' | 'import';
  /** ms from the scramble being matched (inspection start) to the first turn */
  inspection?: number;
  /** the local recording this solve is in, when one was running */
  capture?: string;
  /** wall clock of the last edit, ms: last write wins across devices */
  editedAt: number;
  deleted?: boolean;
}

export interface SessionRecord {
  id: string;
  puzzle: PuzzleId;
  name: string;
  createdAt: number;
  editedAt: number;
  deleted?: boolean;
}

export type AttemptStage = 'eo' | 'f2l' | 'ocll' | 'pll' | 'plan';

export interface AttemptRecord {
  id: string;
  puzzle: PuzzleId;
  stage: AttemptStage;
  /** wall clock, ms */
  when: number;
  /** the scramble or setup the attempt started from, trainer letters */
  scramble: string;
  /** the moves typed or fed, as one alg string (trainer letters) */
  moves: string;
  /** ms, the drill's timer; null when the timer was not used */
  time: number | null;
  /** ms from the scramble being on the cube to the first turn, when a source fed the drill */
  recognition?: number;
  /** ms from the first to the last turn, when a source fed the drill */
  execution?: number;
  /** the case, when the stage has one (a last-layer case name) */
  caseId?: string;
  /** the optimal move count the drill knew, when it did */
  optimal?: number;
  /** the user peeked at a hint or a solution */
  assisted: boolean;
  source: 'typed' | 'cube' | 'camera';
  /** the drill started a step early (the corners to orient, the last pair) and the case came up after it */
  start?: 'ocll' | 'pair';
  /** the recognition quiz: the case was named right, wrong, given up on, or answered by turning */
  quiz?: 'right' | 'wrong' | 'gaveUp' | 'cube';
  editedAt: number;
  deleted?: boolean;
}

/** The time that counts: raw + 2 s, or null for a DNF. */
export function effectiveTime(s: Pick<SolveRecord, 'time' | 'penalty'>): number | null {
  return s.penalty === -1 ? null : s.time + s.penalty * 1000;
}

/** A fresh id: sortable by time, unique enough across two devices. */
export function newId(when = Date.now()): string {
  return `${when.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The solve store's records (docs/smart-cube-design.md 4.1, 7): what a
// timed solve keeps, and the sessions it belongs to. Times and moves are
// in WCA notation (white up, green front - a standard smart cube's own
// letters); the analysis rotates into the trainer's frame when it needs
// to. Records are edited rarely (a penalty, a comment, a delete) and never
// merged field by field: the later `editedAt` wins, whichever device it
// came from.

export type Penalty = 0 | 2 | -1; // none, +2, DNF

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
  name: string;
  createdAt: number;
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

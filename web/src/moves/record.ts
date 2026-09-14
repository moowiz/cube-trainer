// The move record (design 2.6): what everything downstream consumes.
// Uncertainty is in the record, not hidden.

import type { Move } from './moves';

// t0 = the last sampled frame that showed the cube before the turn, t1 =
// the first that showed it after; `margin` = how much worse the best other
// state explained the evidence by the end of the epoch that follows;
// `sure` = the margin clears the reader's floor AND a frame after the turn
// confirmed it (a turn read on the very last frame is never sure).
export type RecordItem =
  /** One face turn. */
  | { kind: 'move'; move: Move; t0: number; t1: number; margin: number; sure: boolean }
  /** Several turns with no frame between them: `ordered` false when some of them commute and the order is unknowable. */
  | { kind: 'burst'; moves: Move[]; t0: number; t1: number; margin: number; sure: boolean; ordered: boolean }
  /** The reader lost the state: at least `minMoves` turns it could not read. */
  | { kind: 'gap'; minMoves: number; t0: number; t1: number };

export interface MoveRecord {
  /** The locked start state. */
  start: string;
  items: RecordItem[];
  /** The state the record ends in. */
  end: string;
  /** Whether `end` matches the state the caller said the solve ended in (null when none was given). */
  endMatches: boolean | null;
  /** Total cost margin of the winning path over the best other path at the last frame. */
  margin: number;
  /** Frames read and the wall-clock span they cover. */
  frames: number;
  t0: number;
  t1: number;
}

/** The moves as an alg string: bursts in parentheses, brackets when their order is unknown, '?' after an unsure turn. */
export function formatAlg(rec: MoveRecord): string {
  return rec.items.map((it) => {
    if (it.kind === 'gap') return `(${it.minMoves}+ unread)`;
    const q = it.sure ? '' : '?';
    if (it.kind === 'move') return it.move + q;
    return (it.ordered ? `(${it.moves.join(' ')})` : `[${it.moves.join(' ')}]`) + q;
  }).join(' ');
}

/** Every turn in order (bursts flattened in their recorded order). */
export function recordMoves(rec: MoveRecord): Move[] {
  const out: Move[] = [];
  for (const it of rec.items) {
    if (it.kind === 'move') out.push(it.move);
    else if (it.kind === 'burst') out.push(...it.moves);
  }
  return out;
}

/** One line per item with its window and certificate, for test output and the debug panel. */
export function formatItems(rec: MoveRecord, from = rec.t0): string {
  const sec = (t: number) => ((t - from) / 1000).toFixed(2).padStart(6);
  return rec.items.map((it) => {
    if (it.kind === 'gap') return `${sec(it.t0)} - ${sec(it.t1)}  ${it.minMoves}+ unread`;
    const what = it.kind === 'move' ? it.move : `${it.ordered ? '(' : '['}${it.moves.join(' ')}${it.ordered ? ')' : ']'}`;
    return `${sec(it.t0)} - ${sec(it.t1)}  ${what.padEnd(12)} margin ${it.margin === Infinity ? 'inf' : it.margin.toFixed(1).padStart(5)}${it.sure ? '' : '  UNSURE'}`;
  }).join('\n');
}

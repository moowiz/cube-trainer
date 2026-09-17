// Where turns come from (docs/smart-cube-design.md 1): the smart cube, the
// camera reader, the typed moves box, or a replayed capture. Every consumer
// (the drills, follow mode, the live view, later the timer and the
// analysis) reads this shape and nothing else, so nothing works only with
// the cube connected.
//
// Letters are the SOURCE's: the lock's for the camera reader, the cube's
// own for a smart cube (whose letters are its colours, `colourOf`). A turn
// is the same physical turn in any frame; only the face's name changes, and
// `relabelTurns` (follow.ts) calls it by the trainer's letters.

import type { ColorName, FaceId } from '../types';
import type { Move } from './moves';

/** One face turn. `t` is host time (the performance.now() domain the camera and the recorder share). */
export interface MoveEvent {
  kind: 'move';
  move: Move;
  t: number;
  /** the source's own clock when it has one (a smart cube's ms counter) */
  tRaw?: number;
  /** the camera reader's certificate; a smart cube's turns are always sure */
  sure: boolean;
  /** false when this turn came in a burst whose order is unknowable (camera only) */
  ordered?: boolean;
}

/** The source lost the state for a while: at least `minMoves` turns it could not read (camera only). */
export interface GapItem { kind: 'gap'; t0: number; t1: number; minMoves: number }

/** The source was told what the cube actually is (a scan lock, "it is solved", the cube's own report). */
export interface ResyncItem { kind: 'resync'; t: number; facelets: string; how: 'solved' | 'scan' | 'report' | 'fix' }

export type SourceItem = MoveEvent | GapItem | ResyncItem;

export type SourceKind = 'cube' | 'camera' | 'typed' | 'replay';

export interface MoveSource {
  readonly kind: SourceKind;
  /** letter -> colour for this source's letters */
  readonly colourOf: Record<FaceId, ColorName>;
  /** the state the source believes the cube is in, in its letters; null while unknown */
  state(): string | null;
  /** every item so far, in order (a consumer keeps its own cursor into it) */
  items(): readonly SourceItem[];
  /** tell the source what the cube actually is: it re-bases from here */
  resync(facelets: string, how: ResyncItem['how']): void;
  subscribe(cb: (item: SourceItem) => void): () => void;
  dispose(): void;
}

/** The turns among a run of items, in order. */
export function movesOf(items: readonly SourceItem[]): Move[] {
  const out: Move[] = [];
  for (const it of items) if (it.kind === 'move') out.push(it.move);
  return out;
}

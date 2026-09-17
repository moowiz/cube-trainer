// The camera reader as a MoveSource (docs/smart-cube-design.md 1): the scan
// lock is the base, the reader's MoveRecord each poll is its leading path
// over that base, and this class re-derives what is new since the last
// time it was asked. drive.ts and follow.ts consume it exactly as they
// would the smart cube's CubeSource (smart/source.ts).
//
// The reader can change its mind about an earlier turn as later frames
// arrive (that is what "leading path" means: the best explanation so far,
// not a committed log). A resync is how that reaches a consumer that can
// only apply turns forward.

import type { ScannedCube } from '../handoff';
import type { ColorName, FaceId } from '../types';
import { FACE_ORDER } from '../types';
import { applySeq, type Move } from './moves';
import type { MoveRecord, RecordItem } from './record';
import type { GapItem, MoveEvent, MoveSource, ResyncItem, SourceItem } from './source';

/** One turn out of the walked leading path, before it is known whether it is new. */
interface PathTurn {
  move: Move;
  t: number;
  sure: boolean;
  /** set only for a turn that came out of a burst (order-in-the-burst uncertainty) */
  ordered?: boolean;
}

interface PathGap {
  t0: number;
  t1: number;
  minMoves: number;
}

type PathEntry = { kind: 'turn'; turn: PathTurn } | { kind: 'gap'; gap: PathGap };

/**
 * A move item is one turn at its t1; a burst is its moves in recorded
 * order, each at the burst's own t1 with the burst's sure/ordered; a gap
 * is one gap, unchanged. Order follows `items` (the recording's order).
 */
function walkPath(items: readonly RecordItem[]): PathEntry[] {
  const out: PathEntry[] = [];
  for (const it of items) {
    if (it.kind === 'move') out.push({ kind: 'turn', turn: { move: it.move, t: it.t1, sure: it.sure } });
    else if (it.kind === 'burst') {
      for (const m of it.moves) out.push({ kind: 'turn', turn: { move: m, t: it.t1, sure: it.sure, ordered: it.ordered } });
    } else out.push({ kind: 'gap', gap: { t0: it.t0, t1: it.t1, minMoves: it.minMoves } });
  }
  return out;
}

function sameColourOf(a: Record<FaceId, ColorName>, b: Record<FaceId, ColorName>): boolean {
  return FACE_ORDER.every((f) => a[f] === b[f]);
}

export class ReaderSource implements MoveSource {
  readonly kind = 'camera';
  /** the scan this source is currently following, for re-lock detection (distinct from `base`: a host resync() can move the belief without the lock changing) */
  private lockFacelets: string;
  private colourOf_: Record<FaceId, ColorName>;
  /** the state the leading path is walked from */
  private base: string;
  /** the leading path's turns as of the last update(): both the state() input and the "already emitted" bookkeeping */
  private turns: Move[] = [];
  /** how many of the leading path's gaps have been turned into GapItems */
  private gapsEmitted = 0;
  private readonly items_: SourceItem[] = [];
  private readonly subs = new Set<(item: SourceItem) => void>();
  private readonly now: () => number;

  constructor(scan: ScannedCube, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.lockFacelets = scan.facelets;
    this.colourOf_ = { ...scan.colourOf };
    this.base = scan.facelets;
  }

  /** the current lock's letter -> colour map (a re-lock may name the faces differently) */
  get colourOf(): Record<FaceId, ColorName> { return this.colourOf_; }

  /** the lock's facelets with the record's leading path applied, in the lock's letters */
  state(): string | null { return applySeq(this.base, this.turns); }

  items(): readonly SourceItem[] { return this.items_; }

  /** every follow poll: the lock the reader is following and its latest record */
  update(scan: ScannedCube, record: MoveRecord): void {
    if (scan.facelets !== this.lockFacelets || !sameColourOf(scan.colourOf, this.colourOf_)) {
      // a re-lock: a new base to walk the path over, nothing carried forward from the old one
      this.lockFacelets = scan.facelets;
      this.colourOf_ = { ...scan.colourOf };
      this.base = scan.facelets;
      this.turns = [];
      this.gapsEmitted = 0;
      this.emit({ kind: 'resync', t: this.now(), facelets: scan.facelets, how: 'scan' });
    }

    const path = walkPath(record.items);
    const newTurns: PathTurn[] = [];
    const newGaps: PathGap[] = [];
    for (const e of path) { if (e.kind === 'turn') newTurns.push(e.turn); else newGaps.push(e.gap); }

    let p = 0;
    while (p < this.turns.length && p < newTurns.length && newTurns[p]!.move === this.turns[p]) p++;

    if (p < this.turns.length) {
      // DECISION: the leading path disagrees with itself before a turn this
      // source already reported as a MoveEvent (more frames arrived and
      // changed the reader's mind). A consumer applies MoveEvents forward
      // and cannot retract one already folded into a drill or a display, so
      // replaying the new tail as more MoveEvents would double up the turns
      // it kept and could never undo the ones it dropped. The honest
      // correction is a single resync straight to where the belief now is;
      // the consumer jumps, it does not try to reason about what changed.
      const allMoves = newTurns.map((t) => t.move);
      const facelets = applySeq(this.base, allMoves);
      this.turns = allMoves;
      this.gapsEmitted = newGaps.length;
      this.emit({ kind: 'resync', t: this.now(), facelets, how: 'report' });
      return;
    }

    let turnIdx = 0;
    let gapIdx = 0;
    for (const e of path) {
      if (e.kind === 'turn') {
        if (turnIdx >= p) {
          const ev: MoveEvent = { kind: 'move', move: e.turn.move, t: e.turn.t, sure: e.turn.sure };
          if (e.turn.ordered !== undefined) ev.ordered = e.turn.ordered;
          this.emit(ev);
        }
        turnIdx++;
      } else {
        if (gapIdx >= this.gapsEmitted) {
          const g: GapItem = { kind: 'gap', t0: e.gap.t0, t1: e.gap.t1, minMoves: e.gap.minMoves };
          this.emit(g);
        }
        gapIdx++;
      }
    }
    this.turns = newTurns.map((t) => t.move);
    this.gapsEmitted = newGaps.length;
  }

  /** host-driven re-base (a scan lock read as solved, a tap-to-fix): re-bases and forgets what was emitted */
  resync(facelets: string, how: ResyncItem['how']): void {
    this.base = facelets;
    this.turns = [];
    this.gapsEmitted = 0;
    this.emit({ kind: 'resync', t: this.now(), facelets, how });
  }

  subscribe(cb: (item: SourceItem) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  dispose(): void { this.subs.clear(); }

  private emit(item: SourceItem): void {
    this.items_.push(item);
    for (const cb of this.subs) cb(item);
  }
}

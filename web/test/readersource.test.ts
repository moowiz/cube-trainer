// The camera reader as a MoveSource (src/moves/readersource.ts): a scan
// lock is the base, each poll's MoveRecord is the leading path over it,
// and the source emits only what is new since the last poll.
import { describe, expect, it } from 'vitest';
import { SOLVED } from '../src/cube/state';
import type { ScannedCube } from '../src/handoff';
import { applySeq } from '../src/moves/moves';
import { ReaderSource } from '../src/moves/readersource';
import type { MoveRecord, RecordItem } from '../src/moves/record';
import type { SourceItem } from '../src/moves/source';
import { scrambleState } from '../src/scramble';
import { DEFAULT_SCHEME_NAMES, type ColorName, type FaceId } from '../src/types';

function scan(scramble: string, colourOf = DEFAULT_SCHEME_NAMES): ScannedCube {
  return { facelets: scrambleState(scramble), colourOf, solution: '' };
}

function record(items: RecordItem[]): MoveRecord {
  return { start: SOLVED, items, end: SOLVED, endMatches: null, margin: Infinity, frames: items.length, t0: 0, t1: 0 };
}

describe('ReaderSource', () => {
  it('emits each new turn once, in order, with t = t1 and sure carried through; state() tracks it', () => {
    const lock = scan('U');
    const src = new ReaderSource(lock, { now: () => 999 });

    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([{ kind: 'move', move: 'R', t: 100, sure: true }]);
    expect(src.state()).toBe(applySeq(lock.facelets, ['R']));

    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'move', move: 'U', t0: 100, t1: 200, margin: 5, sure: true },
      { kind: 'move', move: "F'", t0: 200, t1: 300, margin: 5, sure: false },
    ]));
    expect(src.items()).toEqual([
      { kind: 'move', move: 'R', t: 100, sure: true },
      { kind: 'move', move: 'U', t: 200, sure: true },
      { kind: 'move', move: "F'", t: 300, sure: false },
    ]);
    expect(src.state()).toBe(applySeq(lock.facelets, ['R', 'U', "F'"]));

    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'move', move: 'U', t0: 100, t1: 200, margin: 5, sure: true },
      { kind: 'move', move: "F'", t0: 200, t1: 300, margin: 5, sure: false },
      { kind: 'move', move: 'D', t0: 300, t1: 400, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([
      { kind: 'move', move: 'R', t: 100, sure: true },
      { kind: 'move', move: 'U', t: 200, sure: true },
      { kind: 'move', move: "F'", t: 300, sure: false },
      { kind: 'move', move: 'D', t: 400, sure: true },
    ]);
    expect(src.state()).toBe(applySeq(lock.facelets, ['R', 'U', "F'", 'D']));
  });

  it('a burst yields one MoveEvent per move at the burst t1, ordered carried from the burst (both true and false)', () => {
    const lock = scan('U');
    const orderedSrc = new ReaderSource(lock, { now: () => 999 });
    orderedSrc.update(lock, record([
      { kind: 'burst', moves: ['R', "U'"], t0: 0, t1: 150, margin: 5, sure: true, ordered: true },
    ]));
    expect(orderedSrc.items()).toEqual([
      { kind: 'move', move: 'R', t: 150, sure: true, ordered: true },
      { kind: 'move', move: "U'", t: 150, sure: true, ordered: true },
    ]);

    const unorderedSrc = new ReaderSource(lock, { now: () => 999 });
    unorderedSrc.update(lock, record([
      { kind: 'burst', moves: ['D2', 'L'], t0: 0, t1: 150, margin: 5, sure: false, ordered: false },
    ]));
    expect(unorderedSrc.items()).toEqual([
      { kind: 'move', move: 'D2', t: 150, sure: false, ordered: false },
      { kind: 'move', move: 'L', t: 150, sure: false, ordered: false },
    ]);
  });

  it('a gap yields exactly one GapItem, once, even across further updates', () => {
    const lock = scan('U');
    const src = new ReaderSource(lock, { now: () => 999 });

    src.update(lock, record([
      { kind: 'gap', minMoves: 2, t0: 0, t1: 500 },
    ]));
    expect(src.items()).toEqual([{ kind: 'gap', t0: 0, t1: 500, minMoves: 2 }]);

    src.update(lock, record([
      { kind: 'gap', minMoves: 2, t0: 0, t1: 500 },
      { kind: 'move', move: 'R', t0: 500, t1: 600, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([
      { kind: 'gap', t0: 0, t1: 500, minMoves: 2 },
      { kind: 'move', move: 'R', t: 600, sure: true },
    ]);

    src.update(lock, record([
      { kind: 'gap', minMoves: 2, t0: 0, t1: 500 },
      { kind: 'move', move: 'R', t0: 500, t1: 600, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([
      { kind: 'gap', t0: 0, t1: 500, minMoves: 2 },
      { kind: 'move', move: 'R', t: 600, sure: true },
    ]);
  });

  it('a rewritten prefix yields exactly one resync to the new belief, no duplicate move items, then resumes normally', () => {
    const lock = scan('U');
    const src = new ReaderSource(lock, { now: () => 999 });

    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'move', move: 'U', t0: 100, t1: 200, margin: 5, sure: true },
    ]));
    expect(src.items()).toHaveLength(2);

    // the reader changed its mind about the second turn: U becomes F'
    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'move', move: "F'", t0: 100, t1: 250, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([
      { kind: 'move', move: 'R', t: 100, sure: true },
      { kind: 'move', move: 'U', t: 200, sure: true },
      { kind: 'resync', t: 999, facelets: applySeq(lock.facelets, ['R', "F'"]), how: 'report' },
    ]);
    expect(src.state()).toBe(applySeq(lock.facelets, ['R', "F'"]));

    // a further turn on top of the corrected path is emitted normally
    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'move', move: "F'", t0: 100, t1: 250, margin: 5, sure: true },
      { kind: 'move', move: 'D', t0: 250, t1: 300, margin: 5, sure: true },
    ]));
    expect(src.items().slice(3)).toEqual([{ kind: 'move', move: 'D', t: 300, sure: true }]);
    expect(src.state()).toBe(applySeq(lock.facelets, ['R', "F'", 'D']));
  });

  it('a re-lock yields a resync how: scan, and turns from the new record are emitted from a fresh start', () => {
    const lockA = scan('U');
    const src = new ReaderSource(lockA, { now: () => 999 });
    src.update(lockA, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([{ kind: 'move', move: 'R', t: 100, sure: true }]);

    const lockB = scan('D'); // a different facelet lock: a re-scan named it differently
    src.update(lockB, record([
      { kind: 'move', move: 'U', t0: 0, t1: 50, margin: 5, sure: true },
    ]));
    expect(src.items()).toEqual([
      { kind: 'move', move: 'R', t: 100, sure: true },
      { kind: 'resync', t: 999, facelets: lockB.facelets, how: 'scan' },
      { kind: 'move', move: 'U', t: 50, sure: true },
    ]);
    expect(src.state()).toBe(applySeq(lockB.facelets, ['U']));
  });

  it('colourOf follows the latest lock', () => {
    const lockA = scan('U', DEFAULT_SCHEME_NAMES);
    const src = new ReaderSource(lockA, { now: () => 999 });
    expect(src.colourOf).toEqual(DEFAULT_SCHEME_NAMES);

    const swapped: Record<FaceId, ColorName> = { ...DEFAULT_SCHEME_NAMES, R: 'orange', L: 'red' };
    const lockB: ScannedCube = { facelets: lockA.facelets, colourOf: swapped, solution: '' };
    src.update(lockB, record([]));
    expect(src.colourOf).toEqual(swapped);
  });

  it('subscribe receives every emitted item in order; unsubscribe stops delivery', () => {
    const lock = scan('U');
    const src = new ReaderSource(lock, { now: () => 999 });
    const heard: SourceItem[] = [];
    const unsubscribe = src.subscribe((it) => heard.push(it));

    src.update(lock, record([
      { kind: 'move', move: 'R', t0: 0, t1: 100, margin: 5, sure: true },
      { kind: 'gap', minMoves: 1, t0: 100, t1: 300 },
    ]));
    expect(heard).toEqual(src.items());
    expect(heard).toEqual([
      { kind: 'move', move: 'R', t: 100, sure: true },
      { kind: 'gap', t0: 100, t1: 300, minMoves: 1 },
    ]);

    unsubscribe();
    const lockB = scan('D');
    src.update(lockB, record([
      { kind: 'move', move: 'U', t0: 0, t1: 50, margin: 5, sure: true },
    ]));
    expect(heard).toHaveLength(2); // nothing more delivered after unsubscribe
    expect(src.items().length).toBeGreaterThan(2); // but the source kept recording
  });
});

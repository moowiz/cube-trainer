// A drill driven by a source (src/moves/drive.ts): arms at the scramble
// state, feeds the turns after it, re-arms on an undo, starts over on a
// new scramble, disarms on a resync.
import { describe, expect, it } from 'vitest';
import { SOLVED } from '../src/cube/state';
import { DrillDriver } from '../src/moves/drive';
import { applySeq, parseAlg, type Move } from '../src/moves/moves';
import type { SourceItem } from '../src/moves/source';

/** A source scripted by hand: items appended, the state = solved + every turn (a resync re-bases). */
function fake() {
  const items: SourceItem[] = [];
  let base = SOLVED, since = 0;
  let t = 1000;
  return {
    items: () => items,
    state: () => applySeq(base, items.slice(since).filter((i): i is Extract<SourceItem, { kind: 'move' }> => i.kind === 'move').map((i) => i.move)),
    turn(...ms: Move[]) { for (const m of ms) items.push({ kind: 'move', move: m, t: (t += 100), sure: true }); },
    resync(f: string) { items.push({ kind: 'resync', t: (t += 100), facelets: f, how: 'scan' }); base = f; since = items.length; },
  };
}
const scramble = parseAlg("R U F");
const expected = applySeq(SOLVED, scramble);

describe('DrillDriver', () => {
  it('ignores the scrambling, arms at the scramble state, then feeds every turn', () => {
    const src = fake(), d = new DrillDriver();
    expect(d.step(src, expected, 'eo:s1')).toEqual([]);
    src.turn('R', 'U');
    expect(d.step(src, expected, 'eo:s1')).toEqual([]);
    expect(d.isArmed()).toBe(false);
    src.turn('F');
    expect(d.step(src, expected, 'eo:s1')).toEqual([]);
    expect(d.isArmed()).toBe(true);
    src.turn("F'", "U'");
    expect(d.step(src, expected, 'eo:s1')).toEqual([{ moves: ["F'"], t: 1400 }, { moves: ["F'", "U'"], t: 1500 }]);
  });

  it('re-arms with an empty feed when the cube comes back to the scramble', () => {
    const src = fake(), d = new DrillDriver();
    src.turn('R', 'U', 'F');
    d.step(src, expected, 'k');
    src.turn('L');
    expect(d.step(src, expected, 'k')).toEqual([{ moves: ['L'], t: 1400 }]);
    src.turn("L'");
    expect(d.step(src, expected, 'k')).toEqual([{ moves: ['L', "L'"], t: 1500 }, { moves: [], t: 1500 }]);
    src.turn('D');
    expect(d.step(src, expected, 'k')).toEqual([{ moves: ['D'], t: 1600 }]);
  });

  it('finish() ends the attempt; a new key starts over from the turns after it', () => {
    const src = fake(), d = new DrillDriver();
    src.turn('R', 'U', 'F');
    d.step(src, expected, 'k1');
    src.turn('D');
    d.step(src, expected, 'k1');
    d.finish();
    src.turn('D');
    expect(d.step(src, expected, 'k1')).toEqual([]);
    expect(d.isArmed()).toBe(false);
    // the next scramble: back to R U F needs D2 undone; nothing is fed until then
    const next = expected;
    src.turn('D2');
    expect(d.step(src, next, 'k2')).toEqual([]);
    expect(d.isArmed()).toBe(true);
    src.turn('B');
    expect(d.step(src, next, 'k2')).toEqual([{ moves: ['B'], t: 1700 }]);
  });

  it('a resync disarms until the scramble state is seen again', () => {
    const src = fake(), d = new DrillDriver();
    src.turn('R', 'U', 'F');
    d.step(src, expected, 'k');
    src.resync(SOLVED);
    expect(d.step(src, expected, 'k')).toEqual([]);
    expect(d.isArmed()).toBe(false);
    src.turn('R', 'U', 'F');
    d.step(src, expected, 'k');
    expect(d.isArmed()).toBe(true);
  });

  it('with no stage up nothing is fed and nothing is remembered', () => {
    const src = fake(), d = new DrillDriver();
    src.turn('R', 'U', 'F', 'L');
    expect(d.step(src, null, null)).toEqual([]);
    src.turn("L'");
    expect(d.step(src, expected, 'k')).toEqual([]);
    expect(d.isArmed()).toBe(true);
  });
});

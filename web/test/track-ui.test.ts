// timer/track-ui.ts: the scramble-following markup and status every tab shows, and the watcher
// that keeps one tracker per (scramble, colours, hold).
import { describe, expect, it } from 'vitest';
import { SOLVED } from '../src/cube/state';
import { expectedFacelets } from '../src/handoff';
import { makeTrackWatcher, moveHtml, scrambleHtml, trackText } from '../src/timer/track-ui';
import { DEFAULT_SCHEME_NAMES } from '../src/types';

const hold = { down: 'white', front: 'green' } as const;

describe('moveHtml / scrambleHtml', () => {
  it('marks the prime and the 2, and the applied prefix as done', () => {
    expect(moveHtml("R'")).toBe('<span class="mv">R<span class="p">′</span></span>');
    expect(moveHtml('U2')).toBe('<span class="mv">U<span class="d">2</span></span>');
    expect(moveHtml('F')).toBe('<span class="mv">F</span>');
    const html = scrambleHtml(['R', 'U', 'F'], { applied: 2, total: 3, off: false, matched: false, half: false });
    expect(html.match(/class="done"/g)).toHaveLength(2);
    expect(html.startsWith('<span class="done">')).toBe(true);
    expect(scrambleHtml(['R'], null)).toBe('<span class=""><span class="mv">R</span></span>');
  });
});

describe('trackText', () => {
  const toks = ['R', 'U2', 'F'];
  it('says nothing without a cube, and where the cube is with one', () => {
    expect(trackText(null, toks)).toBe('');
    expect(trackText({ applied: 1, total: 3, off: false, matched: false, half: false }, toks)).toBe('1 of 3 applied');
    expect(trackText({ applied: 1, total: 3, off: false, matched: false, half: true }, toks)).toBe('1 of 3 applied · halfway through U2');
    expect(trackText({ applied: 3, total: 3, off: false, matched: true, half: false }, toks)).toBe('Scrambled ✓');
  });
  it('off the scramble: back to the last good turn, or the caller\'s own undo', () => {
    const off = { applied: 1, total: 3, off: true, matched: false, half: false };
    expect(trackText(off, toks)).toBe('Off the scramble: undo back to turn 1 (underlined)');
    expect(trackText(off, toks, "Off the scramble after L: undo with L'")).toBe("Off the scramble after L: undo with L'");
  });
});

describe('makeTrackWatcher', () => {
  it('follows a trainer-frame scramble on a cube in its own letters, and is null without a scramble', () => {
    const w = makeTrackWatcher();
    expect(w.status(null, SOLVED, DEFAULT_SCHEME_NAMES, hold)).toBeNull();
    expect(w.tracker()).toBeNull();
    const scr = "R U F'";
    expect(w.status(scr, SOLVED, DEFAULT_SCHEME_NAMES, hold)).toMatchObject({ applied: 0, total: 3, off: false, matched: false });
    const done = expectedFacelets(scr, hold, DEFAULT_SCHEME_NAMES);
    expect(w.status(scr, done, DEFAULT_SCHEME_NAMES, hold)).toMatchObject({ applied: 3, matched: true });
  });

  it('keeps the tracker across calls and rebuilds it when the scramble, the colours or the hold change', () => {
    const w = makeTrackWatcher();
    w.status('R U', SOLVED, DEFAULT_SCHEME_NAMES, hold);
    const first = w.tracker();
    w.status('R U', SOLVED, DEFAULT_SCHEME_NAMES, hold);
    expect(w.tracker()).toBe(first);
    w.status('R U', SOLVED, DEFAULT_SCHEME_NAMES, { down: 'white', front: 'blue' });
    expect(w.tracker()).not.toBe(first);
    const second = w.tracker();
    w.status("R U'", SOLVED, DEFAULT_SCHEME_NAMES, { down: 'white', front: 'blue' });
    expect(w.tracker()).not.toBe(second);
    w.reset();
    expect(w.tracker()).toBeNull();
  });

  it('is null for a scramble it cannot read, and recovers on the next good one', () => {
    const w = makeTrackWatcher();
    expect(w.status('R Q', SOLVED, DEFAULT_SCHEME_NAMES, hold)).toBeNull();
    expect(w.status('R', SOLVED, DEFAULT_SCHEME_NAMES, hold)).toMatchObject({ total: 1 });
  });
});

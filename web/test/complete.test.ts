import { describe, expect, it } from 'vitest';
import { completeFacelets } from '../src/colour/complete';
import { TRUTH } from './helpers';

const hide = (s: string, faces: number[]) => s.split('').map((c, i) => (faces.includes(Math.floor(i / 9)) ? '?' : c)).join('');

describe('completeFacelets', () => {
  it('a full valid cube is its own unique completion', () => {
    expect(completeFacelets(TRUTH)).toEqual({ facelets: TRUTH, solutions: 1, overflow: false });
  });
  it('one unseen face is usually forced by the pieces - and never wrongly', () => {
    // hiding L on this scramble leaves 4 legal completions (two L-edges show
    // the same colour on their visible side, so their hidden stickers can
    // swap along with a corner pair and keep parity): "five faces are
    // enough" holds for most faces, and the search says when it does not
    let forced = 0;
    for (let f = 0; f < 6; f++) {
      const c = completeFacelets(hide(TRUTH, [f]));
      expect(c.overflow).toBe(false);
      if (c.facelets) { forced++; expect(c.facelets).toBe(TRUTH); } else expect(c.solutions).toBe(2);
    }
    expect(forced).toBeGreaterThanOrEqual(3); // R, F, D on this scramble
    expect(completeFacelets(hide(TRUTH, [4])).solutions).toBe(2);
  });
  it('one unseen face plus scattered unknowns: forced while the pieces allow it, never wrong', () => {
    // even one extra unknown edge sticker can open a legal swap with one
    // of the hidden face's edges; what matters is that a unique answer is
    // always the truth and an ambiguous one is reported as such
    const p = hide(TRUTH, [1]).split('');
    for (const i of [1, 7, 20, 30, 40, 48]) {
      p[i] = '?';
      const c = completeFacelets(p.join(''));
      expect(c.overflow).toBe(false);
      if (c.facelets) expect(c.facelets).toBe(TRUTH);
      else expect(c.solutions).toBe(2);
    }
  });
  it('two unseen faces are (usually) not forced, and never wrongly forced', () => {
    let ambiguous = 0;
    for (const pair of [[0, 3], [1, 4], [2, 5], [0, 1], [2, 3]]) {
      const c = completeFacelets(hide(TRUTH, pair));
      if (c.facelets) expect(c.facelets).toBe(TRUTH);
      else ambiguous++;
    }
    expect(ambiguous).toBeGreaterThan(0);
  });
  it('a contradiction has no completion', () => {
    // two whites on one edge piece
    const p = hide(TRUTH, [1]).split('');
    p[28] = 'D'; p[25] = 'D';
    expect(completeFacelets(p.join('')).solutions).toBe(0);
  });
});

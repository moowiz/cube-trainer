// The fingertrick annotator: every token the parser accepts has a description, triggers are
// matched as one unit (longest first), opposite-face pairs become a both-hands row, and the
// rows cover the alg exactly.
import { describe, expect, it } from 'vitest';
import { annotate } from '../src/ui/fingertricks';

describe('fingertricks', () => {
  it('describes every face, slice, wide and rotation token', () => {
    const all = 'U U\' U2 R R\' R2 F F\' F2 D D\' D2 L L\' L2 B B\' B2 M M\' M2 E E\' E2 S S\' S2 x x\' x2 y y\' y2 z z\' z2 r r\' r2 l l\' l2 u u\' u2 d d\' d2 f f\' f2 b b\' b2 Rw Uw2';
    const rows = annotate(all);
    for (const r of rows) expect(r.how, r.moves.join(' ')).toMatch(/\S/);
    expect(rows.flatMap((r) => r.moves).length).toBe(all.split(' ').length);
  });

  it('matches triggers longest first and covers the alg exactly', () => {
    const rows = annotate("R U R' U R U2 R'"); // Sune
    expect(rows.map((r) => r.moves.join(' '))).toEqual(["R U R'", 'U', "R U2 R'"]);
    const sexy = annotate("F R U R' U' F'");
    expect(sexy.map((r) => r.name ?? r.moves.join(' '))).toEqual(['F', 'Sexy move', "F'"]);
    expect(annotate("R' F R F'")[0]!.name).toBe('Sledgehammer');
  });

  it('pairs opposite layers as one both-hands step, but not a wide move', () => {
    expect(annotate("R L' U")[0]).toMatchObject({ moves: ['R', "L'"], name: 'Both hands' });
    expect(annotate("r L").map((r) => r.moves.length)).toEqual([1, 1]);
  });

  it('notes the regrips from the context', () => {
    const rows = annotate('R F');
    expect(rows[1]!.tip).toMatch(/regrip/);
    expect(annotate('R U')[1]!.tip).toMatch(/no regrip/);
    expect(annotate('R R2')[1]!.tip).toMatch(/one move/);
  });

  it('throws on a token it cannot read', () => {
    expect(() => annotate('R Q')).toThrow(/Could not read/);
  });
});

// The fingertrick annotator: every token the parser accepts has a description, triggers are
// matched as one unit (longest first), opposite-face pairs become a both-hands row, and the
// rows cover the alg exactly.
import { describe, expect, it } from 'vitest';
import { annotate, triggers } from '../src/ui/fingertricks';

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

  it('names the triggers in a PLL by position: Y perm ends sexy, sledge', () => {
    expect(triggers("F R U' R' U' R U R' F' R U R' U' R' F R F'")).toEqual([{ at: 0, n: 9, label: 'Y base' }, { at: 9, n: 4, label: 'sexy' }, { at: 13, n: 4, label: 'sledge' }]);
    // T perm: the T core takes the first nine; sexy inside it and the reverse sexy straddling its end go unlabelled
    expect(triggers("R U R' U' R' F R2 U' R' U' R U R' F'")).toEqual([{ at: 0, n: 9, label: 'T core' }]);
    expect(triggers("R U R' F' R U R' U' R' F R2 U' R'")).toEqual([{ at: 4, n: 9, label: 'T core' }]); // Jb = R U R' F' + T core
    expect(triggers("x' R U' R' D R U R' D' R U R' D R U' R' D' x")).toEqual([{ at: 1, n: 8, label: "E half, U' first" }, { at: 9, n: 8, label: 'E half, U first' }]); // E perm
    // the G perms: one nine-move block each (the same block in its four guises), then a D conjugate
    expect(triggers("R2 U R' U R' U' R U' R2 U' D R' U R D'")).toEqual([{ at: 0, n: 9, label: 'Ga block' }, { at: 10, n: 5, label: "D [R' U R] D'" }]); // Ga
    expect(triggers("R' U' R U D' R2 U R' U R U' R U' R2 D").map((g) => g.label)).toEqual(['reverse sexy', 'Gb block']);
    expect(triggers("R2 U' R U' R U R' U R2 U D' R U' R' D").map((g) => g.label)).toEqual(['Gc block', "D' [R U' R'] D"]);
    expect(triggers("R U R' U' D R2 U' R U' R' U R' U R2 D'").map((g) => g.label)).toEqual(['sexy', 'Gd block']);
    // the longest match anywhere wins: Jb keeps its T core although "sexy R' in F'" would start a move earlier
    expect(triggers("R U R' F' R U R' U' R' F R2 U' R'").map((g) => g.label)).toEqual(['T core']);
    expect(triggers("R' U R U' R' F' U' F R U R' F R' F' R U' R").map((g) => [g.at, g.label])).toEqual([[4, "R' [F' U' F] R"], [10, "R' [F R' F'] R"]]); // Nb's face-turn alt
    expect(triggers("r' D' F r U' r' F' D r2 U r' U' r' F r F'").map((g) => [g.at, g.label])).toEqual([[12, 'wide sledge']]); // Nb (J Perm's, wide moves)
    expect(triggers("x R' U R' D2 R U' R' D2 R2 x'").map((g) => [g.at, g.n, g.label])).toEqual([[2, 8, 'A commutator']]); // Aa (the closing R and the R after are the R2)
    expect(triggers("x R2 D2 R U R' D2 R U' R x'").map((g) => [g.at, g.n, g.label])).toEqual([[1, 8, 'A commutator backwards']]); // Ab (an R' and the opening R' are the R2)
    expect(triggers("R' U2 R U2 R' F R U R' U' R' F' R2").map((g) => [g.at, g.label])).toEqual([[5, "F [sexy R'] F'"]]); // Rb
    expect(triggers("R U2 R' U' R U' R'")).toEqual([]); // R U2 R' is a unit but not a named trigger
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

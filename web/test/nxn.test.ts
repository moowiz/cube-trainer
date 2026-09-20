// The n×n facelet model (src/cube/nxn.ts). The anchor is cubejs: for n=3
// every token the 3x3 parser accepts must give the same facelet string as
// cubejs does, which pins the reading order, every axis direction and the
// wide / slice semantics at once. The rest are identities between the
// big-cube spellings (Rw = R 2R, M = 2L 3L on a 4x4...) and the parser's
// brackets.
import { describe, expect, it } from 'vitest';
import { applyNxN, diffNxN, expandNxN, invertTokens, pieceTypeNxN, rawNxN, solvedNxN, stickerPos } from '../src/cube/nxn';
import { SOLVED, rawFacelets, state } from '../src/cube/state';

const NS = [2, 3, 4, 5, 6, 7];
const SUF = ['', "'", '2'];

describe('n=3 reproduces cubejs', () => {
  it('the solved string is the same', () => { expect(solvedNxN(3)).toBe(SOLVED); });
  const singles = [...'URFDLBMESxyz', ...'urfdlb'].flatMap((m) => SUF.map((s) => m + s));
  const wide = [...'URFDLB'].flatMap((m) => SUF.map((s) => `${m}w${s}`));
  const algs = [
    ...singles, ...wide,
    "R U R' U'", "Rw U2 x Rw U2 Rw U2 Rw' U2 Lw U2 Rw' U2 Rw U2 Rw' U2 Rw'", 'M2 U M2 U2 M2 U M2',
    "x' R U' R' D R U R' D' R U R' D R U' R' D' x", "F' r U R' U' r' F R", "y R' F R F' R U2 R' U R U2 R'", "z' Uw F' D' F D' L D L' Uw' z",
  ];
  for (const alg of algs) {
    it(`raw: ${alg}`, () => { expect(rawNxN(3, alg)).toBe(rawFacelets(alg)); });
    it(`frame undone: ${alg}`, () => { expect(applyNxN(3, alg)).toBe(state(alg)); });
  }
});

describe('every move has order 4, and its inverse undoes it', () => {
  for (const n of NS) {
    const moves = [...'URFDLBMESxyz', ...'urfdlb', ...[...'URFDLB'].map((f) => `${f}w`), ...(n >= 4 ? ['2R', '2U', `${n - 1}L`, '3Rw', '2-3Rw'] : [])];
    it(`n=${n}`, () => {
      for (const m of moves) {
        expect(rawNxN(n, `${m} ${m} ${m} ${m}`), m).toBe(solvedNxN(n));
        expect(rawNxN(n, `${m} ${m}'`), m).toBe(solvedNxN(n));
        expect(rawNxN(n, `${m}2`), m).toBe(rawNxN(n, `${m} ${m}`));
        expect(rawNxN(n, `${m}2'`), m).toBe(rawNxN(n, `${m} ${m}`));
        expect(rawNxN(n, m), m).not.toBe(solvedNxN(n));
      }
    });
  }
});

describe('big-cube spellings agree', () => {
  const same = (n: number, a: string, b: string) => expect(rawNxN(n, a), `${a} vs ${b}`).toBe(rawNxN(n, b));
  it('4x4', () => {
    same(4, 'Rw', 'R 2R'); same(4, 'r', 'Rw'); same(4, '2R', "Rw R'"); same(4, 'M', '2L 3L'); same(4, 'M', "2R' 3R'");
    same(4, 'x', "R 2R 3R L'"); same(4, '3Rw', 'R 2R 3R'); same(4, '2-3Rw', '2R 3R'); same(4, 'u', 'Uw'); same(4, 'Uw', 'U 2U');
    same(4, '4Rw', 'x'); same(4, "Uw2", "U2 2U2"); same(4, 'E', "2D 3D"); same(4, 'S', '2F 3F');
  });
  it('5x5', () => {
    same(5, '3Rw', 'R 2R 3R'); same(5, 'M', '3L'); same(5, '3R', "3L'"); same(5, "M'", '3R'); same(5, '3r', '3Rw'); same(5, '2-4Rw', '2R 3R 4R');
    same(5, 'x', "R 2R 3R 4R L'"); same(5, 'Lw', 'L 2L'); same(5, '2L', "4R'");
  });
  it('2x2 and 3x3', () => { same(2, 'Rw', 'x'); same(3, 'M', "Rw' R"); same(3, 'Rw', 'x L'); same(3, '3Rw', 'x'); });
  it('7x7', () => { same(7, 'M', '4L'); same(7, '3-5Rw', '3R 4R 5R'); same(7, '7Rw', 'x'); });
});

describe('the parser', () => {
  it('expands commutators, conjugates and repeats', () => {
    expect(expandNxN('[R, U]')).toEqual(['R', 'U', "R'", "U'"]);
    expect(expandNxN('[R: U]')).toEqual(['R', 'U', "R'"]);
    expect(expandNxN('(R U)2')).toEqual(['R', 'U', 'R', 'U']);
    expect(expandNxN("(R U)'")).toEqual(["U'", "R'"]);
    expect(expandNxN("(R U)2'")).toEqual(["U'", "R'", "U'", "R'"]);
    expect(expandNxN('[R U: [F, D]]')).toEqual(['R', 'U', 'F', 'D', "F'", "D'", "U'", "R'"]);
    expect(expandNxN("[R' L R L', U]")).toEqual(["R'", 'L', 'R', "L'", 'U', 'L', "R'", "L'", 'R', "U'"]);
    expect(expandNxN('2R2 U2 2R2 Uw2 2R2 Uw2')).toEqual(['2R2', 'U2', '2R2', 'Uw2', '2R2', 'Uw2']);
    expect(expandNxN("(Lw' U2 Lw') U2 F2 Lw' F2 Rw U2 (Rw' U2 Lw2)")).toHaveLength(12);
  });
  it('inverts token lists', () => {
    expect(invertTokens(['R', "U'", '2R2', "3Rw'", "F2'"])).toEqual(['F2', '3Rw', '2R2', 'U', "R'"]);
  });
  it('rejects what it cannot read', () => {
    for (const [n, t] of [[4, 'Q'], [4, '4R'], [4, '5Rw'], [4, 'R3'], [3, '3R'], [4, '2x'], [4, 'Rw3'], [4, '(R'], [4, '[R U]']] as [number, string][]) {
      expect(() => rawNxN(n, t), `${n}: ${t}`).toThrow(/Could not read/);
    }
  });
});

describe('frames', () => {
  for (const n of NS) {
    it(`n=${n}: rotations alone are undone; sexy six times and the 4x4 PLL parity twice are the identity`, () => {
      for (const r of ['x', 'y2', 'x y z', "z' x2 y"]) expect(applyNxN(n, r), r).toBe(solvedNxN(n));
      expect(applyNxN(n, "(R U R' U')6")).toBe(solvedNxN(n));
      if (n === 4) expect(applyNxN(4, '(2R2 U2 2R2 Uw2 2R2 Uw2)2')).toBe(solvedNxN(4));
    });
  }
  it('a rotation inside an alg is undone at the end: y R is B, x U is F', () => {
    for (const n of NS) { expect(applyNxN(n, 'y R')).toBe(applyNxN(n, 'B')); expect(applyNxN(n, "x U x'")).toBe(applyNxN(n, 'F')); expect(applyNxN(n, "x U")).toBe(applyNxN(n, 'F')); expect(applyNxN(n, "y R y'")).toBe(applyNxN(n, 'B')); }
  });
  it('odd cubes home their centres after a wide move; even ones do not pretend to', () => {
    expect(applyNxN(3, 'Rw')).toBe(state('Rw'));
    const five = applyNxN(5, 'Rw');
    for (let f = 0; f < 6; f++) expect(five[f * 25 + 12]).toBe('URFDLB'[f]);
    expect(applyNxN(4, 'Rw')).toBe(rawNxN(4, 'Rw'));
    expect(applyNxN(4, 'Rw')).not.toBe(solvedNxN(4));
  });
});

describe('pieces', () => {
  const count = (n: number) => { const c = { corner: 0, edge: 0, centre: 0 }; for (let i = 0; i < 6 * n * n; i++) c[pieceTypeNxN(n, i)]++; return c; };
  it('sticker counts by piece type', () => {
    expect(count(2)).toEqual({ corner: 24, edge: 0, centre: 0 });
    expect(count(3)).toEqual({ corner: 24, edge: 24, centre: 6 });
    expect(count(4)).toEqual({ corner: 24, edge: 48, centre: 24 });
    expect(count(5)).toEqual({ corner: 24, edge: 72, centre: 54 });
  });
  it('stickerPos reads each face the way cubejs does', () => {
    expect(stickerPos(3, 0)).toEqual({ face: 'U', x: 0, y: 2, z: 0 }); // U1: back-left
    expect(stickerPos(3, 8)).toEqual({ face: 'U', x: 2, y: 2, z: 2 }); // U9: front-right
    expect(stickerPos(3, 9)).toEqual({ face: 'R', x: 2, y: 2, z: 2 }); // R1: top-front
    expect(stickerPos(3, 18)).toEqual({ face: 'F', x: 0, y: 2, z: 2 }); // F1: top-left
    expect(stickerPos(3, 27)).toEqual({ face: 'D', x: 0, y: 0, z: 2 }); // D1: front-left
    expect(stickerPos(3, 36)).toEqual({ face: 'L', x: 0, y: 2, z: 0 }); // L1: top-back
    expect(stickerPos(3, 45)).toEqual({ face: 'B', x: 2, y: 2, z: 0 }); // B1: top-right
  });
  it('diffNxN lists changed stickers; a 4x4 PLL parity changes only top-layer edge stickers', () => {
    const after = applyNxN(4, '2R2 U2 2R2 Uw2 2R2 Uw2 U2');
    const moved = diffNxN(solvedNxN(4), after);
    expect(moved.length).toBeGreaterThan(0);
    for (const i of moved) { expect(pieceTypeNxN(4, i)).toBe('edge'); expect(stickerPos(4, i).y).toBe(3); }
  });
});

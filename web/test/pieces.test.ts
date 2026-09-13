// Piece-uniqueness resolution (state.ts resolveByPieces): a near-tie sticker
// read as the wrong colour makes an impossible piece; flipping it to its
// runner-up restores a legal cube.
import { describe, expect, it } from 'vitest';
import { PIECE_AMBIGUOUS_CONF, resolveByPieces, resolveByRotation, validateState, type AssembledState } from '../src/state';
import { FACE_ORDER } from '../src/types';
import type { FaceId } from '../src/types';

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const OPP: Record<FaceId, FaceId> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

function state(facelets: string, second: (i: number, f: FaceId) => FaceId, low: number[]): AssembledState {
  const stickerFaces = facelets.split('') as FaceId[];
  return {
    facelets,
    stickerFaces,
    confidences: stickerFaces.map((_, i) => (low.includes(i) ? 0.1 : 0.9)),
    centroids: Object.fromEntries(FACE_ORDER.map((f) => [f, { L: 50, a: 0, b: 0 }])) as AssembledState['centroids'],
    secondFaces: stickerFaces.map((f, i) => second(i, f)),
  };
}

describe('resolveByPieces', () => {
  it('leaves a valid state alone', () => {
    const s = state(SOLVED, (_, f) => OPP[f], [0, 1]);
    expect(resolveByPieces(s)).toBe(s);
  });

  it('flips one red/orange near-tie that broke a corner', () => {
    // solved cube with sticker R1 (index 9, corner URF) read as orange: two
    // corners would carry (U, L, F) and none (U, R, F); the count check
    // fails too. Runner-up for the low-confidence sticker is red.
    const bad = SOLVED.slice(0, 9) + 'L' + SOLVED.slice(10);
    expect(validateState(bad).ok).toBe(false);
    const s = state(bad, (i, f) => (i === 9 ? 'R' : OPP[f]), [9]);
    const r = resolveByPieces(s);
    expect(r.facelets).toBe(SOLVED);
    expect(r.flipped).toEqual([9]);
  });

  it('resolves two swapped stickers (counts still nine each) through the piece tables', () => {
    // swap R1 and L1 (indices 9 and 36): nine of each colour, but corners
    // URF and DLF... every piece touching them is impossible.
    const arr = SOLVED.split('');
    [arr[9], arr[36]] = [arr[36]!, arr[9]!];
    const bad = arr.join('');
    expect(validateState(bad).ok).toBe(false);
    const s = state(bad, (i, f) => (i === 9 ? 'R' : i === 36 ? 'L' : OPP[f]), [9, 36, 4 /* a centre, never flipped */]);
    const r = resolveByPieces(s);
    expect(r.facelets).toBe(SOLVED);
    expect(r.flipped).toEqual([9, 36]);
  });

  it('does not touch confident stickers even when nothing validates', () => {
    const bad = SOLVED.slice(0, 9) + 'L' + SOLVED.slice(10);
    const s = state(bad, (i, f) => (i === 9 ? 'R' : OPP[f]), []); // nothing below the threshold
    expect(s.confidences[9]).toBeGreaterThan(PIECE_AMBIGUOUS_CONF);
    expect(resolveByPieces(s).facelets).toBe(bad);
  });
});

// The screenshot session of 2026-09-13 08:06: every colour right, nine per
// face, invalid pieces - L was a quarter turn off and B a half turn. The
// piece constraints pin the rotations uniquely among 4^6.
describe('resolveByRotation', () => {
  const faces = ['LRFLUFLBU', 'BLDLRRRRF', 'DDRUFDUFD', 'FDBUDFRDL', 'BFLBLLBUU', 'FRDBBUUBR'];
  const facelets = faces.join('');
  const fake = (s: string): AssembledState => ({
    facelets: s,
    stickerFaces: s.split('') as FaceId[],
    confidences: Array.from({ length: 54 }, () => 1),
    centroids: {} as AssembledState['centroids'],
    secondFaces: s.split('') as FaceId[],
  });

  it('turns L by one and B by two quarter turns and the state validates', () => {
    expect(validateState(facelets).ok).toBe(false);
    const fixed = resolveByRotation(fake(facelets));
    expect(fixed.turned).toEqual([0, 0, 0, 0, 1, 2]);
    expect(validateState(fixed.facelets).ok).toBe(true);
    // colours are untouched: each face still holds the same nine stickers
    for (let f = 0; f < 6; f++) {
      expect([...fixed.facelets.slice(f * 9, f * 9 + 9)].sort().join('')).toBe([...faces[f]!].sort().join(''));
    }
  });

  it('leaves a valid state alone and a wrong colour count alone', () => {
    const solved = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
    expect(resolveByRotation(fake(solved)).turned).toBeUndefined();
    const bad = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBU';
    expect(resolveByRotation(fake(bad)).facelets).toBe(bad);
  });
});

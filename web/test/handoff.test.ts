import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { frameMap, relabelMoves, trainerScramble, type ScannedCube } from '../src/handoff';
import { randomScramble, scrambleState } from '../src/scramble';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../src/types';
import type { ColorName, FaceId } from '../src/types';
import { makeLcg } from './helpers';

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const mapLetters = (s: string, map: Record<FaceId, FaceId>) => [...s].map((c) => map[c as FaceId]).join('');

/** The whole-cube rotation (as cubejs x/y/z moves) that realises a letter map: solved, rotated, relabelled is solved again. */
function rotationFor(map: Record<FaceId, FaceId>): string {
  const turns = ['', 'x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];
  for (const a of turns) for (const b of turns) {
    const rot = `${a} ${b}`.trim();
    if (mapLetters(new Cube().move(rot).asString(), map) === SOLVED) return rot;
  }
  throw new Error('no rotation realises the map');
}

describe('frameMap', () => {
  it('is the identity for the standard frame', () => {
    expect(frameMap('D', 'F')).toEqual({ U: 'U', R: 'R', F: 'F', D: 'D', L: 'L', B: 'B' });
  });
  it('white down, blue front is x2 (U/D and F/B swap, R/L stay)', () => {
    expect(frameMap('U', 'B')).toEqual({ U: 'D', D: 'U', F: 'B', B: 'F', R: 'R', L: 'L' });
  });
  it('is a rotation (chirality kept) for every adjacent pair', () => {
    for (const down of FACE_ORDER) for (const front of FACE_ORDER) {
      if (down === front || frameMap('D', 'F')[down] === frameMap('D', 'F')[front]) continue;
      let map: Record<FaceId, FaceId>;
      try { map = frameMap(down, front); } catch { continue; }
      expect(new Set(Object.values(map)).size).toBe(6);
      expect(() => rotationFor(map)).not.toThrow();
    }
  });
  it('refuses opposite or equal faces', () => {
    expect(() => frameMap('U', 'D')).toThrow();
    expect(() => frameMap('F', 'F')).toThrow();
  });
});

describe('relabelMoves', () => {
  it('keeps the turn, renames the face', () => {
    expect(relabelMoves("U R2 F' D", frameMap('U', 'B'))).toBe("D R2 B' U");
  });
  it('rejects rotations and slices (not face turns)', () => {
    expect(() => relabelMoves('x U', frameMap('D', 'F'))).toThrow();
  });
});

describe('trainerScramble', () => {
  const colourOf = DEFAULT_SCHEME_NAMES;   // a standard cube: white U, green F
  const scan = (scramble: string): ScannedCube => {
    const facelets = scrambleState(scramble);
    // any alg that solves it will do: the inverse scramble is one, and needs no solver tables
    return { facelets, colourOf, solution: Cube.inverse(scramble) };
  };

  it('reproduces the scanned cube in the trainer frame (white down, each front colour)', () => {
    const rnd = makeLcg(7);
    for (const front of ['blue', 'red', 'green', 'orange'] as ColorName[]) {
      for (let i = 0; i < 4; i++) {
        const s = scan(randomScramble(20, rnd));
        const out = trainerScramble(s, { down: 'white', front });
        const map = frameMap('U', FACE_ORDER.find((f) => colourOf[f] === front)!);
        const physical = mapLetters(Cube.fromString(s.facelets).move(rotationFor(map)).asString(), map);
        expect(new Cube().move(out).asString()).toBe(physical);
      }
    }
  });

  it('a solved cube is an empty scramble', () => {
    expect(trainerScramble(scan(''), { down: 'white', front: 'blue' })).toBe('');
  });

  it('refuses a scan whose down and front colours are not adjacent', () => {
    expect(() => trainerScramble(scan('R U'), { down: 'white', front: 'yellow' })).toThrow();
  });
});

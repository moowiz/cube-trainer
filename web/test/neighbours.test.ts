import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { forEachLegalNeighbour, refineLegal } from '../src/colour/neighbours';
import { coloursToFacelets } from '../src/colour/decode';
import { validateState } from '../src/state';
import { FACE_ORDER } from '../src/types';

const toColours = (f: string) => [...f].map((c) => FACE_ORDER.indexOf(c as never));
const STATES = [
  'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB',
  new Cube().move("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D").asString(),
  new Cube().move("R U R' U' F2 L D B' R2 U F").asString(),
];

describe('legal neighbours', () => {
  it('every elementary move of a legal cube is a different legal cube', () => {
    for (const f of STATES) {
      const colours = toColours(f);
      const cost = colours.map(() => [0, 0, 0, 0, 0, 0]);
      let n = 0;
      const seen = new Set<string>();
      forEachLegalNeighbour(cost, colours, (nb) => {
        const c = colours.slice();
        const vals = nb.from.map((s) => colours[s]!);
        nb.to.forEach((s, i) => { c[s] = vals[i]!; });
        const s = coloursToFacelets(c);
        expect(s).not.toBe(f);
        expect(validateState(s).ok, s).toBe(true);
        seen.add(s);
        n++;
      });
      expect(n).toBeGreaterThan(10000);
      expect(seen.size).toBeGreaterThan(5000);
    }
  });
  it('refineLegal climbs to the truth when the evidence says so and reports a positive delta', () => {
    const truth = STATES[1]!;
    const tc = toColours(truth);
    const cost = tc.map((c) => [0, 1, 2, 3, 4, 5].map((k) => (k === c ? 0 : 8)));
    // start from a legal neighbour of the truth (two edges flipped): the climb must undo it
    const start = tc.slice();
    const [a, b] = [[5, 10], [7, 19]];
    [start[a![0]!], start[a![1]!]] = [start[a![1]!]!, start[a![0]!]!];
    [start[b![0]!], start[b![1]!]] = [start[b![1]!]!, start[b![0]!]!];
    expect(validateState(coloursToFacelets(start)).ok).toBe(true);
    const r = refineLegal(cost, start);
    expect(coloursToFacelets(r.colours)).toBe(truth);
    expect(r.delta).toBeGreaterThan(0);
  });
});

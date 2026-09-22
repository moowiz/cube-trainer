// The FTO model (cube/fto.ts) against two models that were not written
// here: cubing.js for Ben's notation and lowcubes' image generator for the
// edge-in-front notation, both baked into fixtures/fto-oracle.json by
// scripts/fto-oracle.mjs as piece maps keyed by touch sets. A base move's
// layer, its direction, the slices, wide moves, whole-puzzle and corner
// rotations, and every alg on the sheet are all pinned by it.
import { describe, expect, it } from 'vitest';
import { FTO_FACES, FTO_STICKERS, applyFto, diffFto, ftoTokens, invertFto, layerFto, pieceTypeFto, solvedFto, twizzleFto, type FtoFrame, type FtoState } from '../src/cube/fto';
import { fixtureJson } from './helpers';

interface Oracle { ben: { alg: string; ran: string; pieces: Record<string, string> }[]; eif: { alg: string; ran: string; pieces: Record<string, string> }[] }
const oracle = fixtureJson<Oracle>('fto-oracle.json');

/** Each position's touch set: the faces whose turn moves it, joined the way the fixture names pieces. */
const touch = FTO_STICKERS.map(() => new Set<string>());
for (const f of FTO_FACES) for (const i of layerFto(f)) touch[i]!.add(f);
const pieceName = (i: number) => [...touch[i]!].sort().join('+');
const identity = (): FtoState => FTO_STICKERS.map((s) => s.idx);

/** The alg as the fixture describes it: for every piece that moved, which piece is now in its place. */
function pieces(alg: string, frame: FtoFrame): Record<string, string> {
  const after = applyFto(alg, identity(), frame);
  const out: Record<string, string> = {};
  for (let i = 0; i < 72; i++) {
    const from = after[i]!;
    if (from === i) continue;
    const p = pieceName(i), q = pieceName(from);
    if (p === q) continue; // twisted in place: the fixture records where pieces went, not how they turned
    if (p in out && out[p] !== q) throw new Error(`${alg}: the stickers at ${p} came from two pieces`);
    out[p] = q;
  }
  return out;
}

describe('the geometry', () => {
  it('has 72 stickers: 24 corner, 24 edge, 24 centre', () => {
    const count = (k: string) => FTO_STICKERS.filter((s) => s.kind === k).length;
    expect([count('corner'), count('edge'), count('centre')]).toEqual([24, 24, 24]);
  });
  it('names pieces by touch set: 6 corners of 4 stickers, 12 edges of 2, 24 centres of 1', () => {
    const groups = new Map<string, number[]>();
    FTO_STICKERS.forEach((s) => groups.set(pieceName(s.idx), [...(groups.get(pieceName(s.idx)) ?? []), s.idx]));
    const sizes = [...groups.entries()].map(([name, idx]) => [name.split('+').length, idx.length, pieceTypeFto(idx[0]!)]);
    expect(sizes.filter(([n]) => n === 4)).toHaveLength(6);
    expect(sizes.filter(([n]) => n === 2)).toHaveLength(12);
    expect(sizes.filter(([n]) => n === 3)).toHaveLength(24);
    for (const [n, size, kind] of sizes) expect([size, kind]).toEqual(n === 4 ? [4, 'corner'] : n === 2 ? [2, 'edge'] : [1, 'centre']);
  });
  it('a face turn moves 27 stickers and has order 3', () => {
    for (const f of FTO_FACES) {
      expect(layerFto(f)).toHaveLength(27);
      expect(diffFto(solvedFto(), applyFto(f))).toHaveLength(27 - 9); // its own nine keep their colour
      expect(applyFto(`${f} ${f} ${f}`, identity())).toEqual(identity());
      expect(applyFto(`${f} ${f}'`, identity())).toEqual(identity());
      expect(applyFto(`${f}2`, identity())).toEqual(applyFto(`${f}'`, identity()));
      expect(applyFto(`${f}2'`, identity())).toEqual(applyFto(f, identity()));
    }
  });
  it('a wide move is the face and its slice; a rotation is the face, its slice and the opposite face', () => {
    expect(applyFto('Uw', identity())).toEqual(applyFto('U Us', identity()));
    expect(applyFto('Uo', identity())).toEqual(identity()); // a rotation turns the frame, not the stickers
    expect(diffFto(solvedFto(), applyFto("U Us D'"))).toHaveLength(54); // the same turn done as moves: every sticker but U's and D's changes colour
  });
  it('rejects a token it cannot read', () => {
    expect(() => applyFto('U X')).toThrow(/Could not read: X/);
    expect(() => applyFto('Rt', solvedFto(), 'ben')).toThrow(/Could not read: Rt/);
    expect(() => applyFto('BL', solvedFto(), 'eif')).toThrow(/Could not read: BL/);
  });
});

describe("Ben's notation against cubing.js", () => {
  for (const { alg, pieces: want } of oracle.ben) {
    it(alg, () => { expect(pieces(alg, 'ben')).toEqual(want); });
  }
});

describe("lowcubes' edge-in-front notation against its own model", () => {
  for (const { alg, pieces: want } of oracle.eif) {
    it(alg, () => { expect(pieces(alg, 'eif')).toEqual(want); });
  }
});

describe('inverse and the twizzle spelling', () => {
  const algs = [...oracle.ben.map((o) => [o.alg, 'ben'] as const), ...oracle.eif.map((o) => [o.alg, 'eif'] as const)];
  it('an alg followed by its inverse is the identity', () => {
    for (const [alg, frame] of algs) expect(applyFto(`${alg} ${invertFto(ftoTokens(alg)).join(' ')}`, identity(), frame), alg).toEqual(identity());
  });
  it("the rotation-free Ben's spelling does the same thing", () => {
    for (const [alg, frame] of algs) {
      const plain = twizzleFto(alg, frame);
      expect(plain, alg).not.toMatch(/[wsov]|Rt|Lt|Ft|Bl|Br/);
      expect(applyFto(plain, identity()), `${alg} -> ${plain}`).toEqual(applyFto(alg, identity(), frame));
    }
  });
  it('spells the slices and wide moves the way cubing.js reads them', () => {
    expect(twizzleFto("Us Rw' BLo F")).toBe("2U R' 2R' U"); // after BLo (about BL, so clockwise-looking-at-BL) the face at F is ... checked by the previous test; this pins the spelling
  });
});

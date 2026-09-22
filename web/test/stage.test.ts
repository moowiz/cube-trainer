import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { stageOf } from '../src/stage';
import { SOLVED } from '../src/cube/state';

const after = (alg: string) => new Cube().move(alg).asString();

describe('stageOf', () => {
  it('solved cube: stage solved, everything maxed out', () => {
    expect(stageOf(SOLVED)).toEqual({ stage: 'solved', eoBad: 0, cross: 4, pairs: 4, ocll: true });
  });

  it('F: a quarter turn flips 4 edges relative to the F/B axis', () => {
    const r = stageOf(after('F'));
    expect(r.eoBad).toBe(4);
    expect(r.stage).toBe('eo');
  });

  it('F2: a half turn flips nothing, but breaks the cross', () => {
    const r = stageOf(after('F2'));
    expect(r.eoBad).toBe(0);
    expect(r.cross).toBe(3);
    expect(r.stage).toBe('eo');
  });

  it("R U R' U': EO and cross intact, one F2L pair broken", () => {
    const r = stageOf(after("R U R' U'"));
    expect(r.eoBad).toBe(0);
    expect(r.cross).toBe(4);
    expect(r.pairs).toBe(3);
    expect(r.stage).toBe('f2l');
  });

  it('Sune: F2L solved, last layer not oriented', () => {
    const r = stageOf(after("R U R' U R U2 R'"));
    expect(r.cross).toBe(4);
    expect(r.pairs).toBe(4);
    expect(r.ocll).toBe(false);
    expect(r.stage).toBe('ocll');
  });

  it('T-perm: OCLL done, permutation left; its F turns cancel so EO stays clean', () => {
    const r = stageOf(after("R U R' U' R' F R2 U' R' U' R U R' F'"));
    expect(r.eoBad).toBe(0);
    expect(r.pairs).toBe(4);
    expect(r.ocll).toBe(true);
    expect(r.stage).toBe('pll');
  });

  it('U: everything else solved, one clean permutation move left', () => {
    expect(stageOf(after('U')).stage).toBe('pll');
  });

  it('a long scramble with F/B quarter turns: eo stage, EO parity holds (bad count is even)', () => {
    const r = stageOf(after("F R' B U L D2 F' B"));
    expect(r.stage).toBe('eo');
    expect(r.eoBad % 2).toBe(0);
  });

  it('throws on a malformed facelet string', () => {
    expect(() => stageOf('not a cube')).toThrow();
    expect(() => stageOf(SOLVED.slice(0, 53))).toThrow();
  });
});

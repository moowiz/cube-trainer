// The EO strategy note's reading of a case, on states built from slot names
// (the 12-edge model, no facelets needed).
import { describe, expect, it } from 'vitest';
import { SLOT_INDEX, type EdgeState } from '../src/cube/pieces';
import { EO_STRATEGY_SHORT, eoCaseStrategy, planWords, readEO, slotName } from '../src/eo/patterns';
import { solveEO } from '../src/eo/solver';

const at = (...slots: string[]): EdgeState => ({ eo: slots.reduce((v, n) => v | (1 << SLOT_INDEX[n]), 0), slots: [4, 5, 6, 7] });
const read = (...slots: string[]) => { const st = at(...slots); return readEO(st, solveEO(st.eo)); };

describe('readEO', () => {
  it('counts what the note describes', () => {
    const r = read('UF', 'UB', 'UR', 'DL');
    expect(r.bad).toBe(4);
    expect(r.offAxis).toBe(2);
    expect(r.acrossPairs).toBe(1);
    expect(r.onFace).toEqual({ F: 1, B: 1 });
  });
  it('a face with four bad: turn it, one move', () => {
    const r = read('UF', 'DF', 'FR', 'FL');
    expect(r.length).toBe(1);
    expect(r.plans).toEqual([{ key: '4', counts: [4], n: 2 }]);
    expect(r.checks).toEqual([{ face: 'F', bad: 4, extra: 0 }]);
    expect(r.firstFB).toBe(r.total);
  });
  it('all twelve bad: three F/B turns, seven moves', () => {
    const r = read(...['UF', 'UR', 'UB', 'UL', 'DF', 'DR', 'DB', 'DL', 'FR', 'FL', 'BR', 'BL']);
    expect(r.length).toBe(7);
    expect(r.plans.map((p) => p.key)).toEqual(['4-4-4']);
    expect(r.checks.map((c) => c.extra)).toEqual([0, 0]);
  });
  it('the 3-on-a-face rule and its exception', () => {
    // three on the front, three on the back: F L2 B - turning the front now is optimal
    const ok = read('UF', 'FR', 'FL', 'UB', 'DB', 'BR');
    expect(ok.length).toBe(3);
    expect(ok.checks).toEqual([{ face: 'F', bad: 3, extra: 0 }, { face: 'B', bad: 3, extra: 0 }]);
    // the measured counter-example: optimal is B L F B; turning the front first leaves the last four across the rings
    const bad = read('UF', 'UB', 'UL', 'DF', 'DL', 'FR');
    expect(bad.length).toBe(4);
    expect(bad.checks.find((c) => c.face === 'F')).toEqual({ face: 'F', bad: 3, extra: 2 });
  });
  it('two bad edges straight across is the five-move case', () => {
    const r = read('UF', 'UB');
    expect(r.length).toBe(5);
    expect(r.acrossPairs).toBe(1);
    expect(r.plans.map((p) => p.key)).toEqual(['1-4']);
  });
});

describe('the words', () => {
  it('names slots by position, not letter', () => {
    expect(slotName(SLOT_INDEX.UR)).toBe('top-right');
    expect(slotName(SLOT_INDEX.FL)).toBe('front-left');
  });
  it('describes the plans', () => {
    expect(planWords([3, 4])).toMatch(/^put three bad edges on a face and turn it .*, then gather the last four on one face and turn it$/);
    expect(planWords([])).toBe('no F/B turns');
  });
  it('writes the case note as bullets and the general note without face letters as names', () => {
    const st = at('UF', 'UB', 'UL', 'DF', 'DL', 'FR');
    const html = eoCaseStrategy(st, solveEO(st.eo));
    expect(html).toContain('<li><b>6 bad edges: 3 on the front, 1 on the back, 2 in the side-middle slots.</b>');
    expect(html).toContain('turning it first costs 2 extra moves');
    expect(html).toContain('The back face has one bad: turning it now is optimal');
    expect(html).toContain('<b>1 then 4 then 4</b>');
    expect(eoCaseStrategy({ eo: 0, slots: [4, 5, 6, 7] }, solveEO(0))).toContain('already solved');
    expect(EO_STRATEGY_SHORT).not.toMatch(/\bthe [URFDLB] face\b/);
  });
});

// The fewest-turns R/L/U search (src/f2l/search.ts): every alg it gives solves its case and keeps what it was asked
// to keep, and none of the case's own R/L/U algs is shorter.
import { describe, expect, it } from 'vitest';
import { moveCount, tokens } from '../src/cube/alg';
import { state } from '../src/cube/state';
import { DATA } from '../src/f2l/data';
import { caseAlgs, fullAlg, invert, orderedAlgs, SLOTS, slotSolved } from '../src/f2l/model';
import { leftBroken, openSlotShortcut, shortestFor } from '../src/f2l/search';

const rlu = (a: string) => tokens(fullAlg('', a)).every((t) => 'RLU'.includes(t[0]!));

describe('the shortest R/L/U alg', () => {
  it('keeps every sheet alg honest: each keeps the cross and the slots its pair is not in; a shortcut breaks what it says', () => {
    for (const slot of SLOTS) for (const c of Object.values(DATA.slots[slot].cases)) {
      for (const a of [...c.algs, c.simple]) expect(leftBroken(slot, c, a), `${slot} ${c.n} ${a}`).toEqual({ slots: [], cross: true });
      for (const o of c.others) expect(leftBroken(slot, c, o.alg).slots.every((s) => o.free.includes(s)), `${slot} ${c.n} ${o.alg}`).toBe(true);
    }
  });
  it('finds R L\' U R\' L for front-left case 31 (sheet row 32), shorter than the sheet\'s 7 and leading the list', () => {
    const c = DATA.slots.FL.cases['32']!;
    expect(shortestFor('FL', c)).toBe("R L' U R' L");
    expect(caseAlgs('FL', c)).toContain("R L' U R' L");
    expect(orderedAlgs('FL', c, true)[0]).toBe("R L' U R' L");
    expect(orderedAlgs('FL', c, false)[0]).toBe("R L' U R' L");
  });
  for (const slot of SLOTS) {
    it(`solves every ${slot} case, keeps the cross and the other pairs, and no R/L/U alg of the case is shorter`, () => {
      for (const c of Object.values(DATA.slots[slot].cases)) {
        const a = shortestFor(slot, c)!;
        expect(a, `${slot} ${c.n}`).toBeTruthy();
        expect(leftBroken(slot, c, a), `${slot} ${c.n} ${a}`).toEqual({ slots: [], cross: true });
        const keepsAll = (b: string) => leftBroken(slot, c, b).slots.length === 0;
        for (const b of [...c.algs, c.simple].filter((b) => rlu(b) && keepsAll(b))) expect(moveCount(fullAlg('', a)), `${slot} ${c.n}: ${b}`).toBeLessThanOrEqual(moveCount(fullAlg('', b)));
      }
    });
  }
  it('with a neighbouring slot open, D swings the target slot under it: front-left, front-right open, D R U\' R\' D\'', () => {
    const c = DATA.slots.FL.cases['18']!;
    const o = openSlotShortcut('FL', c, ['BR', 'BL'])!;
    expect(o).toEqual({ alg: "D R U' R' D'", free: ['FR'] });
    expect(slotSolved(state(`${invert(fullAlg('', shortestFor('FL', c)!))} ${o.alg}`), 'FL')).toBe(true);
    expect(leftBroken('FL', c, o.alg).cross).toBe(true);
  });
  it('a shortcut through open slots names the slots it leaves disturbed, and is shorter than keeping them', () => {
    let seen = 0;
    for (const slot of SLOTS) for (const c of Object.values(DATA.slots[slot].cases)) {
      const o = openSlotShortcut(slot, c, []);
      if (!o) continue;
      seen++;
      expect(moveCount(fullAlg('', o.alg))).toBeLessThan(moveCount(fullAlg('', shortestFor(slot, c)!)));
      expect(slotSolved(state(`${invert(fullAlg('', shortestFor(slot, c)!))} ${fullAlg('', o.alg)}`), slot)).toBe(true);
      expect(leftBroken(slot, c, o.alg).slots).toEqual(o.free);
    }
    expect(seen).toBeGreaterThan(0);
  });
});

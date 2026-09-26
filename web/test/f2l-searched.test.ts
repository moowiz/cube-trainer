// The searched-alg table (src/f2l/searched.ts, built by scripts/f2l-searched.ts): every entry does what its key says,
// checked by doing it, and a sample is re-searched to hold it to the fewest turns.
import { describe, expect, it } from 'vitest';
import { moveCount, tokens } from '../src/cube/alg';
import { crossSolved, edgeState } from '../src/cube/pieces';
import { state } from '../src/cube/state';
import { DATA, type SlotName } from '../src/f2l/data';
import { byLength, caseAlgs, fullAlg, invert, openSlotShortcut, orderedAlgs, searchedAlg, SLOTS, slotSolved } from '../src/f2l/model';
import { occupiedSlots, placedIn, RLUD, shortestAlgs } from '../src/f2l/search';
import { SEARCHED } from '../src/f2l/searched';

const entries = Object.entries(SEARCHED).map(([k, v]) => {
  const [head, auf, rest] = k.split('|') as [string, string, string | undefined];
  const slot = head.slice(0, 2) as SlotName, c = DATA.slots[slot].cases[head.slice(2)]!;
  return { k, v, slot, c, auf, rest };
});

describe('the searched-alg table', () => {
  it('has the fewest-turns alg for every position the finder can show', () => {
    for (const slot of SLOTS) for (const hit of Object.values(DATA.slots[slot].lookup)) expect(SEARCHED[`${slot}${hit.n}|${hit.auf}`], `${slot} ${hit.n} ${hit.auf}`).toBeTruthy();
  });
  it('every entry solves its pair from its position, keeps the cross and the slots it keeps, and leaves changed the ones it says', () => {
    for (const { k, v, slot, c, auf, rest } of entries) {
      const pos = state(invert(fullAlg(auf, c.algs[0]!)));
      const kept = SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));
      const picture = invert(SEARCHED[`${slot}${c.n}|${auf}`]!); // the pair placed, every slot it is not in solved
      expect(placedIn(state(picture), slot), k).toEqual(placedIn(pos, slot));
      const [alg, free] = v.split(';') as [string, string | undefined];
      const end = state(`${picture} ${alg}`);
      expect(slotSolved(end, slot), k).toBe(true);
      expect(crossSolved(edgeState(end)), k).toBe(true);
      const keep = rest === undefined || rest === 'own' ? kept : rest ? (rest.split('.') as SlotName[]) : [];
      for (const s of keep) expect(slotSolved(end, s), `${k}: keeps ${s}`).toBe(true);
      if (rest === 'own') expect(tokens(alg).every((t) => t[0] === 'U' || t[0] === slot[1]), k).toBe(true);
      if (free !== undefined) {
        expect(kept.filter((s) => !keep.includes(s) && !slotSolved(end, s)), k).toEqual(free.split('.'));
        expect(moveCount(alg), k).toBeLessThan(moveCount(SEARCHED[`${slot}${c.n}|${auf}`]!));
      }
    }
  });
  it('a sample re-searched: no shorter alg (every 40th entry)', () => {
    for (const { k, v, slot, c, auf, rest } of entries.filter((_, i) => i % 40 === 0)) {
      if (rest === 'own') continue;
      const pair = placedIn(state(invert(fullAlg(auf, c.algs[0]!))), slot);
      const kept = SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));
      const keep = rest === undefined ? kept : rest ? (rest.split('.') as SlotName[]) : [];
      const n = moveCount(v.split(';')[0]!);
      expect(shortestAlgs(pair, keep, { moves: rest === undefined ? undefined : RLUD, maxDepth: n - 1 }), k).toEqual([]);
    }
  });
  it('front-left case 31 (sheet row 32) leads with R L\' U R\' L from every AUF; front-right open, D R U\' R\' D\' for row 18', () => {
    const c = DATA.slots.FL.cases['32']!;
    for (const auf of ['', 'U', 'U2', "U'"]) expect(fullAlg(auf, orderedAlgs('FL', c, true, auf)[0]!).split(' ').slice(-5).join(' ')).toBe("R L' U R' L");
    expect(openSlotShortcut('FL', DATA.slots.FL.cases['18']!, '', ['BR', 'BL'])).toEqual({ alg: "D R U' R' D'", free: ['FR'] });
  });
  it('each AUF gets its own shortest: front-right case 1 from U2 is R U2 R\', not U\' R U\' R\'', () => {
    const c = DATA.slots.FR.cases['1']!;
    expect(fullAlg('U2', searchedAlg('FR', c, 'U2')!)).toBe("R U2 R'");
    expect(fullAlg('U2', byLength(caseAlgs('FR', c, 'U2'), 'U2')[0]!)).toBe("R U2 R'");
  });
});

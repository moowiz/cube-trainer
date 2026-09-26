// The searched-alg table (src/f2l/searched.ts, built by scripts/f2l-searched.ts): every alg in it does what its entry
// says, checked by doing it - the pair solved, the cross and EO kept, every slot it does not name kept, the ones it
// names left changed - and a sample is re-searched to hold the first (R/L/U, every slot kept) to the fewest turns.
import { describe, expect, it } from 'vitest';
import { moveCount, tokens } from '../src/cube/alg';
import { crossSolved, edgeState } from '../src/cube/pieces';
import { state } from '../src/cube/state';
import { DATA, type SlotName } from '../src/f2l/data';
import { fullAlg, invert, listFor, orderedAlgs, positionAlgs, SLOTS, slotSolved } from '../src/f2l/model';
import { occupiedSlots, placedIn, shortestAlgs } from '../src/f2l/search';
import { SEARCHED } from '../src/f2l/searched';

const entries = Object.entries(SEARCHED).map(([k, v]) => {
  const [head, auf, own] = k.split('|') as [string, string, string | undefined];
  const slot = head.slice(0, 2) as SlotName, c = DATA.slots[slot].cases[head.slice(2)]!;
  return { k, v, slot, c, auf, own: own === 'own' };
});

describe('the searched-alg table', () => {
  it('has every position the finder can show', () => {
    for (const slot of SLOTS) for (const hit of Object.values(DATA.slots[slot].lookup)) expect(SEARCHED[`${slot}${hit.n}|${hit.auf}`], `${slot} ${hit.n} ${hit.auf}`).toBeTruthy();
  });
  it('every alg solves its pair from its position, keeps the cross, EO and every slot it does not name, and changes the ones it names', () => {
    for (const { k, v, slot, c, auf, own } of entries) {
      const first = SEARCHED[`${slot}${c.n}|${auf}`]!.split('|')[0]!.split(';')[0]!;
      const picture = invert(first); // the pair placed, every slot it is not in solved
      expect(placedIn(state(picture), slot), k).toEqual(placedIn(state(invert(fullAlg(auf, c.algs[0]!))), slot));
      const kept = SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));
      for (const e of v.split('|')) {
        const [alg, br] = own ? [v, ''] : (e.split(';') as [string, string]);
        const needs = br ? br.split('.') : [];
        const end = state(`${picture} ${alg}`);
        expect([slotSolved(end, slot), crossSolved(edgeState(end)), edgeState(end).eo], `${k}: ${alg}`).toEqual([true, true, 0]);
        expect(kept.filter((s) => !slotSolved(end, s)), `${k}: ${alg}`).toEqual(kept.filter((s) => needs.includes(s)));
        if (own) expect(tokens(alg).every((t) => t[0] === 'U' || t[0] === slot[1]), k).toBe(true);
        if (own) break;
      }
    }
  });
  it('a sample re-searched: the first alg of a position is the fewest R/L/U turns (every 20th position)', () => {
    for (const { k, v, slot, c, auf } of entries.filter((e, i) => !e.own && i % 20 === 0)) {
      const pair = placedIn(state(invert(fullAlg(auf, c.algs[0]!))), slot);
      const kept = SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));
      expect(shortestAlgs(pair, kept, { maxDepth: moveCount(v.split('|')[0]!.split(';')[0]!) - 1 }), k).toEqual([]);
    }
  });
  it('front-left case 31 (sheet row 32) leads with R L\' U R\' L from every AUF; front-right open, D R U\' R\' D\' for row 18', () => {
    const c = DATA.slots.FL.cases['32']!;
    for (const auf of ['', 'U', 'U2', "U'"]) expect(fullAlg(auf, orderedAlgs('FL', c, auf)[0]!).split(' ').slice(-5).join(' ')).toBe("R L' U R' L");
    const r18 = DATA.slots.FL.cases['18']!;
    const d = positionAlgs('FL', r18, '').find((x) => x.full === "D R U' R' D'");
    expect(d?.needs).toEqual(['FR']);
    // with back-right and back-left solved and front-right open, it leads; with front-right solved too, it is greyed
    expect(listFor('FL', r18, '', new Set<SlotName>(['BR', 'BL'])).lead?.full).toBe("D R U' R' D'");
    expect(listFor('FL', r18, '', new Set<SlotName>(['BR', 'BL', 'FR'])).rows.find((x) => x.full === "D R U' R' D'")?.usable).toBe(false);
  });
  it('each AUF gets its own shortest: front-right case 1 from U2 is R U2 R\', not U\' R U\' R\'', () => {
    expect(fullAlg('U2', orderedAlgs('FR', DATA.slots.FR.cases['1']!, 'U2')[0]!)).toBe("R U2 R'");
  });
});

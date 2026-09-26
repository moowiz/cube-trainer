// The own-side alg (R and U for a right-hand slot, L and U for a left-hand one) that never lifts the neighbouring
// pair: every one found solves its case, keeps the rest, and is no longer than any such alg the sheet has.
import { describe, expect, it } from 'vitest';
import { crossSolved, edgeState, findCorner, findEdge, EDGE_POS } from '../src/cube/pieces';
import { state, stepStates } from '../src/cube/state';
import { moveCount, tokens } from '../src/cube/alg';
import { DATA } from '../src/f2l/data';
import { allAlgs, fullAlg, invert, SLOTS, slotSolved, twinOf, type SlotName } from '../src/f2l/model';
import { ownSideFor } from '../src/f2l/ownside';

const neighbourOf = (s: SlotName) => `${s[0] === 'F' ? 'B' : 'F'}${s[1]}` as SlotName;
const lifted = (f: string, s: SlotName) => findCorner(f, `D${s}`, 'D').pos[1] === 1 || EDGE_POS[findEdge(f, s)]![1] === 1;

describe('own-side algs', () => {
  it('each solves its case with its side and U alone, keeps the other slots and the cross, and never lifts the neighbour', () => {
    let found = 0;
    for (const slot of SLOTS) for (const c of Object.values(DATA.slots[slot].cases)) {
      const o = ownSideFor(slot, c);
      if (!o) continue;
      found++;
      const start = state(invert(fullAlg('', c.algs[0]!)));
      expect(tokens(o.alg).every((t) => t[0] === 'U' || t[0] === slot[1]), `${slot} ${c.n} ${o.alg}`).toBe(true);
      const end = state(`${invert(fullAlg('', c.algs[0]!))} ${o.alg}`);
      for (const s of SLOTS) expect(slotSolved(end, s), `${slot} ${c.n} ${o.alg}: ${s}`).toBe(true);
      expect(crossSolved(edgeState(end))).toBe(true);
      expect(stepStates(start, o.alg).some((f) => lifted(f, neighbourOf(slot))), `${slot} ${c.n} ${o.alg} lifts the neighbour`).toBe(false);
      // no sheet alg of the same kind is shorter
      for (const a of allAlgs(c)) {
        const full = fullAlg('', a);
        const own = tokens(full).every((t) => t[0] === 'U' || t[0] === slot[1]);
        if (own && !stepStates(start, full).some((f) => lifted(f, neighbourOf(slot)))) expect(o.moves, `${slot} ${c.n}: ${full} is shorter`).toBeLessThanOrEqual(moveCount(full));
      }
    }
    expect(found).toBeGreaterThanOrEqual(80); // the top-layer and own-side cases of each slot
  });
  it("the back-right pair white up at UFL, edge at UF (the front-right's case 5): R' splits them, 11 moves against the sheet's 9 through the front-right slot", () => {
    const c = Object.values(DATA.slots.BR.cases).find((x) => twinOf('BR', x.n) === 5)!;
    const o = ownSideFor('BR', c)!;
    expect(o.moves).toBe(11);
    expect(o.alg.startsWith("R'")).toBe(true);
    expect(moveCount(fullAlg('', c.algs[0]!))).toBe(9);
  });
});

import { describe, expect, it } from 'vitest';
import { crossSolved, edgeState, eoCoord } from '../src/cube/pieces';
import { state } from '../src/cube/state';
import { DATA } from '../src/f2l/data';
import { findCase, SLOTS, slotSolved, slotState, type SlotName } from '../src/f2l/model';
import { genTargeted, targetState, type Target } from '../src/f2l/target';
import { validateState } from '../src/state';

/** A seeded generator, so a failure repeats. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const caseAt = (f: string, slot: SlotName) => { const st = slotState(f, slot); return findCase(slot, st.corner, st.edge)?.c.n ?? null; };
const f2lReady = (f: string) => eoCoord(f) === 0 && crossSolved(edgeState(f)) && validateState(f).ok;

describe('targeted scrambles', () => {
  it('every case of every slot can be drawn: the pair reads as that case, EO and the cross solved, a legal cube', () => {
    const r = rng(1);
    for (const slot of SLOTS) for (const c of Object.values(DATA.slots[slot].cases)) {
      for (let k = 0; k < 3; k++) {
        const f = targetState([{ slot, n: c.n }], r)!;
        expect(f2lReady(f), `${slot} ${c.n}: ${validateState(f).ok ? `eo ${eoCoord(f)}` : validateState(f).error}`).toBe(true);
        expect(caseAt(f, slot), `${slot} ${c.n}`).toBe(c.n);
      }
    }
  });
  it('a top-layer case comes at every AUF', () => {
    const r = rng(2), seen = new Set<string>();
    for (let k = 0; k < 60; k++) seen.add(slotState(targetState([{ slot: 'FR', n: 5 }], r)!, 'FR').corner.pos);
    expect(seen.size).toBe(4);
  });
  it('the scramble makes the state, in a short sequence that is not the alg undone', () => {
    const r = rng(3);
    for (const t of [{ slot: 'FR', n: 1 }, { slot: 'FL', n: 40 }, { slot: 'BR', n: 13 }, { slot: 'BL', n: 83 }] as Target[]) {
      const g = genTargeted([t], r)!;
      expect(state(g.scramble)).toBe(g.facelets);
      expect(g.scramble.split(' ').length).toBeLessThanOrEqual(24);
      expect(caseAt(state(g.scramble), t.slot)).toBe(t.n);
    }
  });
  it('several slots at once, each in its own case; clashing targets give null', () => {
    const r = rng(4);
    let made = 0;
    for (let k = 0; k < 100; k++) {
      const ts: Target[] = SLOTS.map((slot) => ({ slot, n: 1 + Math.floor(r() * 83) }));
      const f = targetState(ts, r);
      if (!f) continue; // four pairs can want the same spot (four on top can need the same corner spot at every AUF)
      made++;
      expect(f2lReady(f)).toBe(true);
      for (const t of ts) expect(caseAt(f, t.slot), `${t.slot} ${t.n}`).toBe(t.n);
    }
    expect(made).toBeGreaterThan(10); // 21 of 100 with this seed: four pairs rarely all fit
    for (let k = 0; k < 20; k++) {
      const two: Target[] = [{ slot: 'FR', n: 1 + Math.floor(r() * 12) }, { slot: 'BL', n: 1 + Math.floor(r() * 12) }]; // both on top
      const f = targetState(two, r)!;
      expect(f, JSON.stringify(two)).not.toBeNull();
      for (const t of two) expect(caseAt(f, t.slot)).toBe(t.n);
    }
    // the front-right pair's corner in the back-left slot, and the back-left pair's corner in its own slot: both want DBL
    const frInBL = Object.values(DATA.slots.FR.cases).find((c) => c.corner === 'DBL')!;
    const blOwn = Object.values(DATA.slots.BL.cases).find((c) => c.corner === 'DBL')!;
    expect(targetState([{ slot: 'FR', n: frInBL.n }, { slot: 'BL', n: blOwn.n }], r)).toBeNull();
    expect(targetState([{ slot: 'FR', n: 1 }, { slot: 'FR', n: 2 }], r)).toBeNull();
  });
  it("rest 'solved' leaves the other pairs home", () => {
    const r = rng(5);
    const f = targetState([{ slot: 'FR', n: 7 }], r, { rest: 'solved' })!;
    expect(caseAt(f, 'FR')).toBe(7);
    for (const s of ['FL', 'BR', 'BL'] as const) expect(slotSolved(f, s)).toBe(true);
    const inBR = Object.values(DATA.slots.FR.cases).find((c) => c.corner === 'DBR' && c.edge.startsWith('U'))!; // its corner sits in the back-right slot
    const g = targetState([{ slot: 'FR', n: inBR.n }], r, { rest: 'solved' })!;
    expect(caseAt(g, 'FR')).toBe(inBR.n);
    expect(slotSolved(g, 'FL') && slotSolved(g, 'BL') && !slotSolved(g, 'BR')).toBe(true);
  });
});

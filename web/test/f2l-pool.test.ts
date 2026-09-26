// A case's number on every slot (its front-right twin, by mirror), the groups, and the practice pool.
import { describe, expect, it } from 'vitest';
import { DATA } from '../src/f2l/data';
import { caseGroup, caseOfTwin, fullAlg, invert, pairShape, SLOTS, slotSolved, twinOf, type SlotName } from '../src/f2l/model';
import { byTwin, drawTarget, poolTargets } from '../src/f2l/pool';
import { state } from '../src/cube/state';
import type { AttemptRecord } from '../src/store/types';

const MIRROR: Record<SlotName, Record<string, string>> = { FR: {}, FL: { R: 'L', L: 'R' }, BR: { F: 'B', B: 'F' }, BL: { F: 'B', B: 'F', R: 'L', L: 'R' } };
/** An alg mirrored: faces swapped by `m`, every turn's direction flipped once per mirror plane. */
function mirrorAlg(alg: string, m: Record<string, string>): string {
  const planes = new Set(Object.keys(m).map((k) => [k, m[k]].sort().join(''))).size;
  return alg.split(' ').filter(Boolean).map((t) => {
    const f = m[t[0]!] ?? t[0]!, rest = t.slice(1);
    if (rest === '2' || planes % 2 === 0) return f + rest;
    return f + (rest === "'" ? '' : "'");
  }).join(' ');
}

describe('a case across the slots', () => {
  it('each slot\'s 83 cases map one to one onto the front-right ones, and front-right onto itself', () => {
    for (const s of SLOTS) {
      const tw = Object.values(DATA.slots[s].cases).map((c) => twinOf(s, c.n));
      expect(new Set(tw).size).toBe(83);
    }
    for (const c of Object.values(DATA.slots.FR.cases)) expect(twinOf('FR', c.n)).toBe(c.n);
  });
  it('the twin is the mirror: the front-right case\'s alg, mirrored, solves the slot\'s case', () => {
    for (const s of SLOTS) for (const c of Object.values(DATA.slots[s].cases)) {
      const fr = DATA.slots.FR.cases[twinOf(s, c.n)]!;
      const alg = mirrorAlg(fullAlg('', fr.algs[0]!), MIRROR[s]);
      expect(slotSolved(state(`${invert(fullAlg('', c.algs[0]!))} ${alg}`), s) || slotSolved(state(`${invert(fullAlg('', c.algs[0]!))} U ${alg}`), s)
        || slotSolved(state(`${invert(fullAlg('', c.algs[0]!))} U2 ${alg}`), s) || slotSolved(state(`${invert(fullAlg('', c.algs[0]!))} U' ${alg}`), s), `${s} ${c.n} <- FR ${fr.n}`).toBe(true);
      expect(caseGroup(s, c)).toBe(caseGroup('FR', fr));
      expect(pairShape(s, c)).toBe(pairShape('FR', fr));
      expect(caseOfTwin(s, fr.n)?.n).toBe(c.n);
    }
  });
  it('the nine groups split each slot 12 / 3 / 3 / 2 / 9 / 9 / 9 / 9 / 27, one pair on top already joined', () => {
    for (const s of SLOTS) {
      const n: Record<string, number> = {};
      for (const c of Object.values(DATA.slots[s].cases)) n[caseGroup(s, c)] = (n[caseGroup(s, c)] ?? 0) + 1;
      expect(n).toEqual({ top: 12, 'ctop-ein': 3, 'cin-etop': 3, twisted: 2, eother: 9, cother: 9, 'cin-eother': 9, 'cother-ein': 9, bothother: 27 });
      expect(Object.values(DATA.slots[s].cases).filter((c) => pairShape(s, c) === 'joined').length).toBe(1);
    }
  });
});

describe('the practice pool', () => {
  it('a pick is its own slot, or all four mirrors', () => {
    expect(poolTargets({ ids: ['FL-5'], mirrors: false })).toEqual([{ slot: 'FL', n: 5 }]);
    const all = poolTargets({ ids: ['FL-5'], mirrors: true });
    expect(all.map((t) => t.slot).sort()).toEqual(['BL', 'BR', 'FL', 'FR']);
    expect(new Set(all.map((t) => twinOf(t.slot, t.n))).size).toBe(1);
    expect(poolTargets({ ids: ['FL-5', 'FR-' + twinOf('FL', 5)], mirrors: true })).toHaveLength(4); // the same case twice is one
  });
  it('a draw never repeats the case just done when there is another', () => {
    const ts = [{ slot: 'FR' as const, n: 1 }, { slot: 'FR' as const, n: 2 }];
    for (let k = 0; k < 20; k++) expect(drawTarget(ts, ts[0]!, Math.random)).toEqual(ts[1]);
    expect(drawTarget([ts[0]!], ts[0]!)).toEqual(ts[0]);
    expect(drawTarget([], null)).toBeNull();
  });
  it('the table counts the four mirrors of a case as one', () => {
    const a = (caseId: string) => ({ caseId }) as AttemptRecord;
    const n = twinOf('BL', 30);
    expect(byTwin([a('BL-30'), a(`FR-${n}`), a('nonsense')]).map((x) => x.caseId)).toEqual([String(n), String(n)]);
  });
});

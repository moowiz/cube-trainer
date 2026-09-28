// A phase's time over the days: which attempts count for which phase, from the solves and the drills.
import { describe, expect, it } from 'vitest';
import type { Analysed } from '../src/analysis/cache';
import { compare, trendPoints } from '../src/analysis/trend';
import type { AttemptRecord } from '../src/store/types';

const att = (o: Partial<AttemptRecord>): AttemptRecord => ({ id: 'x', puzzle: '333', stage: 'eo', when: 1000, scramble: '', moves: '', time: 5000, assisted: false, source: 'cube', editedAt: 0, ...o });
const solve = (when: number, from: 'eo' | 'f2l', phases: unknown[]): Analysed => ({ rec: { when } as Analysed['rec'], a: { phases, total: 0, from, turns: 0, moves: 0, idle: 0 } as unknown as Analysed['a'] });

describe('trendPoints', () => {
  const full = solve(10, 'eo', [
    { id: 'eocross', time: 6000, eo: { time: 2500, moves: 5 } },
    { id: 'pair', time: 3000 }, { id: 'pair', time: 4000 }, { id: 'pair', time: 0, skipped: true },
    { id: 'ocll', time: 2000 }, { id: 'pll', time: 0, skipped: true },
  ]);
  const fromF2l = solve(20, 'f2l', [{ id: 'eocross', time: 0, skipped: true }, { id: 'pair', time: 5000 }, { id: 'ocll', time: 1500 }]);
  it('a full solve gives each phase it did; a scramble that gave EOCross gives none of it', () => {
    const p = (ph: Parameters<typeof trendPoints>[0]) => trendPoints(ph, 'solves', [full, fromF2l], []).map((x) => x.ms);
    expect(p('eocross')).toEqual([6000]);
    expect(p('eo')).toEqual([2500]);
    expect(p('cross')).toEqual([3500]);
    expect(p('f2l')).toEqual([7000, 5000]);
    expect(p('ocll')).toEqual([2000, 1500]);
    expect(p('pll')).toEqual([]); // a PLL skip takes no time: not a point
  });
  it('an EOCross drill attempt: the whole to the cross, split when recorded; one that stopped at EO is EO', () => {
    const toCross = att({ when: 1, scramble: "R U F' L2 B", moves: "B' L2 F U' R'", time: 4000, eoSplit: 1500 });
    const old = att({ when: 2, scramble: "R U F' L2 B", moves: "B' L2 F U' R'", time: 4200 });
    const eoOnly = att({ when: 3, scramble: 'R F', moves: "F'", time: 900 });
    const p = (ph: Parameters<typeof trendPoints>[0]) => trendPoints(ph, 'drills', [], [toCross, old, eoOnly]).map((x) => x.ms);
    expect(p('eocross')).toEqual([4000, 4200]);
    expect(p('eo')).toEqual([1500, 900]);
    expect(p('cross')).toEqual([2500]);
    expect(p('f2l')).toEqual([]);
  });
  it('both sources, oldest first; the last-layer drills count for OCLL and PLL (not their repeats)', () => {
    const ll = [att({ stage: 'pll', when: 15, time: 3000 }), att({ stage: 'pll', when: 16, time: 2000, start: 'repeat' })];
    expect(trendPoints('pll', 'both', [full], ll).map((x) => [x.when, x.from])).toEqual([[15, 'drill']]);
    expect(trendPoints('eocross', 'both', [full], [att({ when: 5, scramble: "R U F' L2 B", moves: "B' L2 F U' R'" })]).map((x) => x.from)).toEqual(['drill', 'solve']);
  });
});

describe('compare', () => {
  it('the last stretch against the one before', () => {
    const now = 100 * 86_400_000, day = 86_400_000;
    const pts = [{ when: now - day, ms: 5000 }, { when: now - 2 * day, ms: 7000 }, { when: now - 10 * day, ms: 9000 }].map((p) => ({ ...p, from: 'solve' as const }));
    expect(compare(pts, 7, now)).toEqual({ now: 6000, n: 2, before: 9000, nBefore: 1 });
  });
});

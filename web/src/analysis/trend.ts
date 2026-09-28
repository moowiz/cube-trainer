// A phase's time over the days (user, 2026-09-27: "how long EOCross has taken me over the past week"): each attempt
// at it as a point, from the full solves (the coach's analysis of their turns) and from the drills (the EOCross drill's
// attempts; the last-layer drills'). Pure: Progress's Phases view (trendui.ts) draws it.

import { state } from '../cube/state';
import { stageOf } from '../stage';
import type { AttemptRecord } from '../store/types';
import type { Analysed } from './cache';
import { median } from './coach';

export type TrendPhase = 'eocross' | 'eo' | 'cross' | 'f2l' | 'ocll' | 'pll';
export const TREND_PHASES: readonly TrendPhase[] = ['eocross', 'eo', 'cross', 'f2l', 'ocll', 'pll'];
export const TREND_WORD: Record<TrendPhase, string> = { eocross: 'EOCross', eo: 'EO', cross: 'Cross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };
export type TrendSource = 'solves' | 'drills' | 'both';

export interface Point { when: number; ms: number; from: 'solve' | 'drill' }

/** A solve's time in the phase, or null when the solve did not do it (given by the scramble, skipped, not recorded). */
function solvePhase(x: Analysed, ph: TrendPhase): number | null {
  const { a } = x;
  const eoc = a.phases.find((p) => p.id === 'eocross');
  switch (ph) {
    case 'eocross': return a.from === 'eo' && eoc && !eoc.skipped ? eoc.time : null;
    case 'eo': return a.from === 'eo' && eoc?.eo ? eoc.eo.time : null;
    case 'cross': return a.from === 'eo' && eoc?.eo && !eoc.skipped ? eoc.time - eoc.eo.time : null;
    case 'f2l': {
      if (a.from !== 'eo' && a.from !== 'f2l') return null;
      const pairs = a.phases.filter((p) => p.id === 'pair' && !p.skipped);
      return pairs.length ? pairs.reduce((s, p) => s + p.time, 0) : null;
    }
    default: {
      const p = a.phases.find((q) => q.id === ph);
      return p && !p.skipped ? p.time : null;
    }
  }
}

/** A drill attempt's time in the phase, or null. EOCross drill attempts: done to the cross (the whole attempt, and its
 *  EO split when it was recorded), or EO alone (an attempt that stopped at EO). */
function drillPhase(r: AttemptRecord, ph: TrendPhase): number | null {
  if (r.time === null || r.deleted) return null;
  if (ph === 'ocll' || ph === 'pll') return r.stage === ph && r.start !== 'repeat' ? r.time : null;
  if (r.stage !== 'eo' || ph === 'f2l') return null;
  let cross: boolean, eo: boolean;
  try { const rep = stageOf(state(`${r.scramble} ${r.moves}`)); eo = rep.eoBad === 0; cross = eo && rep.cross === 4; } catch { return null; }
  if (ph === 'eocross') return cross ? r.time : null;
  if (ph === 'eo') return r.eoSplit !== undefined ? r.eoSplit : eo && !cross ? r.time : null;
  return cross && r.eoSplit !== undefined ? r.time - r.eoSplit : null; // the cross
}

/** Every attempt at the phase from the source, oldest first. */
export function trendPoints(ph: TrendPhase, src: TrendSource, solves: readonly Analysed[], attempts: readonly AttemptRecord[]): Point[] {
  const out: Point[] = [];
  if (src !== 'drills') for (const x of solves) { const ms = solvePhase(x, ph); if (ms !== null) out.push({ when: x.rec.when, ms, from: 'solve' }); }
  if (src !== 'solves') for (const r of attempts) { const ms = drillPhase(r, ph); if (ms !== null) out.push({ when: r.when, ms, from: 'drill' }); }
  return out.sort((a, b) => a.when - b.when);
}

const DAY = 86_400_000;
/** The last `days` days against the `days` before them: medians and counts (null median with no points). */
export function compare(points: readonly Point[], days: number, now = Date.now()): { now: number | null; n: number; before: number | null; nBefore: number } {
  const cut = now - days * DAY, cut2 = cut - days * DAY;
  const a = points.filter((p) => p.when >= cut).map((p) => p.ms), b = points.filter((p) => p.when >= cut2 && p.when < cut).map((p) => p.ms);
  return { now: a.length ? median(a) : null, n: a.length, before: b.length ? median(b) : null, nBefore: b.length };
}

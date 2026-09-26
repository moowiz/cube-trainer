// What the practice so far says about each case: how often, how fast, how
// well recognised, whether it is getting faster - which cases to work on
// next, and the table sorted any way (the graph is practicegraph.ts). Pure,
// on the store's attempt records (ui/drill.ts files one per
// solved case); the drill shows it and sets its case pool from it.

import type { AttemptRecord } from '../store/types';
import type { LLCase } from './cases';

export interface CaseStats {
  id: string;
  name: string;
  /** solved attempts (a case that came up after an earlier start counts too) */
  n: number;
  /** ms, the fastest timed attempt; null untimed */
  best: number | null;
  /** ms, the mean of the last `RECENT` timed attempts; null untimed */
  recent: number | null;
  /** ms, `recent` minus the mean of the `RECENT` timed attempts before those (negative = faster now); null until there are enough */
  trend: number | null;
  /** ms, mean recognition (scramble matched -> first turn) over the recent cube-fed attempts */
  recognition: number | null;
  /** ms, mean execution (first -> last turn) likewise */
  execution: number | null;
  /** the quiz: named right, of those asked */
  quizRight: number;
  quizAsked: number;
  /** attempts with a hint or the alg seen */
  assisted: number;
  /** wall clock of the last attempt */
  last: number | null;
}

// DECISION: "recent" is the last eight timed attempts - enough to steady a mean, few enough to move with practice
export const RECENT = 8;

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The last RECENT against the up-to-RECENT before them: null with nothing before. */
function trendOf(timed: readonly number[]): number | null {
  const now = mean(timed.slice(-RECENT)), before = mean(timed.slice(-2 * RECENT, -RECENT));
  return now === null || before === null ? null : now - before;
}

/** Per-case stats for `cases`, from the stage's attempts (oldest first); every case is listed, practised or not. */
export function caseStats(attempts: readonly AttemptRecord[], cases: readonly Pick<LLCase, 'id' | 'name'>[]): CaseStats[] {
  const byCase = new Map<string, AttemptRecord[]>();
  for (const a of attempts) if (a.caseId && !a.deleted) (byCase.get(a.caseId) ?? byCase.set(a.caseId, []).get(a.caseId)!).push(a);
  return cases.map((c) => {
    const as = byCase.get(c.name) ?? [];
    const timed = as.filter((a) => a.time !== null).map((a) => a.time!);
    const recentAs = as.slice(-RECENT);
    const fed = recentAs.filter((a) => a.recognition !== undefined && a.execution !== undefined);
    const reps = (a: AttemptRecord) => a.start === 'repeat'; // an alg repeated on the cube in hand: nothing to recognise, the alg on show
    const asked = as.filter((a) => a.quiz === 'right' || a.quiz === 'wrong' || a.quiz === 'gaveUp');
    return {
      id: c.id, name: c.name, n: as.length,
      best: timed.length ? Math.min(...timed) : null,
      recent: mean(timed.slice(-RECENT)),
      trend: trendOf(timed),
      recognition: mean(fed.filter((a) => !reps(a)).map((a) => a.recognition!)),
      execution: mean(fed.map((a) => a.execution!)),
      quizRight: asked.filter((a) => a.quiz === 'right').length, quizAsked: asked.length,
      assisted: as.filter((a) => a.assisted && !reps(a)).length,
      last: as.length ? as[as.length - 1]!.when : null,
    };
  });
}

/**
 * The cases to work on, worst first: never practised, then missed in the quiz, then slowest recently; a
 * case with fewer than three attempts ranks with the unpractised (its numbers are not to be trusted yet).
 */
export function workOn(stats: readonly CaseStats[]): CaseStats[] {
  const score = (s: CaseStats): number => {
    if (s.n < 3) return 1e9 - s.n; // the least practised first
    const miss = s.quizAsked ? 1 - s.quizRight / s.quizAsked : 0;
    return (s.recent ?? 0) * (1 + miss); // slow, and slower still when misnamed
  };
  return [...stats].sort((a, b) => score(b) - score(a));
}

export const secs = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);

/** A signed trend: "−0.4s" (faster), "+0.2s" (slower), "±0" ; '–' with none. */
export const trendText = (ms: number | null): string => (ms === null ? '–' : Math.abs(ms) < 50 ? '±0' : `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`);

/** The table's columns, as the sort knows them; 'work' is the worst-first ranking. */
export type SortKey = 'work' | 'name' | 'n' | 'best' | 'recent' | 'trend' | 'recognition' | 'execution' | 'quiz' | 'last';
export const SORT_KEYS: readonly SortKey[] = ['work', 'name', 'n', 'best', 'recent', 'trend', 'recognition', 'execution', 'quiz', 'last'];

/**
 * The stats sorted by a column. `dir` is the direction as read down the table; a case with no
 * value in that column sits at the bottom either way. 'name' takes the case list's order; 'quiz' is
 * the share named right; 'last' descending is the most recent first.
 */
export function sortStats(stats: readonly CaseStats[], key: SortKey, dir: 'asc' | 'desc'): CaseStats[] {
  if (key === 'work') { const w = workOn(stats); return dir === 'asc' ? w : w.reverse(); }
  const sign = dir === 'asc' ? 1 : -1;
  const order = new Map(stats.map((s, i) => [s.id, i]));
  const value = (s: CaseStats): number | null => {
    switch (key) {
      case 'name': return order.get(s.id)!;
      case 'n': return s.n;
      case 'best': return s.best;
      case 'recent': return s.recent;
      case 'trend': return s.trend;
      case 'recognition': return s.recognition;
      case 'execution': return s.execution;
      case 'quiz': return s.quizAsked ? s.quizRight / s.quizAsked : null;
      case 'last': return s.last;
    }
  };
  return [...stats].sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    return sign * (va - vb) || order.get(a.id)! - order.get(b.id)!;
  });
}

/** The default direction for a column: what puts the interesting rows on top. */
export const DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  work: 'asc', name: 'asc', n: 'asc', best: 'desc', recent: 'desc', trend: 'desc', recognition: 'desc', execution: 'desc', quiz: 'asc', last: 'desc',
};

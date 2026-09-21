// What the practice so far says about each case: how often, how fast, how
// well recognised - and which cases to work on next. Pure, on the store's
// attempt records (ui/drill.ts files one per solved case); the drill shows
// it and sets its case pool from it.

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

/** Per-case stats for `cases`, from the stage's attempts (oldest first); every case is listed, practised or not. */
export function caseStats(attempts: readonly AttemptRecord[], cases: readonly LLCase[]): CaseStats[] {
  const byCase = new Map<string, AttemptRecord[]>();
  for (const a of attempts) if (a.caseId && !a.deleted) (byCase.get(a.caseId) ?? byCase.set(a.caseId, []).get(a.caseId)!).push(a);
  return cases.map((c) => {
    const as = byCase.get(c.name) ?? [];
    const timed = as.filter((a) => a.time !== null).map((a) => a.time!);
    const recentAs = as.slice(-RECENT);
    const fed = recentAs.filter((a) => a.recognition !== undefined && a.execution !== undefined);
    const asked = as.filter((a) => a.quiz === 'right' || a.quiz === 'wrong' || a.quiz === 'gaveUp');
    return {
      id: c.id, name: c.name, n: as.length,
      best: timed.length ? Math.min(...timed) : null,
      recent: mean(timed.slice(-RECENT)),
      recognition: mean(fed.map((a) => a.recognition!)),
      execution: mean(fed.map((a) => a.execution!)),
      quizRight: asked.filter((a) => a.quiz === 'right').length, quizAsked: asked.length,
      assisted: as.filter((a) => a.assisted).length,
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

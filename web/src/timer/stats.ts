// Averages the way timers count them: ao5 and ao12 drop the best and the
// worst, bigger averages trim 5% off each end (csTimer's rule), a DNF is
// the worst time, and more DNFs than the trim makes the average a DNF.
// Pure functions over ms times (null = DNF), newest last.

export type Time = number | null;

/** How many are dropped at each end of an average of n. */
export const trimOf = (n: number): number => (n < 3 ? 0 : Math.ceil(n * 0.05));

/** The average of the last n; undefined with fewer than n; null when it is a DNF. */
export function averageOf(times: readonly Time[], n: number): Time | undefined {
  if (times.length < n) return undefined;
  const last = times.slice(-n);
  const trim = trimOf(n);
  const dnfs = last.filter((t) => t === null).length;
  if (dnfs > trim) return null;
  const sorted = last.filter((t): t is number => t !== null).sort((a, b) => a - b);
  // the DNFs are the worst; the trim takes them first
  const keep = sorted.slice(trim, sorted.length - (trim - dnfs));
  return keep.reduce((a, b) => a + b, 0) / keep.length;
}

/** The mean of the last n (mo3); undefined with fewer than n; null when any is a DNF. */
export function meanOf(times: readonly Time[], n: number): Time | undefined {
  if (times.length < n) return undefined;
  const last = times.slice(-n);
  if (last.some((t) => t === null)) return null;
  return (last as number[]).reduce((a, b) => a + b, 0) / n;
}

/** The best average of n anywhere in the list (a DNF average never wins). */
export function bestAverageOf(times: readonly Time[], n: number): number | undefined {
  let best: number | undefined;
  for (let end = n; end <= times.length; end++) {
    const a = averageOf(times.slice(0, end), n);
    if (typeof a === 'number' && (best === undefined || a < best)) best = a;
  }
  return best;
}

export interface SessionStats {
  n: number;
  solved: number;
  best?: number;
  worst?: number;
  /** mean of the solved ones */
  mean?: number;
  mo3?: Time;
  ao5?: Time;
  ao12?: Time;
  ao50?: Time;
  ao100?: Time;
  bestAo5?: number;
  bestAo12?: number;
}

export function sessionStats(times: readonly Time[]): SessionStats {
  const solved = times.filter((t): t is number => t !== null);
  const s: SessionStats = { n: times.length, solved: solved.length };
  if (solved.length) {
    s.best = Math.min(...solved);
    s.worst = Math.max(...solved);
    s.mean = solved.reduce((a, b) => a + b, 0) / solved.length;
  }
  s.mo3 = meanOf(times, 3);
  s.ao5 = averageOf(times, 5);
  s.ao12 = averageOf(times, 12);
  s.ao50 = averageOf(times, 50);
  s.ao100 = averageOf(times, 100);
  s.bestAo5 = bestAverageOf(times, 5);
  s.bestAo12 = bestAverageOf(times, 12);
  return s;
}

/** 12.34, 1:02.34, DNF; '-' for undefined. */
export function formatTime(t: Time | undefined, decimals = 2): string {
  if (t === undefined) return '-';
  if (t === null) return 'DNF';
  // round in integer units first: (62.345).toFixed(2) is a coin toss in binary
  const unit = 10 ** (3 - decimals);
  const units = Math.round(t / unit);
  const perSec = 10 ** decimals;
  const secs = Math.floor(units / perSec), frac = String(units % perSec).padStart(decimals, '0');
  if (secs < 60) return `${secs}.${frac}`;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}.${frac}`;
}

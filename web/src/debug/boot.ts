// Boot timing on the console, for the load-time freeze on a phone (2026-09-26: scrollable but not
// tappable for a while, the tab still spinning). Three views of the same seconds:
//   [boot] +T  step (D ms)        each step of main.ts / the model load / the service worker, with
//                                 the time since navigation start and how long the step took
//   [boot] long task D ms at +T   every main-thread block over 50 ms, wherever it came from
//                                 (PerformanceObserver 'longtask'; Chrome only, the others say so)
//   [boot] loaded: ...            the navigation timing milestones, once the load event has fired
// Nothing here gates anything: a browser without the APIs just logs less.

const t0 = (): number => performance.timeOrigin;
const now = (): string => `+${(performance.now()).toFixed(0).padStart(5)} ms`;
let last = performance.now();

/** A step done: log it with the time since the last mark (main.ts's steps run back to back). */
export function mark(step: string): void {
  const t = performance.now();
  console.info(`[boot] ${now()}  ${step} (${(t - last).toFixed(0)} ms)`);
  last = t;
}

/** Time an async step by itself (the model load's stages, which interleave with everything else). */
export async function timed<T>(step: string, run: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try { return await run(); }
  finally { console.info(`[boot] ${now()}  ${step} took ${(performance.now() - t).toFixed(0)} ms`); }
}

/**
 * Every setTimeout callback in the first `forMs` timed, and one over 50 ms logged with the stack from
 * where it was scheduled: a long task from a timeout (the drills' first scrambles, the model load's
 * steps) named by its caller, which the longtask entry cannot do.
 */
function watchTimeouts(forMs: number): void {
  const w = window as unknown as { setTimeout: (...a: unknown[]) => number };
  const orig = w.setTimeout.bind(window);
  const until = performance.now() + forMs;
  w.setTimeout = (...args: unknown[]): number => {
    const fn = args[0];
    if (typeof fn !== 'function' || performance.now() > until) return orig(...args);
    const at = new Error().stack?.split('\n').slice(2, 6).map((l) => l.trim()).join(' <- ') ?? '?';
    const scheduled = performance.now();
    args[0] = function (this: unknown, ...a: unknown[]) {
      const t = performance.now();
      try { return (fn as (...x: unknown[]) => unknown).apply(this, a); }
      finally {
        const d = performance.now() - t;
        if (d > 50) console.warn(`[boot] timeout callback took ${d.toFixed(0)} ms (scheduled +${scheduled.toFixed(0)} ms, ran +${t.toFixed(0)} ms) from: ${at}`);
      }
    };
    return orig(...args);
  };
}

/** Start the observers: call first thing in main.ts. */
export function initBootLog(): void {
  watchTimeouts(30_000);
  console.info(`[boot] ${now()}  main.ts running (modules fetched, parsed and evaluated; origin ${new Date(t0()).toISOString()})`);
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const who = (e as PerformanceEntry & { attribution?: { containerType?: string; containerName?: string }[] }).attribution?.[0];
        console.warn(`[boot] long task ${e.duration.toFixed(0)} ms at +${e.startTime.toFixed(0)} ms${who?.containerName ? ` (${who.containerType} ${who.containerName})` : ''}`);
      }
    });
    po.observe({ type: 'longtask', buffered: true });
  } catch { console.info('[boot] no longtask observer in this browser'); }
  window.addEventListener('load', () => {
    const [n] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (!n) return;
    const ms = (v: number) => `${v.toFixed(0)}`;
    console.info(`[boot] loaded: response ${ms(n.responseEnd)}, DOM interactive ${ms(n.domInteractive)}, DOMContentLoaded ${ms(n.domContentLoadedEventEnd)}, load ${ms(n.loadEventEnd)} ms; ${n.transferSize} B transferred${navigator.serviceWorker?.controller ? ', under the service worker' : ''}; crossOriginIsolated=${String(self.crossOriginIsolated)}`);
    // the biggest resources so far (the runtime wasm, the models, the chunks): what the network was doing
    const res = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((r) => r.duration > 200 || r.transferSize > 200_000)
      .sort((a, b) => b.duration - a.duration).slice(0, 8);
    for (const r of res) console.info(`[boot] resource ${r.name.replace(location.origin, '')}: ${r.duration.toFixed(0)} ms, ${r.transferSize} B, started +${r.startTime.toFixed(0)} ms`);
  });
}

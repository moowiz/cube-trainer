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

/** Start the observers: call first thing in main.ts. */
export function initBootLog(): void {
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

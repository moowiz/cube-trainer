// Following a scramble on a smart cube, as every tab shows it (docs/
// maintenance-plan.md 3.5): one tracker per (scramble, cube's colours,
// hold) that reports where the cube is on it, the scramble's tokens with the
// done prefix marked, and the one-line status under them. The Solve tab, the
// last-layer drills and the cube's follow (app/cubefollow.ts) had each
// written the tracker bookkeeping for themselves.

import { toSourceLetters, type Hold } from '../handoff';
import type { ColorName, FaceId } from '../types';
import { ScrambleTracker, type TrackStatus } from './track';

/** One move as markup: the face letter, then the prime (a real ′) or the 2 marked so they read from a distance. */
export function moveHtml(m: string): string {
  const mod = m.endsWith("'") ? '<span class="p">′</span>' : m.endsWith('2') ? '<span class="d">2</span>' : '';
  return `<span class="mv">${mod ? m.slice(0, -1) : m}${mod}</span>`;
}

/** The shown token that move `applied` falls in, when each shown token covers `spans[j]` moves. */
export function shownIndex(spans: readonly number[] | undefined, applied: number): number {
  if (!spans) return applied;
  let at = 0;
  for (let j = 0; j < spans.length; j++) { if (applied < at + spans[j]!) return j; at += spans[j]!; }
  return spans.length;
}

/** The scramble's tokens as moveHtml spans, the applied prefix marked `done`; `spans` when a shown token covers more than one move (an M2 for R2 L2). */
export function scrambleHtml(toks: readonly string[], track: TrackStatus | null, spans?: readonly number[]): string {
  const applied = track ? track.applied : 0;
  const done = (j: number): boolean => { if (!spans) return j < applied; let at = 0; for (let k = 0; k <= j; k++) at += spans[k]!; return at <= applied; };
  return toks.map((t, j) => `<span class="${track && done(j) ? 'done' : ''}">${moveHtml(t)}</span>`).join(' ');
}

/**
 * The line under the scramble: '' with no cube, 'Scrambled ✓', 'n of m applied' (with the double
 * turn the cube is halfway through), or off the scramble - `off` when the caller has a better
 * undo to offer than "back to turn n".
 */
export function trackText(track: TrackStatus | null, toks: readonly string[], off?: string, spans?: readonly number[]): string {
  if (!track) return '';
  if (track.off) return off ?? `Off the scramble: undo back to turn ${track.applied} (underlined)`;
  if (track.matched) return 'Scrambled ✓';
  if (track.half) return `${track.applied} of ${track.total} applied · halfway through ${toks[shownIndex(spans, track.applied)]}`;
  return `${track.applied} of ${track.total} applied`;
}

/**
 * A tracker rebuilt only when the scramble, the cube's colours or the hold change: `status()`
 * is where the cube's belief stands on the trainer-frame `scramble`, null with no scramble or
 * one the tracker cannot read. `tracker()` is the current one, for a caller that needs its target.
 */
export function makeTrackWatcher(): {
  status(scramble: string | null, facelets: string | null, colourOf: Record<FaceId, ColorName>, hold: Hold): TrackStatus | null;
  tracker(): ScrambleTracker | null;
  reset(): void;
} {
  let tracker: ScrambleTracker | null = null;
  let key = '';
  return {
    status(scramble, facelets, colourOf, hold) {
      if (!scramble) { tracker = null; key = ''; return null; }
      const k = `${scramble}|${Object.values(colourOf).join(',')}|${hold.down}|${hold.front}`;
      if (k !== key) {
        try { tracker = new ScrambleTracker(toSourceLetters(colourOf, scramble, hold)); key = k; }
        catch { tracker = null; key = ''; }
      }
      return tracker ? tracker.status(facelets) : null;
    },
    tracker: () => tracker,
    reset() { tracker = null; key = ''; },
  };
}

/**
 * Mark an alg line's `.mv` spans (each numbered `data-i` from 0) with the route's progress: `done` moves
 * underlined, the one the cube is halfway through dotted; `skip` moves of the route come before the line.
 */
export function markRouteDone(mvs: Iterable<HTMLElement>, done: number, half: boolean, skip = 0): void {
  for (const mv of mvs) {
    const i = skip + Number(mv.dataset.i);
    mv.classList.toggle('done', i < done);
    mv.classList.toggle('half', half && i === done);
  }
}

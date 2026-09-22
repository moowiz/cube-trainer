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

/** The scramble's tokens as moveHtml spans, the applied prefix marked `done`. */
export function scrambleHtml(toks: readonly string[], track: TrackStatus | null): string {
  const applied = track ? track.applied : 0;
  return toks.map((t, i) => `<span class="${track && i < applied ? 'done' : ''}">${moveHtml(t)}</span>`).join(' ');
}

/**
 * The line under the scramble: '' with no cube, 'Scrambled ✓', 'n of m applied' (with the double
 * turn the cube is halfway through), or off the scramble - `off` when the caller has a better
 * undo to offer than "back to turn n".
 */
export function trackText(track: TrackStatus | null, toks: readonly string[], off?: string): string {
  if (!track) return '';
  if (track.off) return off ?? `Off the scramble: undo back to turn ${track.applied} (underlined)`;
  if (track.matched) return 'Scrambled ✓';
  if (track.half) return `${track.applied} of ${track.total} applied · halfway through ${toks[track.applied]}`;
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

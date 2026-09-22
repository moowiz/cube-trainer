// User-facing hint for a frame where the detector sees a cube but every quad
// is refused as unreadable. The reasons come from the quality checks the
// detection tick runs (detect/quality.ts); this turns the dominant one into
// something a person can act on. Pure so it can be tested without a camera.

import { TOO_SMALL_REASON } from '../detect/quality';

export interface Hint {
  key: 'closer' | 'light' | 'glare' | 'nocube';
  text: string;
}

const NO_CUBE: Hint = { key: 'nocube', text: 'No cube found — hold the cube in view' };

const HINTS: { key: Hint['key']; match: (reason: string) => boolean; text: string }[] = [
  { key: 'closer', match: (r) => r.startsWith(TOO_SMALL_REASON), text: 'Move closer — the cube is too small to read' },
  { key: 'light', match: (r) => r === 'too dark', text: 'More light — the cube is too dark to read' },
  { key: 'glare', match: (r) => r.startsWith('glare'), text: 'Glare — tilt the cube away from the light' },
];

/**
 * Pick a hint from the refusal reasons of this frame's refused quads (or, with
 * no quads, from the localizer: its box being too small, or it finding no
 * cube at all), or null when nothing actionable is happening. Majority reason
 * wins so a lone glare quad next to two too-small ones says "move closer".
 *
 * `noCube` is stage 1's miss (model/PORTRAIT-DESIGN.md section 3.2): the
 * detection tick produced nothing, so there are no reasons to read and the
 * tracker is decaying - the banner is the only thing that says why.
 *
 * `evidenceDark` comes from the readings themselves (scan-main's running
 * median of the brightest channel of what is being sampled) and wins over
 * everything: the per-face darkness test happily passes a face read at
 * RGB (40, 27, 14), and the solver then spends a minute failing to find a
 * legal cube in noise (scan-debug-1789348371807) with no banner at all.
 */
export function hintFor(reasons: readonly string[], anyFaceNamed: boolean, cubeTooSmall = false,
                        noCube = false, evidenceDark = false): Hint | null {
  if (evidenceDark) return { key: 'light', text: HINTS[1]!.text };
  if (anyFaceNamed) return null;
  // The localizer saw a cube whose whole silhouette is under the face floor:
  // no face can be big enough, whether or not the face detector fired.
  if (reasons.length === 0) {
    if (cubeTooSmall) return { key: 'closer', text: HINTS[0]!.text };
    return noCube ? NO_CUBE : null;
  }
  let best: Hint | null = null;
  let bestN = 0;
  for (const h of HINTS) {
    const n = reasons.filter(h.match).length;
    if (n > bestN) { best = { key: h.key, text: h.text }; bestN = n; }
  }
  return best;
}

/**
 * Debounces hints across frames: a hint shows only after it has held for
 * `holdMs` (a single refused frame during a turn is noise) and clears the
 * moment a face is read. Call `update` every frame; render what it returns.
 */
export class HintState {
  private candidate: Hint | null = null;
  private since = 0;
  private shown: Hint | null = null;

  // DECISION: 400 ms hold - about the time a slow turn spends passing
  // through a bad angle; long enough to not flicker, short enough to feel live.
  constructor(private readonly holdMs = 400) {}

  update(hint: Hint | null, now: number): Hint | null {
    if (!hint) { this.candidate = null; this.shown = null; return null; }
    if (!this.candidate || this.candidate.key !== hint.key) { this.candidate = hint; this.since = now; }
    if (now - this.since >= this.holdMs) this.shown = hint;
    return this.shown;
  }
}

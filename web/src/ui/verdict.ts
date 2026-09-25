// The scan sheet's verdicts as pure functions (docs/maintenance-plan.md 4.4):
// what the sheet says about the reading, the light and the host's scramble,
// computed from the solver's answer and the pipeline's numbers, with no DOM.
// ui/scanner.ts renders what these return; test/verdict.test.ts pins them.

import { diffFacelets, expectedFacelets, type Hold } from '../handoff';
import { COLOR_NAMES, DEFAULT_SCHEME_NAMES, type ColorName, type FaceId } from '../types';

/** The solver's naming, as much of a Solution as the colour lookups need. */
export interface Naming {
  colourLetter: readonly (FaceId | null)[];
  naming: { names: readonly (string | null)[] };
}

/** The colour each letter's centre carries, from the solver's naming (the standard scheme where it left a letter unnamed). */
export function coloursOf(sol: Naming): Record<FaceId, ColorName> {
  const out = { ...DEFAULT_SCHEME_NAMES };
  sol.colourLetter.forEach((letter, c) => {
    const name = sol.naming.names[c];
    if (letter && name && (COLOR_NAMES as readonly string[]).includes(name)) out[letter] = name as ColorName;
  });
  return out;
}

/** coloursOf, but only once the solver has named every face - a partial naming would check against the wrong frame. */
export function coloursOfStrict(sol: Naming): Record<FaceId, ColorName> | null {
  const named = sol.colourLetter.filter((l, c) => l && sol.naming.names[c]).length;
  return named === 6 ? coloursOf(sol) : null;
}

/** The host stage's scramble and hold: what the cube in view should be. */
export interface Expected { scramble: string; hold: Hold; shown?: string }

export interface ScrambleCheck { scramble: string; read: number; wrong: number[]; note?: string }

/** The check of a (partial) reading against the host's scramble; null when there is nothing to check against. */
export function scrambleCheck(exp: Expected | null | undefined, sol: Naming, letters: readonly (string | null)[]): ScrambleCheck | null {
  if (!exp) return null;
  const colourOf = coloursOfStrict(sol);
  if (!colourOf) return { scramble: exp.scramble, read: 0, wrong: [], note: 'waiting for all six centres' };
  try {
    const want = expectedFacelets(exp.scramble, exp.hold, colourOf);
    return { scramble: exp.scramble, ...diffFacelets(want, letters) };
  } catch (err) {
    return { scramble: exp.scramble, read: 0, wrong: [], note: err instanceof Error ? err.message : String(err) };
  }
}

/** The Check line under the host's scramble: its text and its state class ('' / ok / near / bad). */
export function scrambleCheckLine(chk: ScrambleCheck | null): { text: string; state: '' | 'ok' | 'near' | 'bad' } {
  if (!chk) return { text: 'scan to compare', state: '' };
  if (chk.note) return { text: chk.note, state: '' };
  const w = chk.wrong.length;
  if (chk.read === 0) return { text: 'no stickers read yet', state: '' };
  if (w === 0) return { text: `${chk.read} of 54 stickers read, all match ✓`, state: 'ok' };
  // DECISION: up to three wrong stickers is "close" - a lone misread, not a different cube
  return { text: `${chk.read} read, ${w} differ${w <= 3 ? ' (close)' : ''}`, state: w <= 3 ? 'near' : 'bad' };
}

/** The verdict row of the debug panel: locked, the solver's refusal, or its crash. */
export function verdictLine(locked: boolean, solverError: string | null, reason: string | null): string {
  if (locked) return 'locked ✓';
  if (solverError) return `solver failed: ${solverError.split('\n')[0]} (Capture debug and file it)`;
  return reason ?? '–';
}

// The evidence is too dark to read when the running median of the
// brightest channel of what is being sampled sits below this (sRGB): the
// SNR weight (evidence.ts BRIGHT_FULL) has such readings at a tenth of
// their weight, and the palette fit cannot separate colours in them
// (scan-debug-1789348371807 read whole faces at RGB (40, 27, 14)).
export const DARK_PEAK = 55;
// ...and too bright when the median peak is up here or this share of the
// sampled sticker pixels is clipped: whites and yellows both read (2xx,
// 25x, 25x) and stop separating (solve 1789360518933: peak 228-255, clip
// 0.17, and auto at 62.5 ms had every turn motion-blurred at 15 fps).
export const BRIGHT_PEAK = 215;
export const BRIGHT_CLIP = 0.12;

/** The light on the stickers: too dark, too bright, or bright whites over dark stickers that a darker exposure would lose. */
export function lightVerdict(peak: number, peakLow: number, clip: number): '' | 'too dark' | 'too bright' | 'whites clip, darkening would lose the blues' {
  if (peak < DARK_PEAK) return 'too dark';
  if (peak > BRIGHT_PEAK || clip > BRIGHT_CLIP) return peakLow / 2 > DARK_PEAK ? 'too bright' : 'whites clip, darkening would lose the blues';
  return '';
}

/** The peak row of the debug panel. */
export function lightLine(peak: number, peakLow: number, clip: number, hasReadings: boolean): string {
  if (peak === 255 && !hasReadings) return 'no readings yet';
  const v = lightVerdict(peak, peakLow, clip);
  return `${peak.toFixed(0)} / 255 (darkest tenth ${peakLow.toFixed(0)}) · ${(clip * 100).toFixed(0)}% clipped${v ? ` · ${v}` : ''}`;
}

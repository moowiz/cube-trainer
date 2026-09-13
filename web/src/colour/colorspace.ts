// The colour space the palette lives in (design 3.3). Pluggable on purpose:
// which space separates the six colours best under phone illumination is
// decided by the replay test, not by argument. Every candidate maps a whole
// quad at once because the third coordinate is RELATIVE lightness - a
// sticker's brightness compared with the rest of its own face - which is
// the "white is the brightest sticker on any face that has one" information
// the old crushed-L space threw away.

import { CHROMA_KNEE, CHROMA_SLOPE } from '../state';
import type { Lab } from '../types';
import type { RGB, Vec3 } from './types';

export type EmbeddingName = 'logchroma' | 'lab-rel' | 'lab-crushed';

export interface Embedding {
  name: EmbeddingName;
  /** Embed the readings of ONE quad (any count, typically 9). */
  embedQuad(rgb: readonly RGB[], lab: readonly Lab[]): Vec3[];
  /** Indices of the chromatic coordinates (the ones a white-balance shift translates). */
  chroma: [number, number];
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

// DECISION: log-chromaticity is exact for any multiplicative change (shading,
// exposure) and turns a white-balance change into a translation, but the log
// of a near-zero channel is noise: a blue sticker's red channel wanders 0-5
// and ln(0/255) is -inf. A soft log ln(x + EPS) with EPS 0.02 (about 5/255)
// keeps the deep-dark channels from dominating; SCALE puts the coordinates on
// a Lab-like scale (tens between colours) so sigma floors mean the same thing
// in every candidate.
const LOG_EPS = 0.02;
const LOG_SCALE = 30;

export const LOGCHROMA: Embedding = {
  name: 'logchroma',
  chroma: [0, 1],
  embedQuad(rgb) {
    const logs = rgb.map(([r, g, b]) => {
      const lr = Math.log(srgbToLinear(r) + LOG_EPS);
      const lg = Math.log(srgbToLinear(g) + LOG_EPS);
      const lb = Math.log(srgbToLinear(b) + LOG_EPS);
      const lum = Math.log(0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b) + LOG_EPS);
      return { lr, lg, lb, lum };
    });
    const medLum = median(logs.map((l) => l.lum));
    return logs.map(({ lr, lg, lb, lum }) => [
      ((lr - lg) / Math.SQRT2) * LOG_SCALE,
      ((lr + lg - 2 * lb) / Math.sqrt(6)) * LOG_SCALE,
      (lum - medLum) * LOG_SCALE,
    ]);
  },
};

function compress(a: number, b: number): [number, number] {
  const ch = Math.hypot(a, b);
  if (ch <= CHROMA_KNEE) return [a, b];
  const s = (CHROMA_KNEE + (ch - CHROMA_KNEE) * CHROMA_SLOPE) / ch;
  return [a * s, b * s];
}

/** Candidate B: face-relative L at full weight, ab compressed past the knee (what helped session-0913). */
export const LAB_REL: Embedding = {
  name: 'lab-rel',
  chroma: [1, 2],
  embedQuad(_rgb, lab) {
    const medL = median(lab.map((c) => c.L));
    return lab.map((c) => {
      const [a, b] = compress(c.a, c.b);
      return [c.L - medL, a, b];
    });
  },
};

/** Candidate C: the old clustering space (crushed relative L, plain ab), the baseline. */
export const LAB_CRUSHED: Embedding = {
  name: 'lab-crushed',
  chroma: [1, 2],
  embedQuad(_rgb, lab) {
    const medL = median(lab.map((c) => c.L));
    return lab.map((c) => [(c.L - medL) * 0.15, c.a, c.b]);
  },
};

export const EMBEDDINGS: Record<EmbeddingName, Embedding> = {
  logchroma: LOGCHROMA,
  'lab-rel': LAB_REL,
  'lab-crushed': LAB_CRUSHED,
};

// DECISION 2026-09-13: the bake-off on the seven single-frame truths
// (test/colour-replay.test.ts) has logchroma and lab-crushed level at 6/7
// exact (the seventh, the blue-monitor scan, is correctly refused by both)
// and lab-rel behind at 4/7 - full-weight lightness hurts. logchroma is the
// design's hypothesis and the only space in which the per-frame gain of
// illum.ts is a translation, so it ships; the table is printed on every run
// and multi-frame phone logs will decide for good.
export const DEFAULT_EMBEDDING: Embedding = LOGCHROMA;

// The colour space the palette lives in (design 3.3). Pluggable on purpose:
// which space separates the six colours best under phone illumination is
// decided by the replay test, not by argument. Every candidate maps a whole
// quad at once because the third coordinate is RELATIVE lightness - a
// sticker's brightness compared with the rest of its own face - which is
// the "white is the brightest sticker on any face that has one" information
// the old crushed-L space threw away.

import { linearRgbToLab } from '../color';
import { CHROMA_KNEE, CHROMA_SLOPE } from '../state';
import type { Lab } from '../types';
import type { RGB, Vec3 } from './types';

export type EmbeddingName = 'logchroma' | 'lab-rel' | 'lab-crushed' | 'lab-half' | 'lab-norm';

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

/** Face-relative L at weight `w`, plain ab. w = 0.15 is the old clustering space. */
export function labWeighted(name: EmbeddingName, w: number): Embedding {
  return {
    name,
    chroma: [1, 2],
    embedQuad(_rgb, lab) {
      const medL = median(lab.map((c) => c.L));
      return lab.map((c) => [(c.L - medL) * w, c.a, c.b]);
    },
  };
}

/** Candidate C: the old clustering space (crushed relative L, plain ab), the baseline. */
export const LAB_CRUSHED: Embedding = labWeighted('lab-crushed', 0.15);
export const LAB_HALF: Embedding = labWeighted('lab-half', 0.5);

// Lab of the reading scaled to a fixed luminance in LINEAR light, with the
// raw face-relative lightness crushed as in lab-crushed. Why: Lab chroma is
// proportional to intensity in the dark (f is linear below Y = 0.9%), so a
// red sticker read at RGB (52, 17, 10) on a backlit cube has a,b (13, 11)
// where the same sticker in the light has (60, 45): every dark sticker
// collapses onto white and a webcam session in an evening room
// (scan-debug-1789348371807) fits a palette of dark greys. Scaling the
// linear RGB first puts the dark reading at (63, 52) - the multiplicative
// model exact for shading and exposure, wrong only where the camera's black
// level has clipped a channel (a reading's weight, not this map, carries
// that). The luminance floor keeps a black seam from being blown up into
// a random hue.
const NORM_Y = 0.3;
const NORM_Y_FLOOR = 0.002;

export const LAB_NORM: Embedding = {
  name: 'lab-norm',
  chroma: [1, 2],
  embedQuad(rgb, lab) {
    const medL = median(lab.map((c) => c.L));
    return rgb.map(([r, g, b], i) => {
      const rl = srgbToLinear(r);
      const gl = srgbToLinear(g);
      const bl = srgbToLinear(b);
      const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
      const k = NORM_Y / Math.max(y, NORM_Y_FLOOR);
      const n = linearRgbToLab(rl * k, gl * k, bl * k);
      return [(lab[i]!.L - medL) * 0.15, n.a, n.b];
    });
  },
};

export const EMBEDDINGS: Record<EmbeddingName, Embedding> = {
  logchroma: LOGCHROMA,
  'lab-norm': LAB_NORM,
  'lab-rel': LAB_REL,
  'lab-crushed': LAB_CRUSHED,
  'lab-half': LAB_HALF,
};

// DECISION 2026-09-13: the bake-off on the seven single-frame truths
// (test/colour-replay.test.ts) has logchroma and lab-crushed level at 6/7
// exact (the seventh, the blue-monitor scan, is correctly refused by both)
// and lab-rel behind at 4/7 - full-weight lightness hurts. On the first two
// PHONE captures lab-crushed classified all 54 free on both (changed 0,
// delta 60) where logchroma needed the decoder to move four orange
// stickers off red (delta 13): the soft log compresses the dark channels
// that separate a shaded red from orange. Two real captures beat one
// theory; lab-crushed ships, the table is printed on every run.
export const DEFAULT_EMBEDDING: Embedding = LAB_CRUSHED;

// Is this quad worth reading at all? (docs/maintenance-plan.md 3.1)
//
// Four cheap tests on a detected quad, in the order the evidence arrives:
// too small to place a sticker grid on, too dark to carry colour, blown out
// by a highlight, or a centre sticker whose ring disagrees with itself
// (a logo, a fingertip, glare). They are about the SAMPLE, never about
// identity: what colour a face is, and which face it is, is the colour
// solver's job (colour/) and happens off the detection tick.
//
// The scan sheet turns the dominant refusal into the user's hint ("move
// closer", "more light", "tilt away from the light" - ui/hint.ts) and draws
// the refused quads in the debug overlay. Until 2026-09-22 these tests were
// the first half of identify.ts's nameQuads, so the app ran the whole
// exemplar namer every tick to get them.

import { facePlan, isFaceBlownOut, isFaceTooDark, minFaceEdgePx, RING_INCOHERENT_LAB, sampleGridCells } from '../colour/patch';
import { warpQuad, type ImageDataLike } from '../rectify';

/** Prefix of the refusal reason for a face too small to sample. A hint reads it. */
export const TOO_SMALL_REASON = 'face too small';
/** Prefix of the refusal reason for a centre sticker with something on it. */
const OBSCURED_REASON = 'centre obscured';

/** Where the quad's frame sits in the source: the size gate is decided in SOURCE px. */
export interface FrameGeom {
  /** Source px per frame px (the letterboxed crop zooms every cube to about the same size). */
  srcPerPx: number;
  /** Height of the full source frame: the face-size floor is a fraction of it. */
  sourceH: number;
}

export interface QuadQuality {
  /** Why this quad must not be read this tick; null when it is fine. */
  reason: string | null;
  /** Shortest quad edge in SOURCE px (the size gate's measurement). */
  minEdgePx: number;
}

/** Shortest edge of a quad, in the quad's own units. */
function minEdgeOf(quad: readonly (readonly [number, number])[]): number {
  let min = Infinity;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = quad[k]!;
    const [bx, by] = quad[(k + 1) % 4]!;
    min = Math.min(min, Math.hypot(bx - ax, by - ay));
  }
  return min;
}

/**
 * Check one quad against the four tests. `frame` is whatever the corners are in (the letterboxed
 * frame the model saw, or the source itself); `geom` says how that relates to source pixels.
 */
export function quadQuality(
  frame: ImageDataLike,
  quad: readonly (readonly [number, number])[],
  geom: FrameGeom = { srcPerPx: 1, sourceH: frame.height },
): QuadQuality {
  // Rule 0: the rectified canvas is always 90x90, so it says nothing about how many real pixels
  // the face covered, and neither does the letterboxed crop. Size the sampling from the quad in
  // SOURCE px, and refuse outright below the range floor - a fraction of the source frame height -
  // where the detector's corner error would be a large fraction of a sticker (colour/patch.ts facePlan).
  const minEdgePx = minEdgeOf(quad) * geom.srcPerPx;
  const floor = minFaceEdgePx(geom.sourceH);
  const plan = facePlan(minEdgePx / 3, floor);
  if (!plan) return { reason: `${TOO_SMALL_REASON} (${minEdgePx.toFixed(0)}px edge, need ${floor.toFixed(0)})`, minEdgePx };

  const warped = warpQuad(frame, quad, 90);
  const samples = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 }, plan);
  const cells = samples.map((s) => s.lab);
  if (isFaceTooDark(cells)) return { reason: 'too dark', minEdgePx };
  if (isFaceBlownOut(cells)) return { reason: 'glare: face blown out', minEdgePx };
  // Something is on the middle of the centre sticker AND the ring built to see around it does not
  // agree with itself. sampleCentreCell handles the ordinary obscured case by reading the ring;
  // this is the case where even that failed, and a reading known to be contaminated is exactly how
  // a white centre used to get called blue.
  const centre = samples[4]!;
  if (centre.obscured && (centre.ringSpread ?? 0) > RING_INCOHERENT_LAB) {
    return { reason: `${OBSCURED_REASON} (ring disagrees by ${(centre.ringSpread ?? 0).toFixed(0)})`, minEdgePx };
  }
  return { reason: null, minEdgePx };
}

/** quadQuality over a frame's quads, parallel to the input. */
export function quadsQuality(
  frame: ImageDataLike,
  quads: readonly (readonly (readonly [number, number])[])[],
  geom?: FrameGeom,
): QuadQuality[] {
  return quads.map((q) => quadQuality(frame, q, geom));
}

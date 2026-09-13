// Name anonymous detector quads by their center sticker (M4, center-v1 head).
//
// The CenterNet head emits quads with no face identity (model/train/model.py
// FaceKPCenter). That is deliberate: identity is not a geometric property,
// it is a COLOR property, and this is the layer that reads it. The generator
// renders every cube in the fixed standard scheme, so the six named output
// slots the old head carried were really learning "what color is the middle
// sticker" — a question the app can answer directly and far more robustly,
// because the app can keep updating its idea of what each color looks like
// under the light it is actually in.
//
// This is item 2 of web/src/color-notes.md ("center stickers are free
// labeled exemplars") and it stays consistent with "centers define the
// scheme" (CLAUDE.md): the default-scheme exemplars below only break ties
// until a real center has been observed.
//
// Out of scope: non-standard color schemes (e.g. white opposite blue). The
// default prior assumes the standard arrangement — the same assumption the
// trained model has always made.
import {
  facePlan, isFaceBlownOut, isFaceTooDark, labDistance, labMedian, minFaceEdgePx,
  RING_INCOHERENT_LAB, sampleGridCells, srgbToLab,
} from '../color';
import { warpQuad, type ImageDataLike } from '../rectify';
// CENTER_MIN_DIST was calibrated in the clustering space, but it survives the
// move to NAME_L_WEIGHT unchanged in the safe direction: two readings of the
// SAME face have near-identical relative-L profiles, so their distance is
// still chroma-dominated (~6 on the calibration fixtures), while two genuinely
// different faces only move FURTHER apart once lightness counts fully.
import { CENTER_MIN_DIST, NAME_L_WEIGHT, normalizeFaceCells } from '../state';
import type { ColorName, FaceId, Lab } from '../types';
import { DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';

/** The colour word a face id means under the (possibly measured) scheme. */
function colorOf(face: FaceId): ColorName {
  return DEFAULT_SCHEME_NAMES[face];
}

/**
 * Prefix of the refusal reason for a face too small to sample. Exported so a
 * debug view can style this refusal differently from a naming failure: it is
 * not that the color was unreadable, it is that the app declined to guess.
 */
export const TOO_SMALL_REASON = 'face too small';

/** Prefix of the refusal reason for a center sticker with something on it. */
export const OBSCURED_REASON = 'center obscured';

/** Faces that can never be co-visible: naming both in one frame is a bug. */
const OPPOSITE: Record<FaceId, FaceId> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

// Keep the newest N observed centers per face and take their median. A
// reservoir rather than an EMA so one glare frame cannot drag the exemplar,
// and short so the exemplar follows the user walking into another room.
const OBS_RESERVOIR = 15;

export interface NamedQuad {
  /** null when the quad could not be named; `reason` says why. */
  face: FaceId | null;
  /**
   * The colour word this quad's center actually matched — first-class, not
   * an intermediate thrown away on the way to `face`. Set whenever a best
   * candidate was computed, even if `face` ended up null (lost a tie-break,
   * or rejected as a duplicate/opposite): the app still knows what colour it
   * saw, and that is what the user should read, not the cubejs letter. Null
   * only when no color match was attempted at all (too dark, blown out).
   */
  color: ColorName | null;
  reason: string;
  /** 1 - d1/d2 against the runner-up exemplar, clamped to [0,1]. */
  nameConf: number;
  /** The quad's center sticker in the normalized clustering space. */
  center?: Lab;
  /** The 9 sampled cells, so a caller that accepts the name can feed them
   *  straight back to CenterExemplars.observe without re-sampling. */
  cells?: Lab[];
  /** The center patch in sRGB, for the debug swatches. */
  rgb?: [number, number, number];
  /** The same 9 cells in sRGB, in the same order as `cells`. Already sampled
   *  alongside the Lab; kept so a debug view can show what was looked at. */
  cellRgb?: [number, number, number][];
  /** The 9 cells in the normalized clustering space `center` lives in - this
   *  is the space the naming distance is measured in, so a debug view that
   *  showed raw Lab would not be showing the numbers the decision used. */
  cellsNorm?: Lab[];
  /** Every exemplar distance for the CENTER cell, nearest first - the full
   *  ranking the decision was made from, not just the winner it produced.
   *  The app ranks only the center; per-cell rankings are a debug-time
   *  derivation, not something naming computes. */
  ranked?: { face: FaceId; d: number }[];
  /** Shortest edge of the quad in SOURCE px (the camera frame's pixels, not
   *  the letterboxed crop naming sampled from). Set whenever the quad was
   *  measured at all — including on the refusal, so a debug view can say how
   *  far under the limit the face was. */
  minEdgePx?: number;
}

/**
 * How the frame naming samples from relates to the camera frame. Stage 2
 * looks at a letterboxed CROP, so a quad's size in that frame says nothing
 * about how far away the cube is; the size gate and the sampling plan are
 * decided in source px (color.ts MIN_FACE_EDGE_FRAC, facePlan).
 */
export interface FrameGeom {
  /** Source px per frame px (the inverse of the letterbox scale). */
  srcPerPx: number;
  /** Source frame height, px - the unit the range floor is defined in. */
  sourceH: number;
}

function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  return srgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/**
 * What each face's center sticker looks like, in the same normalized space
 * assembleState clusters in (`normalizeFaceCells`).
 *
 * Seeded from DEFAULT_SCHEME_HEX so the very first frame can be named at
 * all, then replaced face by face with the running median of real
 * observations. The seed is an approximation twice over — a nominal hex, and
 * a median lightness borrowed from the six nominal colors rather than from a
 * real face — which is exactly why it is only a tie-breaker of last resort.
 */
export class CenterExemplars {
  private obs = new Map<FaceId, Lab[]>();
  private raw = new Map<FaceId, [number, number, number][]>();
  private readonly seed: Record<FaceId, Lab>;

  constructor() {
    const labs = FACE_ORDER.map((f) => hexToLab(DEFAULT_SCHEME_HEX[f]));
    const medL = labMedian(labs).L;
    this.seed = {} as Record<FaceId, Lab>;
    FACE_ORDER.forEach((f, i) => {
      const c = labs[i]!;
      this.seed[f] = { L: (c.L - medL) * NAME_L_WEIGHT, a: c.a, b: c.b };
    });
  }

  /** Normalized-space exemplar for one face: observed median, else the seed. */
  get(face: FaceId): Lab {
    const seen = this.obs.get(face);
    return seen && seen.length ? labMedian(seen) : this.seed[face];
  }

  /** True once this face has a real observed exemplar. */
  isMeasured(face: FaceId): boolean {
    return (this.obs.get(face)?.length ?? 0) > 0;
  }

  /**
   * Record a confidently named, seam-verified face. Takes the whole 9-cell
   * reading rather than just the center because the normalization subtracts
   * the face's own median lightness — that is what cancels auto-exposure
   * drift between frames, and it needs all nine.
   */
  observe(face: FaceId, cells: readonly Lab[], rgb?: [number, number, number]): void {
    if (cells.length !== 9) return;
    const list = this.obs.get(face) ?? [];
    list.push(normalizeFaceCells(cells, NAME_L_WEIGHT)[4]!);
    if (list.length > OBS_RESERVOIR) list.shift();
    this.obs.set(face, list);
    if (rgb) {
      const r = this.raw.get(face) ?? [];
      r.push(rgb);
      if (r.length > OBS_RESERVOIR) r.shift();
      this.raw.set(face, r);
    }
  }

  /** CSS colors for the debug panel's six swatches. */
  swatches(): Record<FaceId, { css: string; measured: boolean }> {
    const out = {} as Record<FaceId, { css: string; measured: boolean }>;
    for (const f of FACE_ORDER) {
      const r = this.raw.get(f);
      const css = r && r.length
        ? `rgb(${med(r.map((x) => x[0]))},${med(r.map((x) => x[1]))},${med(r.map((x) => x[2]))})`
        : DEFAULT_SCHEME_HEX[f];
      out[f] = { css, measured: this.isMeasured(f) };
    }
    return out;
  }

  reset(): void {
    this.obs.clear();
    this.raw.clear();
  }
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[s.length >> 1]!);
}

/**
 * Name each quad from its center sticker.
 *
 * `frame` and `quads` must be in the SAME pixel space (facekp.ts passes the
 * letterboxed frame the model itself saw, with quads in letterbox pixels).
 * The returned array is parallel to `quads` — a quad that could not be named
 * comes back with `face: null` and a reason, never silently reordered.
 *
 * Rules, in order:
 *   1. a face that is blown out or chroma-dead end to end cannot be named
 *      (note the test is on the whole FACE, not the center cell: white is a
 *      real sticker color, and isGlareSample on the center alone would
 *      refuse every U face under a bright light);
 *   2. two quads may not receive the same face in one frame — the closer
 *      match keeps it;
 *   3. two quads whose centers are within CENTER_MIN_DIST of each other are
 *      not distinguishable, whatever the exemplars say, so only the higher
 *      scoring one survives;
 *   4. opposite faces can never be co-visible; if naming produces such a
 *      pair, the lower detection score loses.
 * A mis-name that survives all four is caught downstream: the FaceTracker is
 * keyed by FaceId and its centroid gate rejects a quad that suddenly claims
 * another face's track, exactly as it rejects a false detection today.
 */
export function nameQuads(
  frame: ImageDataLike,
  quads: readonly (readonly [number, number][])[],
  exemplars: CenterExemplars,
  scores?: readonly number[],
  /** Default: `frame` IS the source (tests, full-frame callers). */
  geom: FrameGeom = { srcPerPx: 1, sourceH: frame.height },
): NamedQuad[] {
  interface Cand {
    i: number;
    face: FaceId;
    dist: number;
    nameConf: number;
    center: Lab;
    cells: Lab[];
    rgb: [number, number, number];
    score: number;
  }
  const out: NamedQuad[] = quads.map(() => ({ face: null, color: null, reason: 'unprocessed', nameConf: 0 }));
  const cands: Cand[] = [];

  quads.forEach((quad, i) => {
    // Rule 0: the rectified canvas is always 90x90, so it says nothing about
    // how many real pixels the face covered, and neither does the letterboxed
    // crop `frame` (the crop zooms every cube to about the same size). Size
    // the sampling from the quad in SOURCE px, and refuse outright when the
    // face is under the range floor - a fraction of the source frame height -
    // where the detector's corner error would be a large fraction of a
    // sticker (see color.ts facePlan).
    let minEdge = Infinity;
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = quad[k]!;
      const [bx, by] = quad[(k + 1) % 4]!;
      minEdge = Math.min(minEdge, Math.hypot(bx - ax, by - ay));
    }
    minEdge *= geom.srcPerPx;
    const floor = minFaceEdgePx(geom.sourceH);
    const plan = facePlan(minEdge / 3, floor);
    if (!plan) {
      out[i] = { face: null, color: null, nameConf: 0, minEdgePx: minEdge,
                 reason: `${TOO_SMALL_REASON} (${minEdge.toFixed(0)}px edge, need ${floor.toFixed(0)})` };
      return;
    }
    const warped = warpQuad(frame, quad, 90);
    const samples = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 }, plan);
    const cells = samples.map((s) => s.lab);
    if (isFaceTooDark(cells)) {
      out[i] = { face: null, color: null, reason: 'too dark', nameConf: 0, minEdgePx: minEdge };
      return;
    }
    if (isFaceBlownOut(cells)) {
      out[i] = { face: null, color: null, reason: 'glare: face blown out', nameConf: 0, minEdgePx: minEdge };
      return;
    }
    // Rule 1b: something is on the middle of the center sticker (logo, a
    // fingertip, glare) AND the ring built to see around it does not agree
    // with itself. sampleCentreCell handles the ordinary obscured case by
    // reading the ring; this is the case where even that failed, and naming
    // from a reading known to be contaminated is exactly how a white center
    // gets called blue.
    const centre = samples[4]!;
    if (centre.obscured && (centre.ringSpread ?? 0) > RING_INCOHERENT_LAB) {
      out[i] = { face: null, color: null, nameConf: 0, minEdgePx: minEdge,
                 reason: `${OBSCURED_REASON} (ring disagrees by ${(centre.ringSpread ?? 0).toFixed(0)})` };
      return;
    }
    const cellsNorm = normalizeFaceCells(cells, NAME_L_WEIGHT);
    const center = cellsNorm[4]!;
    const ranked = FACE_ORDER
      .map((f) => ({ f, d: labDistance(center, exemplars.get(f)) }))
      .sort((a, b) => a.d - b.d);
    const [best, second] = ranked as [{ f: FaceId; d: number }, { f: FaceId; d: number }];
    const nameConf = second.d > 0 ? Math.max(0, Math.min(1, 1 - best.d / second.d)) : 0;
    // `dbg` is the evidence this decision was made from, carried out verbatim
    // - nothing here is recomputed for the debug view, it is the same arrays
    // and the same `ranked` the winner was picked from.
    const dbg = {
      cells,
      cellsNorm,
      cellRgb: samples.map((s) => s.rgb),
      ranked: ranked.map((r) => ({ face: r.f, d: r.d })),
    };
    cands.push({ i, face: best.f, dist: best.d, nameConf, center, cells,
                 rgb: samples[4]!.rgb, score: scores?.[i] ?? 1 });
    out[i] = { face: null, color: colorOf(best.f), reason: 'lost a tie-break', nameConf, center,
               rgb: samples[4]!.rgb, minEdgePx: minEdge, ...dbg };
  });

  // Rule 3, before assignment: two quads that look the same cannot both be
  // trusted no matter which exemplars they are nearest to.
  const dropped = new Set<number>();
  for (let a = 0; a < cands.length; a++) {
    for (let b = a + 1; b < cands.length; b++) {
      const ca = cands[a]!;
      const cb = cands[b]!;
      if (dropped.has(ca.i) || dropped.has(cb.i)) continue;
      if (labDistance(ca.center, cb.center) < CENTER_MIN_DIST) {
        const loser = ca.score >= cb.score ? cb : ca;
        dropped.add(loser.i);
        out[loser.i] = { ...out[loser.i]!, face: null, color: colorOf(loser.face),
                         reason: 'center matches another quad',
                         nameConf: loser.nameConf, center: loser.center };
      }
    }
  }

  // Rule 2: best match wins a contested face; the loser is dropped rather
  // than demoted to its runner-up, because a quad whose center was nearest a
  // face already taken has told us its color reading is unreliable.
  const taken = new Map<FaceId, Cand>();
  for (const c of [...cands].sort((x, y) => x.dist - y.dist)) {
    if (dropped.has(c.i)) continue;
    const held = taken.get(c.face);
    if (held) {
      out[c.i] = { ...out[c.i]!, face: null, color: colorOf(c.face),
                   reason: `${colorOf(c.face)} already claimed (${c.face})`,
                   nameConf: c.nameConf, center: c.center };
      continue;
    }
    taken.set(c.face, c);
  }

  // Rule 4: an opposite pair in one frame is geometrically impossible.
  for (const [face, c] of [...taken]) {
    const opp = taken.get(OPPOSITE[face]);
    if (!opp || !taken.has(face)) continue;
    const loser = c.score >= opp.score ? opp : c;
    taken.delete(loser.face);
    out[loser.i] = { ...out[loser.i]!, face: null, color: colorOf(loser.face),
                     reason: `${colorOf(face)}/${colorOf(OPPOSITE[face])} cannot be co-visible (${face}/${OPPOSITE[face]})`,
                     nameConf: loser.nameConf, center: loser.center };
  }

  for (const [face, c] of taken) {
    out[c.i] = { ...out[c.i]!, face, color: colorOf(face), reason: 'ok',
                 nameConf: c.nameConf, center: c.center, cells: c.cells, rgb: c.rgb };
  }
  return out;
}

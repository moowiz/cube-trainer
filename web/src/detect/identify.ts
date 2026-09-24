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
import { labDistance, labMedian, srgbToLab } from '../colour/lab';
import { facePlan, isFaceBlownOut, isFaceTooDark, minFaceEdgePx, RING_INCOHERENT_LAB, sampleGridCells } from '../colour/patch';
import { warpQuad, type ImageDataLike } from '../rectify';
// CENTER_MIN_DIST was calibrated in the clustering space, but it survives the
// move to NAME_L_WEIGHT unchanged in the safe direction: two readings of the
// SAME face have near-identical relative-L profiles, so their distance is
// still chroma-dominated (~6 on the calibration fixtures), while two genuinely
// different faces only move FURTHER apart once lightness counts fully.
import type { ColorName, FaceId, Lab } from '../types';
import { DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';

// ---------- the namer's colour space ----------

// DECISION: cluster in an exposure-normalized space — subtract each face's
// median L (cancels the camera's auto-exposure drift between captures) and
// weight the residual L by 0.15 (color identity lives mostly in a/b; after
// per-face centering, L residual depends on what else shares the face — it is
// more noise dimension than signal, and keeping it heavy lets k-means split
// clusters along it or drown a small a/b separation). On the backlit-kitchen
// frame fixtures normalization fixes a red→orange miss that plain Lab makes,
// and accuracy holds at 44/45 for any L weight from 1 down to 0.15 (see
// test/lowlight.test.ts); well-lit colors stay separated because they differ
// strongly in a/b anyway.
export const CLUSTER_L_WEIGHT = 0.15;

/**
 * Lightness weight for naming a face against fixed exemplars.
 *
 * MEASURED: CLUSTER_L_WEIGHT is right for its own job — clustering all 54
 * stickers RELATIVE to each other, where crushing L cancels auto-exposure
 * drift between captures and lets chroma do the separating. Reusing it to
 * match against an absolute exemplar throws away the one dimension that
 * separates white from a dark color: white sits at a*~0 b*~0, so any weakly
 * chromatic sample lands nearest it. On a phone capture a blue center at
 * L* 18 a* +2 b* -28 (face median L 18) ranked white 29.4 / blue 41.8 at
 * weight 0.15, and white 43.3 / blue 45.7 at weight 1.0 — the crush, not the
 * color, is what named it white. Naming keeps the median-L subtraction (still
 * exposure-invariant) but pays full price for lightness.
 */
export const NAME_L_WEIGHT = 1.0;

/**
 * Map one face's 9 cells into a normalized space: subtract the face's own
 * median lightness (this is what cancels exposure drift) and scale what is
 * left. Default weight is the clustering one assembleState uses; naming
 * passes NAME_L_WEIGHT.
 */
export function normalizeFaceCells(cells: readonly Lab[], lWeight = CLUSTER_L_WEIGHT): Lab[] {
  const medL = labMedian(cells).L;
  return cells.map((c) => ({ L: (c.L - medL) * lWeight, a: c.a, b: c.b }));
}

// DECISION: two centres closer than this in the normalized space are
// treated as the same physical face seen twice (the namer's duplicate
// guard). Calibrated on fixtures: genuinely duplicated or unusable centre
// pairs sit at ~6 (cube-scan-1789101879130), while the hardest legitimate
// pair seen — white under a blue monitor cast vs a real blue centre
// (cube-scan-1789102942492) — sits at 12.8 and must stay apart.
const CENTER_MIN_DIST = 10;

/** The colour word a face id means under the (possibly measured) scheme. */
function colorOf(face: FaceId): ColorName {
  return DEFAULT_SCHEME_NAMES[face];
}

/**
 * Prefix of the refusal reason for a face too small to sample. Exported so a
 * debug view can style this refusal differently from a naming failure: it is
 * not that the color was unreadable, it is that the app declined to guess.
 */
const TOO_SMALL_REASON = 'face too small';

/** Prefix of the refusal reason for a center sticker with something on it. */
const OBSCURED_REASON = 'center obscured';

/** Prefix of the refusal reason when the two nearest exemplars are too close to call. */
export const AMBIGUOUS_REASON = 'ambiguous centre';

// DECISION 2026-09-13: a name needs a margin. nameConf = 1 - best/second;
// below this the frame contributes nothing rather than a coin flip. Taken
// from a captured failure (scan-debug-1789290604959): a blue centre under
// warm room light sat 54.5 from the measured green exemplar and 55.1 from
// the nominal blue prior (nameConf 0.01), was named green, and then taught
// the green exemplar to be blue - after which every blue read as green at
// nameConf 0.97. Real names in the same session ran at 0.5-0.98.
export const MIN_NAME_CONF = 0.25;

// An observation may not move a face's exemplar by more than this (naming
// space units) once the face has been measured, and may never be nearer to
// another face's exemplar than to its own. Ordinary exposure drift between
// frames is a few units; a different sticker colour is 40-60.
export const MAX_OBS_DRIFT = 25;

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
 * decided in source px (colour/patch.ts MIN_FACE_EDGE_FRAC, facePlan).
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
  /** Priors for the unmeasured faces, re-fitted whenever a measurement lands. */
  private prior: Record<FaceId, Lab> | null = null;
  /** Observations refused by the drift / nearest-face guards (debug stat). */
  rejected = 0;
  /** The last EXEMPLAR_LOG events (accepted and refused observations), oldest first. */
  readonly history: ExemplarEvent[] = [];

  private log(kind: ExemplarEvent['kind'], face: FaceId, own: number, other?: FaceId, otherD?: number): void {
    this.history.push({ t: Date.now(), kind, face, own: +own.toFixed(1),
                        ...(other ? { other, otherD: +(otherD ?? 0).toFixed(1) } : {}) });
    if (this.history.length > EXEMPLAR_LOG) this.history.shift();
  }

  constructor() {
    const labs = FACE_ORDER.map((f) => hexToLab(DEFAULT_SCHEME_HEX[f]));
    const medL = labMedian(labs).L;
    this.seed = {} as Record<FaceId, Lab>;
    FACE_ORDER.forEach((f, i) => {
      const c = labs[i]!;
      this.seed[f] = { L: (c.L - medL) * NAME_L_WEIGHT, a: c.a, b: c.b };
    });
  }

  /** Normalized-space exemplar for one face: observed median, else the scene-adapted prior. */
  get(face: FaceId): Lab {
    const seen = this.obs.get(face);
    if (seen && seen.length) return labMedian(seen);
    this.prior ??= this.fitPriors();
    return this.prior[face];
  }

  /** True once this face has a real observed exemplar. */
  isMeasured(face: FaceId): boolean {
    return (this.obs.get(face)?.length ?? 0) > 0;
  }

  /**
   * The nominal scheme colours are what a cube looks like in a render; a real
   * room drains their chroma. Estimate how much, per axis, from the faces
   * that HAVE been measured and predict the rest through it.
   *
   * Model (DECISION 2026-09-13): prior = (ka * a_nominal, kb * b_nominal),
   * ka/kb the median ratio measured/nominal over chromatic faces, clamped to
   * [0.3, 1] - a room never makes a sticker MORE saturated than the render -
   * plus a lightness shift. No additive chroma shift: warm light moves a
   * neutral a long way in +b but a saturated sticker much less, so any shift
   * fitted from white over-predicts the chromatic faces (white alone put the
   * red prior at b 65 against a measured red at 25), and a shift fitted from
   * yellow/orange (which LOSE b) sends blue the wrong way (a least-squares
   * scale+shift on green/yellow/orange, scan-debug-1789291701546, put blue at
   * b -102). Checked against the fully measured session
   * scan-debug-1789291642684: from {green, yellow, orange} the predicted
   * white/red/blue priors are each nearest their own real exemplar.
   */
  private fitPriors(): Record<FaceId, Lab> {
    const measured = FACE_ORDER.filter((f) => this.isMeasured(f));
    const out = { ...this.seed };
    if (measured.length === 0) return out;
    const m = new Map(measured.map((f) => [f, labMedian(this.obs.get(f)!)]));
    const med = (xs: number[]) => { const t = [...xs].sort((x, y) => x - y); return t[t.length >> 1]!; };
    const ratio = (axis: 'a' | 'b') => {
      const rs = measured.filter((f) => Math.abs(this.seed[f][axis]) > 15).map((f) => m.get(f)![axis] / this.seed[f][axis]);
      return rs.length ? Math.max(PRIOR_SCALE_MIN, Math.min(PRIOR_SCALE_MAX, med(rs))) : PRIOR_SCALE_ONE_FACE;
    };
    const ka = ratio('a');
    const kb = ratio('b');
    const tL = med(measured.map((f) => m.get(f)!.L - this.seed[f].L));
    for (const f of FACE_ORDER) {
      if (this.isMeasured(f)) continue;
      const c = this.seed[f];
      out[f] = { L: c.L + tL, a: ka * c.a, b: kb * c.b };
    }
    return out;
  }

  /**
   * Distance from a normalized centre to a face's exemplar. Lightness in the
   * naming space is relative to the face's OWN median, so it depends on which
   * eight stickers surround the centre: a red exemplar learned on a face where
   * red was the darkest sticker carries L -27, and a red sticker on a face
   * where it is the median sits at 0 (scan-debug-1789291642684: red cells
   * ranked orange 23 vs red 29 for exactly this reason). Against a MEASURED
   * exemplar the L term is therefore mostly scramble noise and is weighted
   * like the clustering space; against a nominal prior it is the only thing
   * that separates a dark, chroma-drained blue from white (naming-space.test)
   * and keeps its full weight.
   */
  distance(center: Lab, face: FaceId): number {
    const e = this.get(face);
    const w = this.isMeasured(face) ? MEASURED_L_WEIGHT : 1;
    return Math.hypot((center.L - e.L) * w, center.a - e.a, center.b - e.b);
  }

  /**
   * Record a confidently named, seam-verified face. Takes the whole 9-cell
   * reading rather than just the center because the normalization subtracts
   * the face's own median lightness — that is what cancels auto-exposure
   * drift between frames, and it needs all nine.
   */
  observe(face: FaceId, cells: readonly Lab[], rgb?: [number, number, number]): boolean {
    if (cells.length !== 9) return false;
    const center = normalizeFaceCells(cells, NAME_L_WEIGHT)[4]!;
    // Guards (DECISION 2026-09-13, see MAX_OBS_DRIFT): a track keeps its face
    // id while the cube turns, so the reading it hands in can be a different
    // sticker. That reading must not teach this face a new colour.
    const own = this.distance(center, face);
    if (this.isMeasured(face) && own > MAX_OBS_DRIFT) { this.rejected++; this.log('reject', face, own); return false; }
    // Only measured faces can veto: a prior is an estimate, not evidence.
    for (const other of FACE_ORDER) {
      if (other !== face && this.isMeasured(other) && this.distance(center, other) < own) {
        this.rejected++;
        this.log('reject', face, own, other, this.distance(center, other));
        return false;
      }
    }
    this.log('observe', face, own);
    const list = this.obs.get(face) ?? [];
    list.push(center);
    this.prior = null;
    if (list.length > OBS_RESERVOIR) list.shift();
    this.obs.set(face, list);
    if (rgb) {
      const r = this.raw.get(face) ?? [];
      r.push(rgb);
      if (r.length > OBS_RESERVOIR) r.shift();
      this.raw.set(face, r);
    }
    return true;
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

  /** For the debug panel: what each face's exemplar is and how it got there. */
  status(): { face: FaceId; measured: boolean; n: number; lab: Lab }[] {
    return FACE_ORDER.map((f) => ({ face: f, measured: this.isMeasured(f), n: this.obs.get(f)?.length ?? 0, lab: this.get(f) }));
  }

  reset(): void {
    this.obs.clear();
    this.raw.clear();
    this.prior = null;
    this.rejected = 0;
    this.history.length = 0;
  }
}

export interface ExemplarEvent {
  t: number;
  kind: 'observe' | 'reject';
  face: FaceId;
  /** Distance of the reading to this face's exemplar. */
  own: number;
  /** For a reject by the nearest-face guard: the face that was nearer, and how near. */
  other?: FaceId;
  otherD?: number;
}
const EXEMPLAR_LOG = 200;
// L weight against a measured exemplar (see CenterExemplars.distance); the
// clustering space uses the same value for the same reason.
const MEASURED_L_WEIGHT = CLUSTER_L_WEIGHT;

// Prior fit: per-axis chroma ratio bounds, and the ratio assumed when no
// measured face says anything about that axis.
const PRIOR_SCALE_MIN = 0.3;
const PRIOR_SCALE_MAX = 1.0;
const PRIOR_SCALE_ONE_FACE = 0.8;

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[s.length >> 1]!);
}

// A reading further than this from EVERY measured exemplar is not one of the
// colours seen so far (same colour under drift stays within MAX_OBS_DRIFT; a
// different colour is 40-60 away).
const FAR_FROM_MEASURED = 35;

/**
 * Which face a centre reading names, with the margin it names it by.
 *
 * The six colours are mutually exclusive, and measured exemplars are evidence
 * while priors are guesses, so the decision goes in two steps: if the nearest
 * exemplar is measured and clearly nearer than the runner-up, that is it. If
 * the reading is far from every measured colour it must be one of the
 * unmeasured ones, and the priors only have to separate those among
 * themselves - on scan-debug-1789290604959 the real blue sat 47 from the
 * fitted blue prior and 52 from measured white (a 10% margin, refused if the
 * priors competed with the evidence) but 70 from the next unmeasured prior.
 */
export function pickFace(ranked: readonly { f: FaceId; d: number }[], exemplars: CenterExemplars):
    { ok: boolean; best: { f: FaceId; d: number }; second: { f: FaceId; d: number }; nameConf: number } {
  const conf = (a: { d: number }, b: { d: number }) => (b.d > 0 ? Math.max(0, Math.min(1, 1 - a.d / b.d)) : 0);
  const best = ranked[0]!;
  const second = ranked[1] ?? { f: best.f, d: Infinity };
  const overall = conf(best, second);
  if (exemplars.isMeasured(best.f) || ranked.every((r) => !exemplars.isMeasured(r.f))) {
    return { ok: overall >= MIN_NAME_CONF, best, second, nameConf: overall };
  }
  const measured = ranked.filter((r) => exemplars.isMeasured(r.f));
  const priors = ranked.filter((r) => !exemplars.isMeasured(r.f));
  if (measured[0]!.d < FAR_FROM_MEASURED) {
    // near a measured colour but nearer a prior: not decidable
    return { ok: false, best, second, nameConf: overall };
  }
  const p2 = priors[1] ?? { f: priors[0]!.f, d: Infinity };
  const among = conf(priors[0]!, p2);
  return { ok: among >= MIN_NAME_CONF, best: priors[0]!, second: p2, nameConf: among };
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
    // sticker (see colour/patch.ts facePlan).
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
      .map((f) => ({ f, d: exemplars.distance(center, f) }))
      .sort((a, b) => a.d - b.d);
    const cellRgb = samples.map((s) => s.rgb);
    const pick = pickFace(ranked, exemplars);
    const { best, nameConf } = pick;
    if (!pick.ok) {
      out[i] = { face: null, color: null, nameConf, center, rgb: samples[4]!.rgb, minEdgePx: minEdge,
                 cells, cellsNorm, cellRgb, ranked: ranked.map((r) => ({ face: r.f, d: r.d })),
                 reason: `${AMBIGUOUS_REASON} (${colorOf(best.f)} ${best.d.toFixed(0)} vs ${colorOf(pick.second.f)} ${pick.second.d.toFixed(0)})` };
      return;
    }
    // `dbg` is the evidence this decision was made from, carried out verbatim
    // - nothing here is recomputed for the debug view, it is the same arrays
    // and the same `ranked` the winner was picked from.
    const dbg = {
      cells,
      cellsNorm,
      cellRgb,
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

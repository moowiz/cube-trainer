// Anchoring (design 2.2): after the lock the palette is frozen and the
// centres are known, so each visible quad is a FACE plus a quarter-turn
// rotation k of its cells. The face comes from the centre colour when the
// colour can say, else from the pairing geometry with a face that can
// (one centre plus the shared edge fixes the neighbour); k comes from the
// pairings when there are any, else from the first frames of the track
// against the reader's leading state, and is then FROZEN for the track's
// life - a track is the quad at a place, so a face turn shows as its
// content rotating, which only a fixed k can see. Output per frame: for
// every anchored quad its shifted, embedded readings and weights, and the
// TRACK's illumination gain: a face turned away from the light reads at a
// fraction of the palette's chroma (measured 0.4-0.7 on the top face and
// 0.2 on the sides of the dim-room recordings) plus a shift, so each
// track carries an affine chroma map (s, t) estimated under the reader's
// leading state and smoothed over frames. The cost of a hypothesis
// (quadCost) uses that fixed map for every hypothesis alike - a fit per
// hypothesis let skin pass as orange at s = 0.35 and let any hypothesis
// shrink the palette out from under the cells that contradicted it.
//
// Stateful and incremental: the Anchorer keeps per-track memory and a
// trailing pool of readings for the frame's white-balance shift, so the
// same code runs live in the solve worker and offline over a recording.

import { sharedEdge } from '../detect/orient';
import { EMBEDDINGS, type Embedding, type EmbeddingName } from '../colour/colorspace';
import { embedQuadObs } from '../colour/evidence';
import { studentLogLik } from '../colour/palette';
import { dist3, weightedMedian } from '../colour/robust';
import type { Pairing, QuadObs, Solution, Vec3 } from '../colour/types';
import { rotateCells } from '../state';
import type { FaceId } from '../types';
import { FACE_ORDER } from '../types';

/** What the lock fixes for the rest of the solve. */
export interface Commitments {
  /** The locked state (URFDLB facelets). */
  start: string;
  embedding: EmbeddingName;
  /** Six centres in the embedding, and their Student-t scales. */
  palette: { centres: (Vec3 | null)[]; sigma: number[] };
  /** Colour id -> face letter (the face whose centre carries it). */
  colourLetter: (FaceId | null)[];
}

export function commitmentsFrom(sol: Solution): Commitments | null {
  if (!sol.facelets || !sol.lockable) return null;
  return { start: sol.facelets, embedding: sol.embedding as EmbeddingName, palette: { centres: sol.palette.centres, sigma: sol.palette.sigma }, colourLetter: sol.colourLetter };
}

export interface AnchorParams {
  /** Student-t degrees of freedom (the solver's). */
  nu: number;
  /** A single reading is noisier than the aggregates the palette sigmas describe: floor for the per-reading scale, embedding units. */
  sigmaFloor: number;
  /**
   * The outlier class: a reading further than outlierSigmas x sigma from
   * every colour is "not a sticker" (a finger, glare, the seam) and is
   * vetoed - it says nothing about any colour (design 8.1). Applied
   * under each hypothesis AFTER its affine fit, so a dark face's
   * desaturated stickers are not thrown away before the fit can explain
   * them; skin on the synthetic fixture sits 24 units from white, so 3
   * sigma (21) is where it stops voting.
   */
  outlierSigmas: number;
  /** A looser pre-veto before any fit (glare, black plastic): readings past this many sigma from every colour never enter a fit. */
  preVetoSigmas: number;
  /** Per-cell cost cap, nats: a single reading can never be certain. */
  costCap: number;
  /** Cost of a cell the outlier class claims, nats (see patternCost). */
  outlierCost: number;
  /** Centre classification: per-frame decay of the track's accumulated centre vote (0.8 = a window of ~5 samples). */
  centreDecay: number;
  /** ...and the face is only taken from the colour when the winning letter's posterior clears this. */
  centreMin: number;
  /** A track's rotation is frozen after this many frames of fitting against the leader (pairings override it at any time). */
  kFrames: number;
  /**
   * Reading weights are the scan solver's convergence weights (blur, size,
   * view...), 0.02-0.2 per reading on a dim webcam and 0.5-0.9 on the
   * synthetic fixture; the reader's move cost is in nats OF EVIDENCE, so
   * each reading's weight is taken relative to the median per-reading
   * weight seen so far and capped at 1: wRead = min(1, w * wScale / median).
   */
  wScale: number;
  /** Fixed reference instead of the running median (0 = use the median). */
  wRef: number;
  /**
   * The camera's white balance follows the hands into the frame: a
   * chromatic shift of 20+ units between the lock and a mid-solve frame
   * (both kpft8 recordings). Per frame, the translation of the chroma
   * coordinates that best registers the readings of the last
   * shiftWindowMs onto the palette is fitted (robust, with a Gaussian
   * prior of shiftPrior units towards zero) and subtracted.
   */
  shiftWindowMs: number;
  shiftPrior: number;
  /** Largest shift searched, embedding units (0 disables the fit). */
  shiftMax: number;
  /** Per-track affine chroma map: priors on the scale (around 1) and the residual shift (around 0) when estimating it, and the floor of the scale. */
  gainSigma: number;
  gainShiftSigma: number;
  gainMin: number;
  /** An estimate is taken only when at least this many cells, and this share of the cells seen, sit within outlierSigmas of their colour under it. */
  gainMinInliers: number;
  gainMinShare: number;
  /** EMA weight of a new estimate against the track's current map. */
  gainEma: number;
  /**
   * Reliability: the share of a track's cells that its illumination fit
   * under the leader explains, smoothed over frames, scales the track's
   * weights down to this floor - a face the hand covers or the light does
   * not reach (side faces of the dim-room recordings: 2-4 inliers of 9
   * under ANY state) then cannot buy a move on its own.
   */
  reliabilityFloor: number;
  reliabilityEma: number;
}

export const DEFAULT_ANCHOR: AnchorParams = {
  // DECISION: starting points; calibrated on the synthetic solve and the
  // recorded solves (test/moves-replay.test.ts), see the trace they print
  nu: 3,
  sigmaFloor: 7,
  outlierSigmas: 3,
  preVetoSigmas: 8,
  costCap: 6,
  outlierCost: 2,
  centreDecay: 0.8,
  centreMin: 0.6,
  kFrames: 3,
  wScale: 0.5,
  wRef: 0,
  shiftWindowMs: 1000,
  shiftPrior: 20,
  shiftMax: 32,
  gainSigma: 0.35,
  gainShiftSigma: 12,
  gainMin: 0.15,
  gainMinInliers: 5,
  gainMinShare: 0.6,
  gainEma: 0.3,
  reliabilityFloor: 0.3,
  reliabilityEma: 0.25,
};

/** One anchored quad in one frame. */
export interface QuadAnchor {
  track: number;
  /** Face index 0..5 (URFDLB). */
  face: number;
  /** Posterior of that face at the centre (1 when geometry decided). */
  conf: number;
  /** Where the face came from. */
  faceFrom: 'centre' | 'geometry';
  /** Rotations still possible: one entry when known, else all four (min over them in the cost). */
  ks: readonly number[];
  kFrom: 'pairing' | 'fit' | 'free';
  /** Shifted, embedded readings per raw cell (unset where w is 0). */
  x: Vec3[];
  /** Per raw cell: the reading's weight (0 = nothing seen there, or vetoed). */
  w: Float32Array;
  /** Per raw cell: the pre-veto removed it (glare, black plastic). */
  outlier: Uint8Array;
  /** Sum of w over the nine cells. */
  sumW: number;
  /** The track's illumination map (s = chroma scale, t = residual shift) and the palette under it. */
  gain: { s: number; t: [number, number] };
  /** The track's reliability factor folded into w (see AnchorParams.reliabilityFloor). */
  reliability: number;
  palette: (Vec3 | null)[];
  /** costRow[cell * 6 + colour]: the weighted cost of claiming `colour` at raw `cell` (costTable). */
  costRow: Float32Array;
}

export interface FrameObs {
  frame: number;
  t: number;
  quads: QuadAnchor[];
  /** Diagnostics: quads dropped and why. */
  dropped: { track: number; why: string }[];
  /** The chromatic shift subtracted from this frame's readings, and the share of pooled weight within 2 sigma of a colour after it. */
  shift: [number, number];
  shiftInliers: number;
}

/** LAYOUT_OF_RAW[k][raw] = layout cell of raw cell `raw` when layout = rotateCells(raw, k). */
export const LAYOUT_OF_RAW: readonly (readonly number[])[] = [0, 1, 2, 3].map((k) => {
  const rawOfLayout = rotateCells([0, 1, 2, 3, 4, 5, 6, 7, 8], k);
  const out = new Array<number>(9);
  rawOfLayout.forEach((raw, layout) => { out[raw] = layout; });
  return out;
});

interface TrackMem {
  /** Accumulated, decayed centre log-likelihoods (7: six letters + outlier). */
  centre: Float64Array;
  face: number | null;
  faceConf: number;
  faceFrom: 'centre' | 'geometry';
  /** Pairing votes for the rotation. */
  kVotes: [number, number, number, number];
  /** Accumulated fit cost per rotation against the leader, over the first kFrames frames. */
  kFit: [number, number, number, number];
  frames: number;
  k: number | null;
  kFrom: 'pairing' | 'fit' | 'free';
  /** The illumination map, once a fit under the leader has explained the face. */
  gain: { s: number; t: [number, number] } | null;
  gainFits: number;
  /** Smoothed share of cells the fit under the leader explains. */
  reliability: number;
}

/** Palette by letter index, with the outlier density and the reading scale. */
export interface AnchorModel {
  centres: (Vec3 | null)[];
  sigma: number[];
  /** Outlier log-density under a hypothesis (outlierSigmas) and for the pre-veto (preVetoSigmas). */
  llOut: number;
  llPre: number;
  chroma: [number, number];
  P: AnchorParams;
}

export class Anchorer {
  readonly P: AnchorParams;
  readonly model: AnchorModel;
  private readonly embedding: Embedding;
  private readonly tracks = new Map<number, TrackMem>();
  /** Trailing readings for the shift fit. */
  private pool: { x: Vec3; w: number; t: number }[] = [];
  private lastShift: [number, number] = [0, 0];
  private frameNo = 0;
  /** Reservoir of raw reading weights for the running median. */
  private weights: number[] = [];
  private wMed = 0;

  constructor(commit: Commitments, params: Partial<AnchorParams> = {}) {
    this.P = { ...DEFAULT_ANCHOR, ...params };
    this.embedding = EMBEDDINGS[commit.embedding];
    const centres: (Vec3 | null)[] = [null, null, null, null, null, null];
    const sigma = new Array<number>(6).fill(this.P.sigmaFloor);
    commit.colourLetter.forEach((letter, c) => {
      if (!letter) return;
      const li = FACE_ORDER.indexOf(letter);
      centres[li] = commit.palette.centres[c] ?? null;
      sigma[li] = Math.max(this.P.sigmaFloor, commit.palette.sigma[c] ?? this.P.sigmaFloor);
    });
    const sigmaMed = sigma.slice().sort((a, b) => a - b)[3]!;
    this.model = { centres, sigma, llOut: studentLogLik(this.P.outlierSigmas * sigmaMed, sigmaMed, this.P.nu), llPre: studentLogLik(this.P.preVetoSigmas * sigmaMed, sigmaMed, this.P.nu), chroma: this.embedding.chroma, P: this.P };
  }

  /** The current per-track memory, for the debug panel. */
  trackInfo(track: number): { face: string; k: string; gain: string } | null {
    const m = this.tracks.get(track);
    if (!m) return null;
    return { face: m.face === null ? '?' : `${FACE_ORDER[m.face]} (${m.faceFrom} ${(m.faceConf * 100).toFixed(0)}%)`, k: m.k === null ? '?' : `${m.k} (${m.kFrom})`, gain: `${m.gain ? `s ${m.gain.s.toFixed(2)} t (${m.gain.t[0].toFixed(0)}, ${m.gain.t[1].toFixed(0)}) from ${m.gainFits} fits` : 'none yet'}, reliability ${(m.reliability * 100).toFixed(0)}%` };
  }

  private wOf(w: number): number {
    return Math.min(1, (w * this.P.wScale) / Math.max(1e-6, this.wMed));
  }

  /**
   * Anchor one frame's quads. `leader` is the reader's best state before
   * this frame (null before the first) - used only to seed the rotation of
   * a track that no pairing has fixed.
   */
  anchor(frame: number, t: number, quads: readonly QuadObs[], pairings: readonly Pairing[], leader: Uint8Array | null): FrameObs {
    const P = this.P;
    const M = this.model;
    const [c0, c1] = M.chroma;
    this.frameNo++;
    // running weight reference
    for (const q of quads) for (const r of q.readings) if (r.w > 0) this.weights.push(r.w);
    if (this.weights.length > 4000) this.weights = this.weights.slice(-2000);
    if (P.wRef > 0) this.wMed = P.wRef;
    else if (this.weights.length) { const s = this.weights.slice().sort((a, b) => a - b); this.wMed = s[s.length >> 1]!; }

    // 1. embed, pool, fit the frame's shift
    const raw = new Map<QuadObs, Vec3[]>();
    for (const q of quads) {
      const xs = embedQuadObs(q, this.embedding, undefined);
      raw.set(q, xs);
      q.readings.forEach((r, i) => { const w = this.wOf(r.w); if (w > 0) this.pool.push({ x: xs[i]!, w, t }); });
    }
    while (this.pool.length && this.pool[0]!.t < t - P.shiftWindowMs) this.pool.shift();
    const sh = fitShift(this.pool, M.centres, M.sigma, M.chroma, P, this.lastShift, this.frameNo % 10 === 1);
    this.lastShift = sh.s;
    const shifted = (x: Vec3): Vec3 => { const y: Vec3 = [x[0], x[1], x[2]]; y[c0] -= sh.s[0]; y[c1] -= sh.s[1]; return y; };

    // 2. per track: centre vote, face from colour
    const dropped: FrameObs['dropped'] = [];
    const seen = new Map<number, { q: QuadObs; xs: Vec3[]; mem: TrackMem }>();
    for (const q of quads) {
      let mem = this.tracks.get(q.track);
      if (!mem) this.tracks.set(q.track, (mem = { centre: new Float64Array(7), face: null, faceConf: 0, faceFrom: 'centre', kVotes: [0, 0, 0, 0], kFit: [0, 0, 0, 0], frames: 0, k: null, kFrom: 'free', gain: null, gainFits: 0, reliability: 1 }));
      mem.frames++;
      const xs = raw.get(q)!.map(shifted);
      seen.set(q.track, { q, xs, mem });
      const ri = q.readings.findIndex((r) => r.cell === 4);
      for (let c = 0; c < 7; c++) mem.centre[c] *= P.centreDecay;
      if (ri >= 0) {
        const w = this.wOf(q.readings[ri]!.w);
        if (w > 0) { const ll = classify(xs[ri]!, M); for (let c = 0; c < 7; c++) mem.centre[c] += w * ll[c]!; }
      }
      let best = 0;
      for (let c = 1; c < 7; c++) if (mem.centre[c]! > mem.centre[best]!) best = c;
      const m = mem.centre[best]!;
      if (m !== 0 && Number.isFinite(m)) {
        let Z = 0;
        for (let c = 0; c < 7; c++) Z += Math.exp(mem.centre[c]! - m);
        const conf = 1 / Z;
        if (best !== 6 && conf >= P.centreMin) { mem.face = best; mem.faceConf = conf; mem.faceFrom = 'centre'; }
        else if (mem.faceFrom === 'centre') { mem.face = null; mem.faceConf = conf; }
      }
    }

    // 3. geometry: letters and rotations through this frame's pairings.
    //    raw edge e on layout edge ia means layout = rotateCells(raw, ia - e)
    //    (naming.ts convention). Two passes so a letter found in the first
    //    can pin a rotation in the second.
    const pairs = pairings.filter((p) => seen.has(p.a) && seen.has(p.b));
    for (let pass = 0; pass < 2; pass++) {
      for (const p of pairs) {
        const A = seen.get(p.a)!.mem;
        const B = seen.get(p.b)!.mem;
        if (A.face !== null && B.face !== null) {
          const se = sharedEdge(FACE_ORDER[A.face]!, FACE_ORDER[B.face]!);
          if (!se) { if (pass === 0) dropped.push({ track: p.a, why: `paired with #${p.b} but ${FACE_ORDER[A.face]}/${FACE_ORDER[B.face]} are not adjacent` }); continue; }
          if (pass === 0) {
            A.kVotes[((se.ia - p.edgeA) % 4 + 4) % 4]++;
            B.kVotes[((se.jb - p.edgeB) % 4 + 4) % 4]++;
          }
          continue;
        }
        // one letter known: the other follows from that track's rotation
        const known = A.face !== null ? 'a' : B.face !== null ? 'b' : null;
        if (!known) continue;
        const K = known === 'a' ? A : B;
        const U = known === 'a' ? B : A;
        const eK = known === 'a' ? p.edgeA : p.edgeB;
        const eU = known === 'a' ? p.edgeB : p.edgeA;
        if (K.k === null) continue;
        for (let lb = 0; lb < 6; lb++) {
          const se = known === 'a' ? sharedEdge(FACE_ORDER[K.face!]!, FACE_ORDER[lb]!) : sharedEdge(FACE_ORDER[lb]!, FACE_ORDER[K.face!]!);
          if (!se) continue;
          const kK = known === 'a' ? ((se.ia - eK) % 4 + 4) % 4 : ((se.jb - eK) % 4 + 4) % 4;
          if (kK !== K.k) continue;
          U.face = lb;
          U.faceConf = 1;
          U.faceFrom = 'geometry';
          U.kVotes[known === 'a' ? ((se.jb - eU) % 4 + 4) % 4 : ((se.ia - eU) % 4 + 4) % 4]++;
          break;
        }
      }
    }

    // 4. rotations: pairing votes first; else the fit against the leader
    //    over the track's first frames, then frozen
    for (const { q, xs, mem } of seen.values()) {
      const top = Math.max(...mem.kVotes);
      if (top > 0) {
        const k = mem.kVotes.indexOf(top);
        // a change of the pairing majority is a re-anchoring (the cube was turned in hand under a surviving track)
        if (mem.kFrom !== 'pairing' || mem.k === null || (mem.k !== k && top >= mem.kVotes[mem.k]! + 2)) { mem.k = k; mem.kFrom = 'pairing'; }
        continue;
      }
      if (mem.k !== null || mem.face === null || !leader) continue;
      if (mem.frames <= P.kFrames) {
        // free fit per rotation: the gain is unknown yet, so each
        // rotation is judged with its own best map
        const probe = this.makeAnchor(q, xs, mem, [0, 1, 2, 3], 'free');
        for (let k = 0; k < 4; k++) mem.kFit[k] += fitPattern(probe, patternOf(leader, probe, k), M).cost;
        if (mem.frames === P.kFrames) {
          const mn = Math.min(...mem.kFit);
          mem.k = mem.kFit.indexOf(mn);
          mem.kFrom = 'fit';
        }
      }
    }

    // 4b. illumination: the free affine fit under the leader's colours,
    //     taken when it explains most of the face, smoothed over frames
    if (leader) {
      for (const { q, xs, mem } of seen.values()) {
        if (mem.face === null || mem.k === null) continue;
        const probe = this.makeAnchor(q, xs, mem, [mem.k], mem.kFrom);
        const fit = fitPattern(probe, patternOf(leader, probe, mem.k), M);
        let seenCells = 0;
        let inliers = 0;
        fit.cells.forEach((c, cell) => { if (c.w > 0) { seenCells++; if (!c.vetoed && c.d < P.outlierSigmas * M.sigma[patternOf(leader, probe, mem.k!)[cell]!]!) inliers++; } });
        if (seenCells > 0) mem.reliability = (1 - P.reliabilityEma) * mem.reliability + P.reliabilityEma * (inliers / seenCells);
        if (inliers < P.gainMinInliers || inliers < P.gainMinShare * seenCells) continue;
        if (!mem.gain) mem.gain = { s: fit.s, t: [fit.t[0], fit.t[1]] };
        else {
          const a = P.gainEma;
          mem.gain = { s: (1 - a) * mem.gain.s + a * fit.s, t: [(1 - a) * mem.gain.t[0] + a * fit.t[0], (1 - a) * mem.gain.t[1] + a * fit.t[1]] };
        }
        mem.gainFits++;
      }
    }

    // 5. build the anchors: one quad per face per frame
    const anchored: QuadAnchor[] = [];
    for (const { q, xs, mem } of seen.values()) {
      if (mem.face === null) {
        let best = 0;
        for (let c = 1; c < 7; c++) if (mem.centre[c]! > mem.centre[best]!) best = c;
        dropped.push({ track: q.track, why: best === 6 ? `centre is no sticker (${(mem.faceConf * 100).toFixed(0)}%)` : mem.faceConf > 0 ? `centre ${FACE_ORDER[best]} only ${(mem.faceConf * 100).toFixed(0)}%` : 'no centre reading' });
        continue;
      }
      anchored.push(this.makeAnchor(q, xs, mem, mem.k === null ? [0, 1, 2, 3] : [mem.k], mem.kFrom));
    }
    const byFace = new Map<number, QuadAnchor>();
    for (const a of anchored) {
      const other = byFace.get(a.face);
      if (!other) { byFace.set(a.face, a); continue; }
      const keep = a.conf * a.sumW > other.conf * other.sumW ? a : other;
      const drop = keep === a ? other : a;
      dropped.push({ track: drop.track, why: `second ${FACE_ORDER[a.face]} quad (kept #${keep.track})` });
      byFace.set(a.face, keep);
    }
    return { frame, t, quads: [...byFace.values()], dropped, shift: sh.s, shiftInliers: sh.inliers };
  }

  private makeAnchor(q: QuadObs, xs: Vec3[], mem: TrackMem, ks: readonly number[], kFrom: QuadAnchor['kFrom']): QuadAnchor {
    const M = this.model;
    const x: Vec3[] = new Array<Vec3>(9);
    const w = new Float32Array(9);
    const outlier = new Uint8Array(9);
    let sumW = 0;
    const rel = Math.max(this.P.reliabilityFloor, mem.reliability);
    q.readings.forEach((r, i) => {
      const rw = this.wOf(r.w) * rel;
      if (rw <= 0) return;
      // the pre-veto: a reading no colour could claim under any gain
      // (glare, black plastic) never enters a fit; fingers are caught
      // under the hypothesis, after the fit (patternCost)
      const ll = classify(xs[i]!, M);
      let best = -Infinity;
      for (let c = 0; c < 6; c++) if (ll[c]! > best) best = ll[c]!;
      x[r.cell] = xs[i]!;
      if (best < M.llPre) { outlier[r.cell] = 1; return; }
      w[r.cell] = rw;
      sumW += rw;
    });
    const gain = mem.gain ?? { s: 1, t: [0, 0] as [number, number] };
    const [c0, c1] = M.chroma;
    const palette = M.centres.map((p) => {
      if (!p) return null;
      const y: Vec3 = [p[0], p[1], p[2]];
      y[c0] = gain.s * p[c0] + gain.t[0];
      y[c1] = gain.s * p[c1] + gain.t[1];
      return y;
    });
    return { track: q.track, face: mem.face!, conf: mem.faceConf, faceFrom: mem.faceFrom, ks, kFrom, x, w, outlier, sumW, gain, reliability: rel, palette, costRow: costTable({ x, w, palette }, M) };
  }
}

/** Per letter index (URFDLB): log-likelihood at x; index 6 = the outlier class. */
function classify(x: Vec3, M: AnchorModel): Float64Array {
  const ll = new Float64Array(7);
  for (let c = 0; c < 6; c++) {
    const p = M.centres[c];
    ll[c] = p ? studentLogLik(dist3(x, p), M.sigma[c]!, M.P.nu) : -Infinity;
  }
  ll[6] = M.llOut;
  return ll;
}

/**
 * The chroma translation that registers a pool of readings onto the
 * palette: a grid over +-shiftMax (or, between full searches, +-8 around
 * the previous shift) maximising the weighted sum of each reading's best
 * Gaussian kernel (a robust score: fingers and glare are simply far from
 * every colour) minus a Gaussian prior, then two rounds of weighted-median
 * refinement over the readings within 2 sigma of a colour. A single-colour
 * view is ambiguous between colours (white shifted vs yellow shifted): the
 * prior and the pooling window settle it.
 */
export function fitShift(pts: readonly { x: Vec3; w: number }[], centres: readonly (Vec3 | null)[], sigma: readonly number[], chroma: [number, number], P: Pick<AnchorParams, 'shiftMax' | 'shiftPrior'>, from: [number, number] = [0, 0], full = true): { s: [number, number]; inliers: number } {
  const [c0, c1] = chroma;
  const total = pts.reduce((a, p) => a + p.w, 0);
  if (P.shiftMax <= 0 || total <= 0) return { s: [0, 0], inliers: 0 };
  const cs = centres.map((c, i) => (c ? { c, sig: sigma[i]! } : null)).filter((x): x is { c: Vec3; sig: number } => x !== null);
  const nearest = (x: Vec3, s0: number, s1: number): { d: number; c: Vec3; sig: number } => {
    const y: Vec3 = [x[0], x[1], x[2]];
    y[c0] -= s0;
    y[c1] -= s1;
    let best = { d: Infinity, c: cs[0]!.c, sig: cs[0]!.sig };
    for (const e of cs) {
      const d = dist3(y, e.c);
      if (d < best.d) best = { d, c: e.c, sig: e.sig };
    }
    return best;
  };
  const score = (s0: number, s1: number): number => {
    let sc = 0;
    for (const p of pts) {
      const n = nearest(p.x, s0, s1);
      sc += p.w * Math.exp(-(n.d * n.d) / (2 * n.sig * n.sig));
    }
    return sc - (0.5 * total * (s0 * s0 + s1 * s1)) / (P.shiftPrior * P.shiftPrior);
  };
  const STEP = 4;
  let best: [number, number] = from;
  let bestScore = score(from[0], from[1]);
  const R = full ? P.shiftMax : 8;
  const ca = full ? 0 : from[0];
  const cb = full ? 0 : from[1];
  for (let a = ca - R; a <= ca + R; a += STEP) {
    for (let b = cb - R; b <= cb + R; b += STEP) {
      if (Math.abs(a) > P.shiftMax || Math.abs(b) > P.shiftMax) continue;
      const sc = score(a, b);
      if (sc > bestScore) { bestScore = sc; best = [a, b]; }
    }
  }
  // refine: weighted median of the residuals of the readings near a colour
  let inliers = 0;
  for (let round = 0; round < 2; round++) {
    const r0: number[] = [];
    const r1: number[] = [];
    const ws: number[] = [];
    inliers = 0;
    for (const p of pts) {
      const n = nearest(p.x, best[0], best[1]);
      if (n.d > 2 * n.sig) continue;
      inliers += p.w;
      r0.push(p.x[c0] - n.c[c0]);
      r1.push(p.x[c1] - n.c[c1]);
      ws.push(p.w);
    }
    if (inliers < 0.2 * total) break;
    best = [weightedMedian(r0, ws), weightedMedian(r1, ws)];
    const m = Math.hypot(best[0], best[1]);
    if (m > P.shiftMax) best = [(best[0] * P.shiftMax) / m, (best[1] * P.shiftMax) / m];
  }
  return { s: best, inliers: inliers / total };
}

export interface PatternFit {
  s: number;
  t: [number, number];
  cost: number;
  /** Per raw cell: weight, distance to the hypothesised colour after the fit, cost, whether the outlier class won. */
  cells: { w: number; d: number; cost: number; vetoed: boolean }[];
}

/**
 * One anchored quad under the nine colours a hypothesis puts on it
 * (letter index per RAW cell): fit the affine chroma map x = s p + t from
 * the palette centres p to the readings x under Gaussian priors on s
 * (around 1) and t (around 0), robustly (cells past outlierSigmas of
 * their colour drop out of the later rounds), then the per-cell softmax
 * cost of the hypothesised colour against the transformed palette,
 * capped, weighted, plus the prior cost of the fit itself.
 */
export function fitPattern(q: QuadAnchor, colours: readonly number[], M: AnchorModel): PatternFit {
  const P = M.P;
  const [c0, c1] = M.chroma;
  let s = 1;
  let t0 = 0;
  let t1 = 0;
  const invT = 1 / (P.gainShiftSigma * P.gainShiftSigma);
  const invS = 1 / (P.gainSigma * P.gainSigma);
  const use = new Uint8Array(9).fill(1);
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      for (let cell = 0; cell < 9; cell++) {
        const w = q.w[cell]!;
        if (w === 0) continue;
        const c = colours[cell]!;
        const p = M.centres[c];
        if (!p) { use[cell] = 0; continue; }
        const d = Math.hypot(q.x[cell]![c0] - (s * p[c0] + t0), q.x[cell]![c1] - (s * p[c1] + t1));
        use[cell] = d < P.outlierSigmas * M.sigma[c]! ? 1 : 0;
      }
    }
    let n0 = 0, n1 = 0, den = invT;
    for (let cell = 0; cell < 9; cell++) {
      const w = q.w[cell]!;
      if (w === 0 || !use[cell]) continue;
      const c = colours[cell]!;
      const p = M.centres[c];
      if (!p) continue;
      const iv = w / (M.sigma[c]! * M.sigma[c]!);
      n0 += iv * (q.x[cell]![c0] - s * p[c0]);
      n1 += iv * (q.x[cell]![c1] - s * p[c1]);
      den += iv;
    }
    t0 = n0 / den;
    t1 = n1 / den;
    let num = invS, dn = invS;
    for (let cell = 0; cell < 9; cell++) {
      const w = q.w[cell]!;
      if (w === 0 || !use[cell]) continue;
      const c = colours[cell]!;
      const p = M.centres[c];
      if (!p) continue;
      const iv = w / (M.sigma[c]! * M.sigma[c]!);
      num += iv * (p[c0] * (q.x[cell]![c0] - t0) + p[c1] * (q.x[cell]![c1] - t1));
      dn += iv * (p[c0] * p[c0] + p[c1] * p[c1]);
    }
    s = Math.max(P.gainMin, Math.min(1.3, num / dn));
  }
  const tp: (Vec3 | null)[] = M.centres.map((p) => {
    if (!p) return null;
    const y: Vec3 = [p[0], p[1], p[2]];
    y[c0] = s * p[c0] + t0;
    y[c1] = s * p[c1] + t1;
    return y;
  });
  let cost = 0.5 * invS * (s - 1) * (s - 1) + 0.5 * invT * (t0 * t0 + t1 * t1);
  const cells: PatternFit['cells'] = [];
  const ll = new Float64Array(7);
  for (let cell = 0; cell < 9; cell++) {
    const w = q.w[cell]!;
    if (w === 0) { cells.push({ w: 0, d: NaN, cost: 0, vetoed: false }); continue; }
    const x = q.x[cell]!;
    let mx = M.llOut;
    let dh = NaN;
    for (let c = 0; c < 6; c++) {
      const p = tp[c];
      const d = p ? dist3(x, p) : Infinity;
      if (c === colours[cell]) dh = d;
      ll[c] = p ? studentLogLik(d, M.sigma[c]!, P.nu) : -Infinity;
      if (ll[c]! > mx) mx = ll[c]!;
    }
    ll[6] = M.llOut;
    let z = 0;
    for (let c = 0; c < 7; c++) if (ll[c]! !== -Infinity) z += Math.exp(ll[c]! - mx);
    const logZ = mx + Math.log(z);
    // the veto: when the outlier class wins (a finger, a smear, or a
    // palette this hypothesis has shrunk away from the readings) the cell
    // costs at most outlierCost whatever colour is claimed - flat across
    // hypotheses, so a finger votes for nothing, but never free, so a
    // hypothesis cannot explain away contradicting cells by fitting the
    // palette out from under them
    const vetoed = mx === M.llOut;
    const cc = w * Math.min(vetoed ? P.outlierCost : P.costCap, -(ll[colours[cell]!]! - logZ));
    cost += cc;
    cells.push({ w, d: dh, cost: cc, vetoed });
  }
  return { s, t: [t0, t1], cost, cells };
}

/**
 * Cost of one anchored quad under the nine colours a hypothesis puts on
 * it (letter index per RAW cell), against the palette under the TRACK's
 * illumination map: per cell the softmax cost of the hypothesised colour
 * over the six colours and the outlier class, capped, weighted. The veto:
 * when the outlier class wins (a finger, a smear) the cell costs at most
 * outlierCost whatever colour is claimed - flat across hypotheses, so a
 * finger votes for nothing.
 */
export function patternCost(q: QuadAnchor, colours: readonly number[]): number {
  let cost = 0;
  for (let cell = 0; cell < 9; cell++) cost += q.costRow[cell * 6 + colours[cell]!]!;
  return cost;
}

/** The per-cell cost table of a quad (see patternCost): costRow[cell * 6 + colour], weights folded in. */
export function costTable(q: Pick<QuadAnchor, 'x' | 'w' | 'palette'>, M: AnchorModel): Float32Array {
  const P = M.P;
  const row = new Float32Array(54);
  const ll = new Float64Array(7);
  for (let cell = 0; cell < 9; cell++) {
    const w = q.w[cell]!;
    if (w === 0) continue;
    const x = q.x[cell]!;
    let mx = M.llOut;
    for (let c = 0; c < 6; c++) {
      const p = q.palette[c];
      ll[c] = p ? studentLogLik(dist3(x, p), M.sigma[c]!, P.nu) : -Infinity;
      if (ll[c]! > mx) mx = ll[c]!;
    }
    ll[6] = M.llOut;
    let z = 0;
    for (let c = 0; c < 7; c++) if (ll[c]! !== -Infinity) z += Math.exp(ll[c]! - mx);
    const logZ = mx + Math.log(z);
    const cap = mx === M.llOut ? P.outlierCost : P.costCap;
    for (let c = 0; c < 6; c++) row[cell * 6 + c] = w * Math.min(cap, -(ll[c]! - logZ));
  }
  return row;
}

/** The nine colours (letter index per RAW cell) a state puts on a quad at rotation k. */
export function patternOf(state: Uint8Array, q: QuadAnchor, k: number): number[] {
  const lay = LAYOUT_OF_RAW[k]!;
  const base = q.face * 9;
  const out = new Array<number>(9);
  for (let raw = 0; raw < 9; raw++) out[raw] = state[base + lay[raw]!]!;
  return out;
}

/** Cost of a state (letter indices per slot) under one anchored quad at rotation k. */
export function hypothesisCost(state: Uint8Array, q: QuadAnchor, k: number): number {
  const lay = LAYOUT_OF_RAW[k]!;
  const base = q.face * 9;
  let cost = 0;
  for (let raw = 0; raw < 9; raw++) cost += q.costRow[raw * 6 + state[base + lay[raw]!]!]!;
  return cost;
}

/** The cost of a state under one anchored quad: min over its rotations. */
export function quadCost(state: Uint8Array, q: QuadAnchor): { cost: number; k: number } {
  let best = Infinity;
  let bestK = q.ks[0]!;
  for (const k of q.ks) {
    const cost = hypothesisCost(state, q, k);
    if (cost < best) { best = cost; bestK = k; }
  }
  return { cost: best, k: bestK };
}

export function frameCost(state: Uint8Array, f: FrameObs): number {
  let s = 0;
  for (const q of f.quads) s += quadCost(state, q).cost;
  return s;
}

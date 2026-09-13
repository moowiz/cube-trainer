// Readings, their quality weights, the evidence log, and the per-track
// aggregation (design 3.2, 3.5). Nothing here decides a colour: a reading is
// a measurement with a weight, a track is nine robust centres with an
// effective sample size. Every number in `qualityWeight` is a WEIGHT - being
// off by 2x changes how fast a sticker converges, never what it converges
// to. If a change here can flip a decision on its own it belongs elsewhere.

import { minFaceEdgePx } from '../color';
import { rotateCells } from '../state';
import type { Lab } from '../types';
import type { Embedding } from './colorspace';
import { robustCentre, weightedMedian } from './robust';
import type { Aggregate, EvidenceLog, PatchStats, QuadObs, Reading, TrackSignature, Vec3 } from './types';

/** Linear ramp from (x0 -> y0) to (x1 -> y1), clamped. */
function ramp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

export interface QuadQuality {
  conf: number;
  blur: number;
  viewCos: number;
  edgePx: number;
  speed: number;
  nth: number;
  /** Source frame height, for the size floor. */
  frameH: number;
}

/** The quad-level factors (shared by the nine cells). */
export function quadWeight(q: QuadQuality): number {
  // DECISION: starting shapes from design 3.2, to be re-calibrated by replay
  // for convergence speed. None is a hard zero except the size floor, which
  // facePlan already enforces upstream.
  const sharp = ramp(q.blur, 15, 40, 0.1, 1);
  const still = ramp(q.speed, 0, 3, 1, 0.2);
  const view = ramp(q.viewCos, 0.4, 0.8, 0.3, 1);
  const size = ramp(q.edgePx / Math.max(1, minFaceEdgePx(q.frameH)), 1, 2, 0.3, 1);
  const age = q.nth <= 1 ? 0.3 : q.nth === 2 ? 0.6 : 1;
  return q.conf * sharp * still * view * size * age;
}

/** The cell-level factors, from the patch's own statistics. */
export function patchWeight(p: PatchStats): number {
  // glare is the one hard zero: a patch more than 60% clipped has no pigment
  const glare = p.clipFrac > 0.6 ? 0 : 1 - p.clipFrac;
  const seam = Math.max(0.1, 1 - 2 * p.darkFrac);
  const flat = Math.exp(-p.spread / 8);
  // a censored channel is a bound, not a value; MEASURED: every orange
  // reading on the phone has R at 255, so this must stay a mild discount
  const censored = p.censored.reduce((w, c) => (c ? w * 0.8 : w), 1);
  return glare * seam * flat * censored;
}

export function makeReading(cell: number, p: PatchStats, quadW: number): Reading {
  return {
    cell,
    rgb: p.rgb,
    lab: p.lab,
    clipFrac: p.clipFrac,
    darkFrac: p.darkFrac,
    spread: p.spread,
    censored: p.censored,
    w: quadW * patchWeight(p),
  };
}

export function emptyLog(): EvidenceLog {
  return { quads: [], pairings: [], events: [], frames: 0 };
}

// DECISION: the log is capped so a long session stays a bounded solve. At
// ~2 detection ticks/s and up to 3 quads each, 1500 quads is 4+ minutes of
// scanning; the oldest quads (and the pairings/events of frames that no
// longer have quads) drop first.
export const LOG_MAX_QUADS = 1500;

export function trimLog(log: EvidenceLog): { quads: number; pairings: number; events: number } {
  if (log.quads.length <= LOG_MAX_QUADS) return { quads: 0, pairings: 0, events: 0 };
  const drop = log.quads.length - LOG_MAX_QUADS;
  const oldest = log.quads[drop]!.frame;
  log.quads.splice(0, drop);
  const np = log.pairings.length;
  const ne = log.events.length;
  log.pairings = log.pairings.filter((p) => p.frame >= oldest);
  log.events = log.events.filter((e) => e.frame >= oldest);
  return { quads: drop, pairings: np - log.pairings.length, events: ne - log.events.length };
}

/** Frames each track appears in, and which tracks share a frame. */
export function trackFrames(log: EvidenceLog): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const q of log.quads) {
    let f = out.get(q.track);
    if (!f) out.set(q.track, (f = []));
    if (f[f.length - 1] !== q.frame) f.push(q.frame);
  }
  return out;
}

function quadCentroid(c: readonly (readonly [number, number])[]): [number, number] {
  return [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
}

function quadSize(c: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += c[i]![0] * c[(i + 1) % 4]![1] - c[(i + 1) % 4]![0] * c[i]![1];
  return Math.sqrt(Math.abs(s / 2));
}

/**
 * "a,b" (a < b) for every pair of tracks that appeared in the same frame
 * as two DIFFERENT quads. Two quads whose centroids sit within half a face
 * of each other are the same face twice - a coasted stale track beside its
 * replacement, or a doubled detection - and say nothing about identity;
 * counting them as co-visible split one orange face into two groups for a
 * whole session (scan-debug-1789321540510).
 */
export function coVisible(log: EvidenceLog): Set<string> {
  const byFrame = new Map<number, QuadObs[]>();
  for (const q of log.quads) {
    let t = byFrame.get(q.frame);
    if (!t) byFrame.set(q.frame, (t = []));
    if (!t.some((x) => x.track === q.track)) t.push(q);
  }
  const out = new Set<string>();
  for (const quads of byFrame.values()) {
    for (let i = 0; i < quads.length; i++) {
      for (let j = i + 1; j < quads.length; j++) {
        const A = quads[i]!;
        const B = quads[j]!;
        const [ax, ay] = quadCentroid(A.corners);
        const [bx, by] = quadCentroid(B.corners);
        if (Math.hypot(ax - bx, ay - by) < 0.5 * Math.min(quadSize(A.corners), quadSize(B.corners))) continue;
        out.add(pairKey(A.track, B.track));
      }
    }
  }
  return out;
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

/** Embed one quad's readings and apply the frame's chromatic gain (subtracted). */
export function embedQuadObs(q: QuadObs, embedding: Embedding, gain: [number, number] | undefined): Vec3[] {
  const rgb = q.readings.map((r) => r.rgb);
  const lab = q.readings.map((r) => r.lab);
  const xs = embedding.embedQuad(rgb, lab);
  if (gain) {
    const [c0, c1] = embedding.chroma;
    for (const x of xs) { x[c0] -= gain[0]; x[c1] -= gain[1]; }
  }
  return xs;
}

const EMPTY: Aggregate = { value: null, lab: null, nEff: 0, spread: 0 };

/**
 * Per (track, cell): the robust centre of every reading of that cell over
 * the track's life. Iterative reweighting is the temporal robustness: a
 * finger that passes over a sticker, a glare flash, a motion smear are
 * minority readings far from the running centre and end up with near-zero
 * weight without anyone naming them.
 */
export function aggregateTracks(
  log: EvidenceLog,
  embedding: Embedding,
  gains: ReadonlyMap<number, [number, number]>,
  nSat: number,
): TrackSignature[] {
  const byTrack = new Map<number, QuadObs[]>();
  for (const q of log.quads) {
    let arr = byTrack.get(q.track);
    if (!arr) byTrack.set(q.track, (arr = []));
    arr.push(q);
  }
  const out: TrackSignature[] = [];
  for (const [track, quads] of byTrack) {
    const pts: Vec3[][] = Array.from({ length: 9 }, () => []);
    const ws: number[][] = Array.from({ length: 9 }, () => []);
    const labs: Lab[][] = Array.from({ length: 9 }, () => []);
    const frames: number[] = [];
    for (const q of quads) {
      if (frames[frames.length - 1] !== q.frame) frames.push(q.frame);
      const xs = embedQuadObs(q, embedding, gains.get(q.frame));
      q.readings.forEach((r, i) => {
        if (r.w <= 0) return;
        pts[r.cell]!.push(xs[i]!);
        ws[r.cell]!.push(r.w);
        labs[r.cell]!.push(r.lab);
      });
    }
    const cells: Aggregate[] = [];
    let total = 0;
    for (let k = 0; k < 9; k++) {
      if (!pts[k]!.length) { cells.push(EMPTY); continue; }
      const rc = robustCentre(pts[k]!, ws[k]!);
      const sum = rc.weights.reduce((s, w) => s + w, 0);
      const nEff = Math.min(sum, nSat);
      const lab: Lab = {
        L: weightedMedian(labs[k]!.map((c) => c.L), rc.weights),
        a: weightedMedian(labs[k]!.map((c) => c.a), rc.weights),
        b: weightedMedian(labs[k]!.map((c) => c.b), rc.weights),
      };
      cells.push({ value: rc.value, lab, nEff, spread: rc.spread });
      total += nEff;
    }
    out.push({ track, cells, frames, nEff: total });
  }
  return out;
}

/** A signature's cells re-ordered by k quarter turns (rotateCells semantics). */
export function rotateAggregates(cells: readonly Aggregate[], k: number): Aggregate[] {
  return rotateCells(cells, k);
}

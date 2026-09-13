// Any-order state assembly (M7): per-sticker voting across frames.
//
// The detector/tracker stack turns frames into per-face 9-cell Lab
// observations (in the face's resolved sticker-layout order), each tagged
// with the session colour CLUSTER its centre belongs to (detect/colorid.ts)
// - not a face letter. This module keeps a reservoir of whole-frame
// observations per cluster and, once every face has enough evidence and a
// letter, builds each face's CONSENSUS: the per-cell Lab median of the
// frames, after every frame has been re-aligned to that median by whichever
// of the four in-plane rotations fits it best, and after frames that fit no
// rotation have been dropped. The result goes to M1's proven assembleState
// (center-seeded k-means + cubejs facelet mapping), then resolveByPieces,
// then validateState. Never trust a single frame (CLAUDE.md): a state only
// locks when sampling converged AND cubejs accepts it.
//
// DECISION 2026-09-13: frames, not cells, are the unit of evidence. The
// previous voter keyed samples by (cluster, cell index) AFTER the frame's
// rotation was applied, so a face whose rotation was resolved differently in
// some frames (a track re-created with a new cyclic corner order, one bad
// shared-edge match) mixed samples of different stickers in one reservoir;
// the median of a white/red mix is neither, and the lock failed with "U
// appears 8 times" on every phone session (scan-debug-1789309733443). A
// face's stickers are only ever compared up to rotation here; the claimed
// rotation of the majority of frames fixes the absolute one.
//
// Keying by cluster rather than letter is what lets a cluster be renamed (a
// lone warm cluster resolving to red or orange late in the session) without
// throwing away or mislabelling the votes already cast; several clusters
// may map to one face (a colour split by lighting) and their frames merge.
//
// M8 glare rule lives here too: samples that are blown out (very high L,
// near-zero chroma) carry no pigment information and are dropped before
// they can dilute the vote.

import { labMedian, labDistance } from './color';
import { assembleState, normalizeFaceCells, resolveByPieces, validateState, type AssembledState, type FaceCapture } from './state';
import { FACE_ORDER } from './types';
import type { FaceId, Lab } from './types';

export interface FaceObservation {
  /** Session colour cluster id of this face's centre (detect/colorid.ts). */
  cluster: number;
  /** 9 Lab cells, row-major in the face's sticker-layout orientation. */
  cells: Lab[];
  /** Detector confidence for this face in this frame, [0,1]. */
  conf: number;
}

/** Per-face evidence summary of the last lock attempt (debug). */
export interface FaceEvidence {
  face: FaceId;
  clusters: number[];
  frames: number;
  /** frames that fit the consensus at some rotation */
  inliers: number;
  /** how many inlier frames were re-aligned by 1/2/3 quarter turns (index 0 = as claimed) */
  rotations: [number, number, number, number];
  /** mean aligned distance of the inliers to the consensus (normalized space) */
  fit: number;
  /** raw Lab median per cell of the aligned inliers */
  cells: Lab[];
}

/** What the last tryLock saw: the 54 medians, the assembled state, and why it failed (debug). */
export interface LockAttempt {
  evidence: FaceEvidence[];
  assembled: AssembledState | null;
  error: string | null;
}

export interface AssemblyProgress {
  /** 0..1 per face: how close its cells are to having enough samples (unbound clusters do not show). */
  faceFill: Record<FaceId, number>;
  /** Fill of clusters that have no letter yet, by cluster id. */
  unboundFill: Record<number, number>;
  framesSeen: number;
  /** Set once a valid state has locked. */
  locked: AssembledState | null;
  validationError: string | null;
  /** facelet indices (0..53) whose samples disagree the most - the UI
   *  highlights these for tap-to-fix. Only meaningful once locked. */
  lowConfidence: number[];
}

// DECISION: glare = L above 96 with chroma below 6 - a clipped highlight has
// no usable pigment. Dropping (not down-weighting) is right because a wiped
// sticker's samples are actively misleading, not merely noisy.
export function isGlareSample(lab: Lab): boolean {
  return lab.L > 96 && Math.hypot(lab.a, lab.b) < 6;
}

const MIN_SAMPLES = 5;      // per cell before a face counts as covered
const RESERVOIR = 40;       // frames kept per cluster; newest replace oldest
const MIN_CONF = 0.5;       // ignore observations from low-confidence quads
/** A frame whose best-rotation fit to the consensus is worse than this (normalized Lab, mean over cells) is an outlier. */
const OUTLIER_DIST = 18;
const ALIGN_ITERATIONS = 3;

/** Row-major 3x3 cell index after k quarter turns: rotated[i] = cells[ROT[k][i]]. */
const ROT: readonly (readonly number[])[] = (() => {
  const once = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // 90 deg: new (r, c) = old (2 - c, r)
  const out: number[][] = [[0, 1, 2, 3, 4, 5, 6, 7, 8]];
  for (let k = 1; k < 4; k++) out.push(out[k - 1]!.map((_, i) => out[k - 1]![once[i]!]!));
  return out;
})();

export function rotateCells<T>(cells: readonly T[], k: number): T[] {
  return ROT[k & 3]!.map((j) => cells[j]!);
}

interface FrameObs {
  /** 9 cells; null = glare, dropped */
  cells: (Lab | null)[];
  /** the same cells in the exposure-free space (own median L subtracted, crushed) */
  norm: (Lab | null)[];
}

function normalize(cells: (Lab | null)[]): (Lab | null)[] {
  const present = cells.filter((c): c is Lab => c !== null);
  if (!present.length) return cells.map(() => null);
  const normed = normalizeFaceCells(present);
  let k = 0;
  return cells.map((c) => (c === null ? null : normed[k++]!));
}

function cellMedian(frames: readonly (Lab | null)[][], i: number): Lab | null {
  const xs = frames.map((f) => f[i]).filter((c): c is Lab => c !== null);
  return xs.length ? labMedian(xs) : null;
}

/** Mean distance of a frame (at rotation k) to the per-cell consensus, over cells both have. */
function fitAt(norm: readonly (Lab | null)[], k: number, consensus: readonly (Lab | null)[]): number {
  const rotated = rotateCells(norm, k);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const c = rotated[i];
    const m = consensus[i];
    if (c && m) { sum += labDistance(c, m); n++; }
  }
  return n ? sum / n : Infinity;
}

export class StickerVoter {
  private frames = 0;
  private obs = new Map<number, FrameObs[]>();
  private locked: AssembledState | null = null;
  private lastValidationError: string | null = null;
  /** Debug: the last lock attempt with every face covered. */
  lastAttempt: LockAttempt | null = null;

  reset(): void {
    this.obs.clear();
    this.frames = 0;
    this.locked = null;
    this.lastValidationError = null;
    this.lastAttempt = null;
  }

  /** Record one frame's observations. `faceMap` is the current cluster -> letter binding, used to try a lock. */
  addFrame(observations: readonly FaceObservation[], faceMap: ReadonlyMap<number, FaceId>): void {
    if (this.locked) return;
    this.frames++;
    for (const ob of observations) {
      if (ob.conf < MIN_CONF || ob.cells.length !== 9) continue;
      const cells = ob.cells.map((c) => (isGlareSample(c) ? null : { ...c }));
      let r = this.obs.get(ob.cluster);
      if (!r) this.obs.set(ob.cluster, (r = []));
      r.push({ cells, norm: normalize(cells) });
      if (r.length > RESERVOIR) r.shift();
    }
    this.tryLock(faceMap);
  }

  /** Merge one cluster's votes into another (the clusterer merged them). */
  mergeClusters(from: number, into: number): void {
    const src = this.obs.get(from);
    if (!src) return;
    this.obs.set(into, [...(this.obs.get(into) ?? []), ...src].slice(-RESERVOIR));
    this.obs.delete(from);
  }

  private clusterIds(): number[] {
    return [...this.obs.keys()];
  }

  private framesOf(clusters: readonly number[]): FrameObs[] {
    return clusters.flatMap((c) => this.obs.get(c) ?? []);
  }

  /**
   * The consensus of a set of frames: per-cell medians after aligning every
   * frame by its best rotation and dropping the frames that fit none.
   */
  private consensus(frames: readonly FrameObs[]): { cells: (Lab | null)[]; inliers: number; rotations: [number, number, number, number]; fit: number; aligned: (Lab | null)[][] } {
    if (!frames.length) return { cells: Array.from({ length: 9 }, () => null), inliers: 0, rotations: [0, 0, 0, 0], fit: 0, aligned: [] };
    let rot = frames.map(() => 0);
    let keep = frames.map(() => true);
    for (let iter = 0; iter < ALIGN_ITERATIONS; iter++) {
      const aligned = frames.flatMap((f, j) => (keep[j] ? [rotateCells(f.norm, rot[j]!)] : []));
      const con = Array.from({ length: 9 }, (_, i) => cellMedian(aligned, i));
      rot = frames.map((f) => {
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < 4; k++) { const d = fitAt(f.norm, k, con); if (d < bestD) { bestD = d; best = k; } }
        return best;
      });
      keep = frames.map((f, j) => fitAt(f.norm, rot[j]!, con) <= OUTLIER_DIST);
      if (!keep.some(Boolean)) keep = frames.map(() => true);
    }
    // the majority's claimed rotation is the absolute one: re-express every
    // alignment relative to it so "as claimed" frames read as rotation 0
    const counts: [number, number, number, number] = [0, 0, 0, 0];
    frames.forEach((_, j) => { if (keep[j]) counts[rot[j]!]++; });
    const majority = counts.indexOf(Math.max(...counts));
    const alignedRaw = frames.flatMap((f, j) => (keep[j] ? [rotateCells(f.cells, (rot[j]! - majority + 4) & 3)] : []));
    const alignedNorm = frames.flatMap((f, j) => (keep[j] ? [rotateCells(f.norm, (rot[j]! - majority + 4) & 3)] : []));
    const con = Array.from({ length: 9 }, (_, i) => cellMedian(alignedNorm, i));
    const rotations: [number, number, number, number] = [0, 0, 0, 0];
    let fitSum = 0;
    let inliers = 0;
    frames.forEach((f, j) => {
      if (!keep[j]) return;
      const k = (rot[j]! - majority + 4) & 3;
      rotations[k]++;
      fitSum += fitAt(f.norm, k, con);
      inliers++;
    });
    return { cells: Array.from({ length: 9 }, (_, i) => cellMedian(alignedRaw, i)), inliers, rotations, fit: inliers ? fitSum / inliers : 0, aligned: alignedNorm };
  }

  private fillOf(cells: readonly (Lab | null)[], frames: readonly FrameObs[]): number {
    // per cell: inlier frames that have the cell, capped at MIN_SAMPLES
    let have = 0;
    for (let i = 0; i < 9; i++) {
      if (!cells[i]) continue;
      have += Math.min(frames.filter((f) => f.cells[i] !== null).length, MIN_SAMPLES);
    }
    return have / (9 * MIN_SAMPLES);
  }

  private evidenceOf(face: FaceId, faceMap: ReadonlyMap<number, FaceId>): FaceEvidence {
    const clusters = [...faceMap].filter(([, f]) => f === face).map(([c]) => c);
    const frames = this.framesOf(clusters);
    const con = this.consensus(frames);
    return { face, clusters, frames: frames.length, inliers: con.inliers, rotations: con.rotations, fit: con.fit, cells: con.cells.filter((c): c is Lab => c !== null) };
  }

  private faceFill(face: FaceId, faceMap: ReadonlyMap<number, FaceId>): number {
    const clusters = [...faceMap].filter(([, f]) => f === face).map(([c]) => c);
    const frames = this.framesOf(clusters);
    if (!frames.length) return 0;
    return this.fillOf(this.consensus(frames).cells, frames);
  }

  /** Try to lock with the given binding; the caller may call this after a re-binding without new samples. */
  tryLock(faceMap: ReadonlyMap<number, FaceId>): void {
    if (this.locked) return;
    const evidence: FaceEvidence[] = [];
    for (const face of FACE_ORDER) {
      const ev = this.evidenceOf(face, faceMap);
      if (ev.cells.length !== 9 || this.faceFill(face, faceMap) < 1) return;
      evidence.push(ev);
    }
    const captures: FaceCapture[] = evidence.map((ev) => ({ face: ev.face, cells: ev.cells }));
    const attempt: LockAttempt = { evidence, assembled: null, error: null };
    try {
      const assembled = resolveByPieces(assembleState(captures));
      attempt.assembled = assembled;
      const v = validateState(assembled.facelets);
      if (v.ok) {
        this.locked = assembled;
        this.lastValidationError = null;
      } else {
        this.lastValidationError = v.error ?? 'invalid state';
      }
    } catch (err) {
      this.lastValidationError = String(err instanceof Error ? err.message : err);
    }
    attempt.error = this.lastValidationError;
    this.lastAttempt = attempt;
  }

  progress(faceMap: ReadonlyMap<number, FaceId>): AssemblyProgress {
    const faceFill = {} as Record<FaceId, number>;
    for (const f of FACE_ORDER) faceFill[f] = this.faceFill(f, faceMap);
    const unboundFill: Record<number, number> = {};
    for (const cluster of this.clusterIds()) {
      if (faceMap.has(cluster)) continue;
      const frames = this.obs.get(cluster)!;
      unboundFill[cluster] = this.fillOf(this.consensus(frames).cells, frames);
    }
    const lowConfidence: number[] = [];
    if (this.locked) {
      // dispersion of each cell's aligned samples around the consensus, worst first
      const spread: Array<[number, number]> = [];
      FACE_ORDER.forEach((face, fi) => {
        const clusters = [...faceMap].filter(([, f]) => f === face).map(([c]) => c);
        const frames = this.framesOf(clusters);
        if (!frames.length) return;
        const con = this.consensus(frames);
        for (let i = 0; i < 9; i++) {
          const m = cellMedian(con.aligned, i);
          if (!m) continue;
          const xs = con.aligned.flatMap((f) => (f[i] ? [labDistance(f[i]!, m)] : []));
          if (xs.length) spread.push([fi * 9 + i, xs.reduce((s, x) => s + x, 0) / xs.length]);
        }
      });
      spread.sort((a, b) => b[1] - a[1]);
      for (const [idx, d] of spread) {
        if (d > 9 && lowConfidence.length < 6) lowConfidence.push(idx);
      }
    }
    return {
      faceFill,
      unboundFill,
      framesSeen: this.frames,
      locked: this.locked,
      validationError: this.lastValidationError,
      lowConfidence,
    };
  }
}

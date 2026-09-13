// Any-order state assembly (M7): per-sticker voting across frames.
//
// The detector/tracker stack turns frames into per-face 9-cell Lab
// observations (already in sticker-layout order), each tagged with the
// session colour CLUSTER its centre belongs to (detect/colorid.ts) - not a
// face letter. This module accumulates them into per-cell sample reservoirs
// keyed by cluster and, once every cluster has enough evidence and every
// cluster has a letter, aggregates each cell (Lab median - robust to outlier
// frames), hands the result to M1's proven assembleState (center-seeded
// k-means + cubejs facelet mapping), resolves near-tie stickers by piece
// uniqueness (resolveByPieces), then validateState. Never trust a single
// frame (CLAUDE.md): a state only locks when sampling converged AND cubejs
// accepts it.
//
// Keying by cluster rather than letter (2026-09-13) is what lets a cluster be
// renamed (a lone warm cluster resolving to red or orange late in the
// session) without throwing away or mislabelling the votes already cast.
//
// M8 glare rule lives here too: samples that are blown out (very high L,
// near-zero chroma) carry no pigment information and are dropped before
// they can dilute the vote.

import { labMedian, labDistance } from './color';
import { assembleState, resolveByPieces, validateState, type AssembledState } from './state';
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
const RESERVOIR = 25;       // cap per cell; newest replace oldest
const MIN_CONF = 0.5;       // ignore observations from low-confidence quads

export class StickerVoter {
  private samples: Map<string, Lab[]> = new Map(); // "<cluster>:<cell>" -> reservoir
  private frames = 0;
  private locked: AssembledState | null = null;
  private lastValidationError: string | null = null;

  reset(): void {
    this.samples.clear();
    this.frames = 0;
    this.locked = null;
    this.lastValidationError = null;
  }

  /** Record one frame's observations. `faceMap` is the current cluster -> letter binding, used to try a lock. */
  addFrame(observations: readonly FaceObservation[], faceMap: ReadonlyMap<number, FaceId>): void {
    if (this.locked) return;
    this.frames++;
    for (const ob of observations) {
      if (ob.conf < MIN_CONF || ob.cells.length !== 9) continue;
      for (let i = 0; i < 9; i++) {
        const cell = ob.cells[i]!;
        if (isGlareSample(cell)) continue;
        const key = `${ob.cluster}:${i}`;
        let r = this.samples.get(key);
        if (!r) this.samples.set(key, (r = []));
        r.push({ ...cell });
        if (r.length > RESERVOIR) r.shift();
      }
    }
    this.tryLock(faceMap);
  }

  /** Merge one cluster's votes into another (the clusterer merged them). */
  mergeClusters(from: number, into: number): void {
    for (let i = 0; i < 9; i++) {
      const src = this.samples.get(`${from}:${i}`);
      if (!src) continue;
      const key = `${into}:${i}`;
      const dst = this.samples.get(key) ?? [];
      this.samples.set(key, [...dst, ...src].slice(-RESERVOIR));
      this.samples.delete(`${from}:${i}`);
    }
  }

  private cellSamples(cluster: number, i: number): Lab[] {
    return this.samples.get(`${cluster}:${i}`) ?? [];
  }

  /** All samples of one cell across every cluster mapped to the face (a colour may be split over clusters). */
  private faceCellSamples(face: FaceId, faceMap: ReadonlyMap<number, FaceId>, i: number): Lab[] {
    const out: Lab[] = [];
    for (const [cluster, f] of faceMap) if (f === face) out.push(...this.cellSamples(cluster, i));
    return out;
  }

  private faceFill(face: FaceId, faceMap: ReadonlyMap<number, FaceId>): number {
    let have = 0;
    for (let i = 0; i < 9; i++) have += Math.min(this.faceCellSamples(face, faceMap, i).length, MIN_SAMPLES);
    return have / (9 * MIN_SAMPLES);
  }

  private clusterIds(): number[] {
    const ids = new Set<number>();
    for (const key of this.samples.keys()) ids.add(Number(key.split(':')[0]));
    return [...ids];
  }

  private fill(cluster: number): number {
    let have = 0;
    for (let i = 0; i < 9; i++) have += Math.min(this.cellSamples(cluster, i).length, MIN_SAMPLES);
    return have / (9 * MIN_SAMPLES);
  }

  /** Try to lock with the given binding; the caller may call this after a re-binding without new samples. */
  tryLock(faceMap: ReadonlyMap<number, FaceId>): void {
    if (this.locked) return;
    for (const f of FACE_ORDER) if (this.faceFill(f, faceMap) < 1) return;
    const captures = FACE_ORDER.map((face) => ({
      face,
      cells: Array.from({ length: 9 }, (_, i) => labMedian(this.faceCellSamples(face, faceMap, i))),
    }));
    try {
      const assembled = resolveByPieces(assembleState(captures));
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
  }

  progress(faceMap: ReadonlyMap<number, FaceId>): AssemblyProgress {
    const faceFill = {} as Record<FaceId, number>;
    for (const f of FACE_ORDER) faceFill[f] = 0;
    const unboundFill: Record<number, number> = {};
    for (const f of FACE_ORDER) faceFill[f] = this.faceFill(f, faceMap);
    for (const cluster of this.clusterIds()) if (!faceMap.has(cluster)) unboundFill[cluster] = this.fill(cluster);
    const lowConfidence: number[] = [];
    if (this.locked) {
      // dispersion of each cell's reservoir around its median, worst first
      const spread: Array<[number, number]> = [];
      FACE_ORDER.forEach((face, fi) => {
        for (let i = 0; i < 9; i++) {
          const r = this.faceCellSamples(face, faceMap, i);
          if (!r.length) continue;
          const med = labMedian(r);
          const d = r.reduce((s, x) => s + labDistance(x, med), 0) / Math.max(r.length, 1);
          spread.push([fi * 9 + i, d]);
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

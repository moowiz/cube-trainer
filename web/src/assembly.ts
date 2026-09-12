// Any-order state assembly (M7): per-sticker voting across frames.
//
// The detector/tracker/orient stack turns frames into per-face 9-cell Lab
// observations (already in sticker-layout order). This module accumulates
// them into per-cell sample reservoirs and, once every face has enough
// evidence, aggregates each cell (Lab median - robust to outlier frames)
// and hands the result to M1's proven assembleState (center-seeded k-means
// + cubejs facelet mapping), then validateState. Never trust a single frame
// (CLAUDE.md): a state only locks when sampling converged AND cubejs
// accepts it.
//
// M8 glare rule lives here too: samples that are blown out (very high L,
// near-zero chroma) carry no pigment information and are dropped before
// they can dilute the vote.

import { labMedian, labDistance } from './color';
import { assembleState, validateState, type AssembledState } from './state';
import { FACE_ORDER } from './types';
import type { FaceId, Lab } from './types';

export interface FaceObservation {
  face: FaceId;
  /** 9 Lab cells, row-major in the face's sticker-layout orientation. */
  cells: Lab[];
  /** Detector confidence for this face in this frame, [0,1]. */
  conf: number;
}

export interface AssemblyProgress {
  /** 0..1 per face: how close its cells are to having enough samples. */
  faceFill: Record<FaceId, number>;
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
  private samples: Map<string, Lab[]> = new Map(); // "F:3" -> reservoir
  private frames = 0;
  private locked: AssembledState | null = null;
  private lastValidationError: string | null = null;

  reset(): void {
    this.samples.clear();
    this.frames = 0;
    this.locked = null;
    this.lastValidationError = null;
  }

  addFrame(observations: readonly FaceObservation[]): void {
    if (this.locked) return;
    this.frames++;
    for (const ob of observations) {
      if (ob.conf < MIN_CONF || ob.cells.length !== 9) continue;
      for (let i = 0; i < 9; i++) {
        const cell = ob.cells[i]!;
        if (isGlareSample(cell)) continue;
        const key = `${ob.face}:${i}`;
        let r = this.samples.get(key);
        if (!r) this.samples.set(key, (r = []));
        r.push({ ...cell });
        if (r.length > RESERVOIR) r.shift();
      }
    }
    this.tryLock();
  }

  private cellSamples(face: FaceId, i: number): Lab[] {
    return this.samples.get(`${face}:${i}`) ?? [];
  }

  private faceReady(face: FaceId): boolean {
    for (let i = 0; i < 9; i++) if (this.cellSamples(face, i).length < MIN_SAMPLES) return false;
    return true;
  }

  private tryLock(): void {
    for (const f of FACE_ORDER) if (!this.faceReady(f)) return;
    const captures = FACE_ORDER.map((face) => ({
      face,
      cells: Array.from({ length: 9 }, (_, i) => labMedian(this.cellSamples(face, i))),
    }));
    try {
      const assembled = assembleState(captures);
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

  progress(): AssemblyProgress {
    const faceFill = {} as Record<FaceId, number>;
    for (const f of FACE_ORDER) {
      let have = 0;
      for (let i = 0; i < 9; i++) have += Math.min(this.cellSamples(f, i).length, MIN_SAMPLES);
      faceFill[f] = have / (9 * MIN_SAMPLES);
    }
    const lowConfidence: number[] = [];
    if (this.locked) {
      // dispersion of each cell's reservoir around its median, worst first
      const spread: Array<[number, number]> = [];
      FACE_ORDER.forEach((face, fi) => {
        for (let i = 0; i < 9; i++) {
          const r = this.cellSamples(face, i);
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
      framesSeen: this.frames,
      locked: this.locked,
      validationError: this.lastValidationError,
      lowConfidence,
    };
  }
}

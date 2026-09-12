// Corner tracker for the cube face detector (M6).
//
// The detector runs every 2-3 frames (detections=null in between); this
// module smooths jitter with a per-corner alpha-beta filter, coasts on
// velocity between detections, and rejects outlier jumps (a false positive
// or a mis-association landing far from where the track predicted).
import type { DetectedFace } from './facekp';
import type { FaceId } from '../types';
import { FACE_ORDER } from '../types';

export interface TrackedFace {
  face: FaceId;
  conf: number; // EMA-smoothed confidence
  corners: [number, number][]; // filtered, 4 corners
  ageMs: number; // time since track created
  sinceDetectMs: number; // time since last accepted detection (0 on frames with one)
}

export interface TrackerOptions {
  posAlpha?: number; // position correction gain, default 0.55
  velAlpha?: number; // velocity correction gain, default 0.25
  confAlpha?: number; // conf EMA gain, default 0.35
  dropMs?: number; // drop a track after this long without detection, default 450
  gateFrac?: number; // reject a detection whose centroid jumps more than
  // gateFrac * sqrt(quad area) from prediction, default 0.6
}

const DEFAULTS: Required<TrackerOptions> = {
  posAlpha: 0.55,
  velAlpha: 0.25,
  confAlpha: 0.35,
  dropMs: 450,
  gateFrac: 0.6,
};

// Below this age a track is still too fresh to trust its prediction for
// gating (first couple of detections may be noisy) — accept unconditionally.
const GATE_MIN_AGE_MS = 200;

// Velocity decay per coasted frame, expressed per 33ms (~30fps) so it scales
// sensibly if dtMs varies.
const COAST_VEL_DECAY_PER_33MS = 0.9;
const COAST_CONF_DECAY_PER_33MS = 0.95;

interface Track {
  face: FaceId;
  conf: number;
  pos: [number, number][]; // 4 corners, px
  vel: [number, number][]; // px/sec
  ageMs: number;
  sinceDetectMs: number;
}

function centroid(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  return [x / pts.length, y / pts.length];
}

// Shoelace formula, unsigned area of the (assumed simple) quad.
function quadArea(pts: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function dist2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// Detector's corner order is only defined up to cyclic rotation (rotation-
// invariant training target). Roll the incoming corners to whichever of the
// 4 cyclic rotations best matches the track's predicted order — reflections
// are never tried, since the detector never emits a mirrored order.
function bestCyclicRoll(measured: [number, number][], predicted: [number, number][]): [number, number][] {
  const n = measured.length;
  let best = measured;
  let bestCost = Infinity;
  for (let roll = 0; roll < n; roll++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      cost += dist2(measured[(i + roll) % n], predicted[i]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = Array.from({ length: n }, (_, i) => measured[(i + roll) % n]);
    }
  }
  return best;
}

export class FaceTracker {
  private opts: Required<TrackerOptions>;
  private tracks = new Map<FaceId, Track>();

  constructor(opts: TrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset(): void {
    this.tracks.clear();
  }

  update(detections: DetectedFace[] | null, dtMs: number): TrackedFace[] {
    const { posAlpha, velAlpha, confAlpha, dropMs, gateFrac } = this.opts;
    const dtSec = Math.max(dtMs, 1) / 1000;
    const detByFace = new Map<FaceId, DetectedFace>();
    if (detections) {
      for (const d of detections) detByFace.set(d.face, d);
    }

    // Predict every existing track forward, then reconcile with a detection
    // (if any and if it passes the gate) or let it coast.
    for (const [face, track] of this.tracks) {
      const predicted: [number, number][] = track.pos.map(([x, y], i) => [
        x + track.vel[i][0] * dtSec,
        y + track.vel[i][1] * dtSec,
      ]);

      const det = detByFace.get(face);
      let accepted: [number, number][] | null = null;
      if (det) {
        const rolled = bestCyclicRoll(det.corners, predicted);
        if (track.ageMs < GATE_MIN_AGE_MS) {
          accepted = rolled;
        } else {
          const predCentroid = centroid(predicted);
          const measCentroid = centroid(rolled);
          const gate = gateFrac * Math.sqrt(quadArea(predicted));
          accepted = Math.sqrt(dist2(predCentroid, measCentroid)) <= gate ? rolled : null;
        }
      }

      if (accepted) {
        const newPos: [number, number][] = [];
        const newVel: [number, number][] = [];
        for (let i = 0; i < predicted.length; i++) {
          const resX = accepted[i][0] - predicted[i][0];
          const resY = accepted[i][1] - predicted[i][1];
          newPos.push([predicted[i][0] + posAlpha * resX, predicted[i][1] + posAlpha * resY]);
          newVel.push([
            track.vel[i][0] + (velAlpha * resX) / dtSec,
            track.vel[i][1] + (velAlpha * resY) / dtSec,
          ]);
        }
        track.pos = newPos;
        track.vel = newVel;
        track.conf += confAlpha * (det!.conf - track.conf);
        track.sinceDetectMs = 0;
      } else {
        // Coast: advance by velocity, decay velocity/conf so a stale track
        // doesn't fly off screen or stay falsely confident.
        track.pos = predicted;
        const decaySteps = dtMs / 33;
        const velDecay = Math.pow(COAST_VEL_DECAY_PER_33MS, decaySteps);
        const confDecay = Math.pow(COAST_CONF_DECAY_PER_33MS, decaySteps);
        track.vel = track.vel.map(([vx, vy]) => [vx * velDecay, vy * velDecay]);
        track.conf *= confDecay;
        track.sinceDetectMs += dtMs;
      }
      track.ageMs += dtMs;
    }

    // Drop stale tracks.
    for (const [face, track] of this.tracks) {
      if (track.sinceDetectMs > dropMs) this.tracks.delete(face);
    }

    // New tracks: any detection for a face with no existing track. Takes
    // the detection's corner order as-is (nothing to align to yet).
    if (detections) {
      for (const det of detections) {
        if (this.tracks.has(det.face)) continue;
        this.tracks.set(det.face, {
          face: det.face,
          conf: det.conf,
          pos: det.corners.map((c) => [...c] as [number, number]),
          vel: det.corners.map(() => [0, 0]),
          ageMs: 0,
          sinceDetectMs: 0,
        });
      }
    }

    const out: TrackedFace[] = [];
    for (const face of FACE_ORDER) {
      const track = this.tracks.get(face);
      if (!track) continue;
      out.push({
        face: track.face,
        conf: track.conf,
        corners: track.pos.map((c) => [...c] as [number, number]),
        ageMs: track.ageMs,
        sinceDetectMs: track.sinceDetectMs,
      });
    }
    return out;
  }
}

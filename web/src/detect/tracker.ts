// Anonymous quad tracker for the cube face detector (M6).
//
// The detector runs every 2-3 frames (detections=null in between); this
// module smooths jitter with a per-corner alpha-beta filter, coasts on
// velocity between detections, and rejects outlier jumps (a false positive
// or a mis-association landing far from where the track predicted).
//
// DECISION 2026-09-13: tracks are keyed by a numeric id and associated by
// GEOMETRY (nearest predicted centroid within a gate), never by a colour
// name. The previous tracker keyed tracks by face letter, so a face named
// wrongly once stayed wrong for the life of the track and fed every later
// frame's colour reading to the wrong exemplar (scan-debug-1789290604959).
// Identity is now decided downstream, from the track's accumulated colour
// evidence (colorid.ts), and can change without losing the track.
export interface QuadDetection {
  corners: [number, number][];
  conf: number;
}

export interface TrackedQuad {
  id: number;
  conf: number; // EMA-smoothed confidence
  corners: [number, number][]; // filtered, 4 corners, order stable for the life of the track, at this update's frame
  ageMs: number; // time since track created
  sinceDetectMs: number; // time since last accepted detection arrived (0 on frames with one)
  /** Index into this update's detections that fed the track, or -1 (coasting / no detections). */
  detIndex: number;
  /** The accepted detection's raw corners in the track's order (exact for
   *  the frame the detector saw, unfiltered), when detIndex >= 0. */
  measured: [number, number][] | null;
}

export interface TrackerOptions {
  posAlpha?: number; // position correction gain, default 0.55
  velAlpha?: number; // velocity correction gain per detection gap, default 0.6 (< 1: never overshoots)
  confAlpha?: number; // conf EMA gain, default 0.35
  dropMs?: number; // drop a track after this long without detection, default 450
  gateFrac?: number; // reject a detection whose centroid jumps more than
  // gateFrac * sqrt(quad area) from prediction, default 0.6
}

const DEFAULTS: Required<TrackerOptions> = {
  posAlpha: 0.55,
  velAlpha: 0.6,
  confAlpha: 0.35,
  dropMs: 450,
  gateFrac: 0.6,
};

// Below this age a track is still too fresh to trust its prediction for
// gating (first couple of detections may be noisy) - the gate is widened.
const GATE_MIN_AGE_MS = 200;
const YOUNG_GATE_FRAC = 1.2;

// Velocity decay per coasted frame, expressed per 33ms (~30fps) so it scales
// sensibly if dtMs varies.
const COAST_VEL_DECAY_PER_33MS = 0.9;
const COAST_CONF_DECAY_PER_33MS = 0.95;
// Beyond this past its state the track holds still rather than keep
// extrapolating: a constant-velocity guess is worth ~a tick, not more.
const COAST_MAX_MS = 250;
// Velocity is trusted unchanged for one typical detection gap; only a coast
// longer than that starts decaying it (decaying from the first coasted
// frame made every track lag a moving cube by a few px).
const COAST_TRUST_MS = 120;

interface Track {
  id: number;
  conf: number;
  detIndex: number;
  measured: [number, number][] | null;
  pos: [number, number][]; // 4 corners, px, at the last measurement's frame
  vel: [number, number][]; // px/sec
  ageMs: number;
  sinceDetectMs: number;   // since the last measurement ARRIVED
  stateAgeMs: number;      // since the last measurement's FRAME (= sinceDetectMs + its lag)
}

export function centroid(pts: ReadonlyArray<readonly [number, number]>): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  return [x / pts.length, y / pts.length];
}

// Shoelace formula, unsigned area of the (assumed simple) quad.
export function quadArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function dist2(a: readonly [number, number], b: readonly [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// Detector's corner order is only defined up to cyclic rotation (rotation-
// invariant training target). Roll the incoming corners to whichever of the
// 4 cyclic rotations best matches the track's predicted order - reflections
// are never tried, since the detector never emits a mirrored order.
function bestCyclicRoll(measured: [number, number][], predicted: [number, number][]): [number, number][] {
  const n = measured.length;
  let best = measured;
  let bestCost = Infinity;
  for (let roll = 0; roll < n; roll++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      cost += dist2(measured[(i + roll) % n]!, predicted[i]!);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = Array.from({ length: n }, (_, i) => measured[(i + roll) % n]!);
    }
  }
  return best;
}

export class QuadTracker {
  private opts: Required<TrackerOptions>;
  private tracks = new Map<number, Track>();
  private nextId = 1;

  constructor(opts: TrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
  }

  /** Change gains on the fly (tracks are kept). */
  configure(opts: TrackerOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * Advance every track by dtMs and fuse `detections`, which describe the
   * frame `lagMs` before the one the tracks are being advanced to (0 when
   * the detection is for this very frame).
   *
   * The filter state lives at MEASUREMENT time: a detection is compared
   * with the track predicted to the moment the detector looked, and the
   * corners handed out are that state carried forward to now along the
   * velocity. Fusing a ~100 ms old measurement as if it were current was
   * the rubber-band jitter on the phone (2026-09-13); shifting the
   * measurement forward by vel*lag instead is a positive-feedback loop
   * (a velocity error shifts the measurement, which feeds the velocity),
   * so the lag is taken out on the prediction side, never the measurement.
   */
  update(detections: QuadDetection[] | null, dtMs: number, lagMs = 0): TrackedQuad[] {
    const { posAlpha, velAlpha, confAlpha, dropMs, gateFrac } = this.opts;
    const dt = Math.max(dtMs, 1);
    const lag = Math.max(lagMs, 0);

    // Time passes for every track; a track's state stays where its last
    // measurement put it (state age = time since that measurement's frame).
    for (const track of this.tracks.values()) {
      track.ageMs += dt;
      track.sinceDetectMs += dt;
      track.stateAgeMs += dt;
    }

    // Predict every track to the measurement's frame (a state older than
    // COAST_MAX_MS holds still rather than keep extrapolating).
    const predicted = new Map<number, [number, number][]>();
    for (const [id, track] of this.tracks) {
      predicted.set(id, this.extrapolate(track, Math.max(0, track.stateAgeMs - lag)));
    }

    // Associate: every (track, detection) pair inside the track's gate,
    // nearest first, each side used once. A young track gets a wider gate.
    const assigned = new Map<number, QuadDetection>();
    const usedDet = new Set<QuadDetection>();
    if (detections?.length) {
      const pairs: { id: number; det: QuadDetection; d: number }[] = [];
      for (const [id, pred] of predicted) {
        const track = this.tracks.get(id)!;
        const gate = (track.ageMs < GATE_MIN_AGE_MS ? YOUNG_GATE_FRAC : gateFrac) * Math.sqrt(quadArea(pred));
        const pc = centroid(pred);
        for (const det of detections) {
          const d = Math.sqrt(dist2(pc, centroid(det.corners)));
          if (d <= gate) pairs.push({ id, det, d });
        }
      }
      pairs.sort((a, b) => a.d - b.d);
      for (const p of pairs) {
        if (assigned.has(p.id) || usedDet.has(p.det)) continue;
        assigned.set(p.id, p.det);
        usedDet.add(p.det);
      }
    }

    for (const [id, track] of this.tracks) {
      const pred = predicted.get(id)!;
      const det = assigned.get(id);
      track.detIndex = det ? detections!.indexOf(det) : -1;
      track.measured = null;
      if (det) {
        const accepted = bestCyclicRoll(det.corners, pred);
        track.measured = accepted;
        const newPos: [number, number][] = [];
        const newVel: [number, number][] = [];
        // The residual accumulated over the whole gap between the two
        // measurements' frames, not over this loop step: detections arrive
        // every inference (~90 ms on a phone) while frames come at 60 Hz,
        // and dividing by the frame dt made the velocity spike ~5x and the
        // quad sail off on the next coasted frames (2026-09-13). A gap
        // under one step (lag shrank between two ticks) counts as a step.
        const gapSec = Math.max(track.stateAgeMs - lag, dt) / 1000;
        for (let i = 0; i < pred.length; i++) {
          const resX = accepted[i]![0] - pred[i]![0];
          const resY = accepted[i]![1] - pred[i]![1];
          newPos.push([pred[i]![0] + posAlpha * resX, pred[i]![1] + posAlpha * resY]);
          newVel.push([track.vel[i]![0] + (velAlpha * resX) / gapSec, track.vel[i]![1] + (velAlpha * resY) / gapSec]);
        }
        track.pos = newPos;
        track.vel = newVel;
        track.conf += confAlpha * (det.conf - track.conf);
        track.sinceDetectMs = 0;
        track.stateAgeMs = lag;
      } else {
        // Coast: decay velocity/conf so a stale track doesn't fly off
        // screen or stay falsely confident.
        const decaySteps = dt / 33;
        const velDecay = track.sinceDetectMs > COAST_TRUST_MS ? Math.pow(COAST_VEL_DECAY_PER_33MS, decaySteps) : 1;
        const confDecay = Math.pow(COAST_CONF_DECAY_PER_33MS, decaySteps);
        track.vel = track.vel.map(([vx, vy]) => [vx * velDecay, vy * velDecay]);
        track.conf *= confDecay;
      }
    }

    // Drop stale tracks.
    for (const [id, track] of this.tracks) {
      if (track.sinceDetectMs > dropMs) this.tracks.delete(id);
    }

    // New tracks for unmatched detections. Takes the detection's corner
    // order as-is (nothing to align to yet).
    if (detections) {
      for (const det of detections) {
        if (usedDet.has(det)) continue;
        this.tracks.set(this.nextId, {
          id: this.nextId,
          conf: det.conf,
          detIndex: detections.indexOf(det),
          measured: det.corners.map((c) => [...c] as [number, number]),
          pos: det.corners.map((c) => [...c] as [number, number]),
          vel: det.corners.map(() => [0, 0]),
          ageMs: 0,
          sinceDetectMs: 0,
          stateAgeMs: lag,
        });
        this.nextId++;
      }
    }

    const out: TrackedQuad[] = [];
    for (const track of this.tracks.values()) {
      out.push({
        id: track.id,
        conf: track.conf,
        corners: this.extrapolate(track, track.stateAgeMs),
        ageMs: track.ageMs,
        sinceDetectMs: track.sinceDetectMs,
        detIndex: track.detIndex,
        measured: track.measured ? track.measured.map((c) => [...c] as [number, number]) : null,
      });
    }
    return out;
  }

  /** The track's corners `aheadMs` after its state, at its velocity; a constant-velocity guess is worth ~a tick, not more. */
  private extrapolate(track: Track, aheadMs: number): [number, number][] {
    const sec = Math.min(Math.max(aheadMs, 0), COAST_MAX_MS) / 1000;
    return track.pos.map(([x, y], i) => [x + track.vel[i]![0] * sec, y + track.vel[i]![1] * sec]);
  }
}

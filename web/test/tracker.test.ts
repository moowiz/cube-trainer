import { describe, it, expect } from 'vitest';
import { FaceTracker } from '../src/detect/tracker';
import type { DetectedFace } from '../src/detect/facekp';

// ---------- deterministic noise: tiny hand-rolled LCG (no Math.random) ----------

function makeLcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------- quad helpers ----------

type Quad = [number, number][];

function shiftQuad(quad: Quad, dx: number, dy: number): Quad {
  return quad.map(([x, y]) => [x + dx, y + dy]);
}

function rollQuad(quad: Quad, n: number): Quad {
  const len = quad.length;
  return Array.from({ length: len }, (_, i) => quad[(i + n) % len]);
}

function cornerDist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function maxCornerDist(a: Quad, b: Quad): number {
  return Math.max(...a.map((c, i) => cornerDist(c, b[i])));
}

const SQUARE: Quad = [
  [100, 100],
  [200, 100],
  [200, 200],
  [100, 200],
];

const DT = 33; // ms, ~30fps — matches the 2-3 frame detector cadence

describe('FaceTracker', () => {
  it('smooths alternating +/-3px noise to within 1px of truth', () => {
    const tracker = new FaceTracker();
    const rand = makeLcg(1);
    let prevOut: Quad | null = null;
    let maxOutStep = 0;

    let final: Quad = SQUARE;
    for (let i = 0; i < 30; i++) {
      // Alternate sign each frame, one axis, so each raw measurement is
      // exactly 3px off truth — the worst case (Nyquist-frequency) jitter
      // a smoothing filter has to reject.
      const sign = i % 2 === 0 ? 1 : -1;
      const noisy = shiftQuad(SQUARE, sign * 3, 0);
      const det: DetectedFace = { face: 'U', conf: 0.9, corners: noisy };
      const [track] = tracker.update([det], DT);

      // Only measure steady-state jitter (skip the initial transient while
      // the filter is still converging from the first raw measurement).
      if (i >= 10 && prevOut) maxOutStep = Math.max(maxOutStep, maxCornerDist(track.corners, prevOut));
      prevOut = track.corners;
      final = track.corners;
    }

    expect(maxCornerDist(final, SQUARE)).toBeLessThan(1);
    // Output must move less frame-to-frame than the 3px input noise itself.
    expect(maxOutStep).toBeLessThan(3);
    void rand; // kept for parity with repo's noise-test style; not needed here
  });

  it('interpolates a constant-velocity quad between sparse detections', () => {
    const tracker = new FaceTracker();
    const vel: [number, number] = [5, 2]; // px per frame (per DT ms)
    let truth = SQUARE;
    let lastOut: Quad | null = null;

    for (let i = 0; i < 30; i++) {
      truth = shiftQuad(truth, vel[0], vel[1]);
      const hasDetection = i % 3 === 0;
      const detections: DetectedFace[] | null = hasDetection
        ? [{ face: 'U', conf: 0.9, corners: truth }]
        : null;
      const [track] = tracker.update(detections, DT);

      // The first several detection cycles are spent learning velocity from
      // scratch (a single detection carries no velocity information, so
      // early coast frames lag truth by a full step); steady tracking
      // accuracy is the thing under test, so only assert it once the
      // estimate has had time to settle into its steady-state cycle.
      if (i >= 24) expect(maxCornerDist(track.corners, truth)).toBeLessThan(3);

      // On coasted (null-detection) frames the track must still be moving,
      // not frozen at the last detection — once velocity has had a cycle
      // to be learned (a brand-new track starts with zero velocity, so the
      // very first coast frame legitimately doesn't move yet).
      if (i >= 24 && !hasDetection && lastOut) {
        expect(maxCornerDist(track.corners, lastOut)).toBeGreaterThan(0.5);
      }
      lastOut = track.corners;
    }
  });

  it('stays locked to one cyclic corner assignment despite random rolls', () => {
    const tracker = new FaceTracker();
    const rand = makeLcg(42);
    let refCorner0: [number, number] | null = null;

    for (let i = 0; i < 20; i++) {
      const roll = Math.floor(rand() * 4);
      const rolled = rollQuad(SQUARE, roll);
      const [track] = tracker.update([{ face: 'U', conf: 0.9, corners: rolled }], DT);

      if (refCorner0 === null) {
        refCorner0 = track.corners[0];
      } else {
        // A wrong (reflected or mis-rolled) alignment would put corner 0 at
        // a different vertex ~100px away; a correct one keeps it in place.
        expect(cornerDist(track.corners[0], refCorner0)).toBeLessThan(2);
      }
    }
  });

  it('gates a teleported detection but accepts a brand-new track anywhere', () => {
    const tracker = new FaceTracker();

    // Establish a stable, aged track (>200ms) for face U.
    let stablePos: Quad = SQUARE;
    for (let i = 0; i < 10; i++) {
      const [track] = tracker.update([{ face: 'U', conf: 0.9, corners: SQUARE }], DT);
      stablePos = track.corners;
    }

    // Teleport the detection 200px away — should be gated out.
    const teleported = shiftQuad(SQUARE, 200, 200);
    const outAfterTeleport = tracker.update(
      [
        { face: 'U', conf: 0.9, corners: teleported },
        { face: 'R', conf: 0.8, corners: shiftQuad(SQUARE, 500, 500) }, // brand-new track, far away
      ],
      DT,
    );

    const uTrack = outAfterTeleport.find((t) => t.face === 'U')!;
    const rTrack = outAfterTeleport.find((t) => t.face === 'R')!;

    // U barely moved: the teleported detection was rejected by the gate.
    expect(maxCornerDist(uTrack.corners, stablePos)).toBeLessThan(5);
    // R is a fresh track — no prior state to gate against, so it's accepted
    // immediately wherever its first detection lands.
    expect(maxCornerDist(rTrack.corners, shiftQuad(SQUARE, 500, 500))).toBeLessThan(1);
  });

  it('drops a track once sinceDetectMs exceeds dropMs', () => {
    const tracker = new FaceTracker({ dropMs: 450 });

    tracker.update([{ face: 'U', conf: 0.9, corners: SQUARE }], DT);

    // ~300ms of coasting: still alive.
    let out: ReturnType<FaceTracker['update']> = [];
    for (let i = 0; i < 9; i++) out = tracker.update(null, DT); // 9*33 = 297ms
    expect(out.some((t) => t.face === 'U')).toBe(true);

    // Push past dropMs (450ms total since last detection).
    for (let i = 0; i < 6; i++) out = tracker.update(null, DT); // +198ms = 495ms
    expect(out.some((t) => t.face === 'U')).toBe(false);
  });

  it('reset() clears all tracks', () => {
    const tracker = new FaceTracker();
    tracker.update([{ face: 'F', conf: 0.9, corners: SQUARE }], DT);
    tracker.reset();
    const out = tracker.update(null, DT);
    expect(out.length).toBe(0);
  });
});

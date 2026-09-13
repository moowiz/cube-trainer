import { describe, it, expect } from 'vitest';
import { makeLcg, shiftQuad } from './helpers';
import { QuadTracker, type QuadDetection } from '../src/detect/tracker';

// ---------- deterministic noise: tiny hand-rolled LCG (no Math.random) ----------


// ---------- quad helpers ----------

type Quad = [number, number][];


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

describe('QuadTracker', () => {
  it('smooths alternating +/-3px noise to within 1px of truth', () => {
    const tracker = new QuadTracker();
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
      const det: QuadDetection = { conf: 0.9, corners: noisy };
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
    const tracker = new QuadTracker();
    const vel: [number, number] = [5, 2]; // px per frame (per DT ms)
    let truth = SQUARE;
    let lastOut: Quad | null = null;

    for (let i = 0; i < 30; i++) {
      truth = shiftQuad(truth, vel[0], vel[1]);
      const hasDetection = i % 3 === 0;
      const detections: QuadDetection[] | null = hasDetection
        ? [{ conf: 0.9, corners: truth }]
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
    const tracker = new QuadTracker();
    const rand = makeLcg(42);
    let refCorner0: [number, number] | null = null;

    for (let i = 0; i < 20; i++) {
      const roll = Math.floor(rand() * 4);
      const rolled = rollQuad(SQUARE, roll);
      const [track] = tracker.update([{ conf: 0.9, corners: rolled }], DT);

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
    const tracker = new QuadTracker();

    // Establish a stable, aged track (>200ms) for face U.
    let stablePos: Quad = SQUARE;
    for (let i = 0; i < 10; i++) {
      const [track] = tracker.update([{ conf: 0.9, corners: SQUARE }], DT);
      stablePos = track.corners;
    }

    // Two detections far away: neither is inside the old track's gate, so
    // the old track coasts and both become new tracks.
    const teleported = shiftQuad(SQUARE, 200, 200);
    const far = shiftQuad(SQUARE, 500, 500);
    const outAfterTeleport = tracker.update([{ conf: 0.9, corners: teleported }, { conf: 0.8, corners: far }], DT);

    expect(outAfterTeleport.length).toBe(3);
    const old = outAfterTeleport.find((t) => t.id === 1)!;
    // the old track barely moved: the teleported detection was not associated with it
    expect(maxCornerDist(old.corners, stablePos)).toBeLessThan(5);
    expect(old.detIndex).toBe(-1);
    // fresh tracks - no prior state to gate against - are accepted wherever they land
    expect(outAfterTeleport.some((t) => maxCornerDist(t.corners, far) < 1 && t.detIndex === 1)).toBe(true);
    expect(outAfterTeleport.some((t) => maxCornerDist(t.corners, teleported) < 1 && t.detIndex === 0)).toBe(true);
  });

  it('drops a track once sinceDetectMs exceeds dropMs', () => {
    const tracker = new QuadTracker({ dropMs: 450 });

    tracker.update([{ conf: 0.9, corners: SQUARE }], DT);

    // ~300ms of coasting: still alive.
    let out: ReturnType<QuadTracker['update']> = [];
    for (let i = 0; i < 9; i++) out = tracker.update(null, DT); // 9*33 = 297ms
    expect(out.length).toBe(1);

    // Push past dropMs (450ms total since last detection).
    for (let i = 0; i < 6; i++) out = tracker.update(null, DT); // +198ms = 495ms
    expect(out.length).toBe(0);
  });

  it('reset() clears all tracks', () => {
    const tracker = new QuadTracker();
    tracker.update([{ conf: 0.9, corners: SQUARE }], DT);
    tracker.reset();
    const out = tracker.update(null, DT);
    expect(out.length).toBe(0);
  });
});

describe('QuadTracker association by geometry', () => {
  it('keeps two nearby tracks apart and follows each one', () => {
    const tracker = new QuadTracker();
    const a = SQUARE;
    const b = shiftQuad(SQUARE, 130, 0); // adjacent face, edges 30 px apart
    let ida = -1;
    let idb = -1;
    for (let i = 0; i < 20; i++) {
      const out = tracker.update([{ conf: 0.9, corners: shiftQuad(b, i, 0) }, { conf: 0.9, corners: shiftQuad(a, i, 0) }], DT);
      expect(out.length).toBe(2);
      const ta = out.find((t) => maxCornerDist(t.corners, shiftQuad(a, i, 0)) < 8)!;
      const tb = out.find((t) => maxCornerDist(t.corners, shiftQuad(b, i, 0)) < 8)!;
      expect(ta).toBeDefined();
      expect(tb).toBeDefined();
      if (i === 0) { ida = ta.id; idb = tb.id; } else { expect(ta.id).toBe(ida); expect(tb.id).toBe(idb); }
    }
  });

  it('a track survives its detection being refused (coasts) and picks it back up', () => {
    const tracker = new QuadTracker();
    const [t0] = tracker.update([{ conf: 0.9, corners: SQUARE }], DT);
    for (let i = 0; i < 5; i++) tracker.update(null, DT);
    const [t1] = tracker.update([{ conf: 0.9, corners: shiftQuad(SQUARE, 4, 0) }], DT);
    expect(t1!.id).toBe(t0!.id);
    expect(t1!.detIndex).toBe(0);
  });
});

// 2026-09-13: with inference off the main thread the loop runs at 60 Hz
// while detections arrive every ~90 ms. Dividing the residual by the frame
// dt made velocity spike ~5x per detection and quads sailed off between
// ticks (phone screenshot 09:06). One track, close to truth, throughout.
it('stays on a slowly moving quad with 16 ms frames and a detection every 6th frame', () => {
  const tracker = new QuadTracker();
  let truth = SQUARE;
  let worst = 0;
  const ids = new Set<number>();
  for (let i = 0; i < 120; i++) {
    truth = shiftQuad(truth, 0.8, 0.3); // ~50 px/s at 60 Hz
    const tracks = tracker.update(i % 6 === 0 ? [{ conf: 0.95, corners: truth }] : null, 16);
    expect(tracks.length).toBe(1);
    ids.add(tracks[0]!.id);
    if (i >= 30) worst = Math.max(worst, maxCornerDist(tracks[0]!.corners, truth));
  }
  expect(ids.size).toBe(1);
  expect(worst).toBeLessThan(6);
});

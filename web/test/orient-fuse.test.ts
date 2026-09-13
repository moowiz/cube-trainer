// Tier-1 geometry constraint: shared-corner fusion across co-visible faces.
// Uses the same synthetic orthographic cube projection as orient.test.ts,
// with per-face noise added - fusion must make shared vertices exactly
// coincident (at the cluster mean) and leave outer corners untouched.
import { describe, expect, it } from 'vitest';
import { fuseSharedCorners, type Corner } from '../src/detect/orient';
import type { FaceId } from '../src/types';
import { visibleFaces } from './helpers';

function view(ax: number, ay: number) {
  return visibleFaces(ax, ay).map((v) => ({ face: v.face, corners: v.quad }));
}

// deterministic "noise"
function jitter(faces: ReturnType<typeof view>, amp: number) {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
  return faces.map((f) => ({
    face: f.face,
    corners: f.corners.map(([x, y]) => [x + amp * rnd(), y + amp * rnd()] as Corner),
  }));
}

describe('fuseSharedCorners', () => {
  it('makes shared vertices exactly coincident on a noisy 3-face view', () => {
    const clean = view(-0.5, 0.6); // U, F, R
    expect(clean.length).toBe(3);
    const noisy = jitter(clean, 3);
    const { fused, fusedPairs } = fuseSharedCorners(noisy);
    // 3 adjacent pairs x 2 shared vertices each
    expect(fusedPairs).toBe(6);
    // every clean shared vertex (appears on >1 face) must now coincide exactly
    const byPos = new Map<string, Array<[FaceId, number]>>();
    clean.forEach((f) => f.corners.forEach((c, i) => {
      const k = `${Math.round(c[0])},${Math.round(c[1])}`;
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k)!.push([f.face, i]);
    }));
    let sharedClusters = 0;
    for (const members of byPos.values()) {
      if (members.length < 2) continue;
      sharedClusters++;
      const pts = members.map(([f, i]) => fused.get(f)![i]);
      for (const p of pts) {
        expect(p[0]).toBeCloseTo(pts[0][0], 9);
        expect(p[1]).toBeCloseTo(pts[0][1], 9);
      }
      // fused position is the mean of the noisy estimates
      const noisyPts = members.map(([f, i]) => noisy.find((n) => n.face === f)!.corners[i]);
      const mx = noisyPts.reduce((s2, p) => s2 + p[0], 0) / noisyPts.length;
      expect(pts[0][0]).toBeCloseTo(mx, 9);
    }
    expect(sharedClusters).toBeGreaterThanOrEqual(3); // central vertex + edge ends
  });

  it('outer corners are untouched and wild disagreements are not fused', () => {
    const clean = view(-0.5, 0.6);
    const noisy = jitter(clean, 3);
    // wreck one face entirely: shift F by half a face - must NOT fuse into others
    const wrecked = noisy.map((f) => f.face === 'F'
      ? { face: f.face, corners: f.corners.map(([x, y]) => [x + 120, y + 120] as Corner) }
      : f);
    const { fused, fusedPairs } = fuseSharedCorners(wrecked);
    // only the U-R pair can still fuse (2 vertices)
    expect(fusedPairs).toBe(2);
    // F's corners unchanged by fusion
    const F = wrecked.find((f) => f.face === 'F')!;
    fused.get('F')!.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(F.corners[i][0], 9);
      expect(p[1]).toBeCloseTo(F.corners[i][1], 9);
    });
  });
});

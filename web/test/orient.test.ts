// Orientation resolution (M6): recover per-face cyclic rotation from shared
// edges, tested against a synthetic cube projection with known ground truth.
import { describe, expect, it } from 'vitest';
import { orientQuad, resolveOrientations, type OrientableFace } from '../src/detect/orient';
import type { FaceId } from '../src/types';

// sticker-layout corner tables (mirror of scene.mjs FACE_DATA / orient.ts)
const LAYOUT: Record<FaceId, [number, number, number][]> = {
  U: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
  R: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]],
  F: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]],
  D: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]],
  L: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]],
  B: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]],
};
const NORMALS: Record<FaceId, [number, number, number]> = {
  U: [0, 1, 0], R: [1, 0, 0], F: [0, 0, 1], D: [0, -1, 0], L: [-1, 0, 0], B: [0, 0, -1],
};

type V3 = [number, number, number];
function rotX(v: V3, a: number): V3 {
  const [x, y, z] = v;
  return [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
}
function rotY(v: V3, a: number): V3 {
  const [x, y, z] = v;
  return [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
}

/** Orthographic camera at +z looking -z; screen y grows downward. */
function project(v: V3): [number, number] {
  return [160 + 100 * v[0], 160 - 100 * v[1]];
}

function visibleFaces(ax: number, ay: number): { face: FaceId; quad: [number, number][]; }[] {
  const out: { face: FaceId; quad: [number, number][] }[] = [];
  for (const f of Object.keys(LAYOUT) as FaceId[]) {
    const n = rotX(rotY(NORMALS[f], ay), ax);
    if (n[2] <= 0.12) continue; // facing away from the camera
    out.push({ face: f, quad: LAYOUT[f].map((c) => project(rotX(rotY(c, ay), ax))) });
  }
  return out;
}

describe('resolveOrientations', () => {
  it('recovers arbitrary cyclic rotations on a 3-face view', () => {
    const vis = visibleFaces(-0.5, 0.6); // classic 3-quarter view: U, F, R
    expect(vis.length).toBe(3);
    const rolls: Record<string, number> = {};
    const input: OrientableFace[] = vis.map((v, i) => {
      const k = [1, 3, 2][i]; // arbitrary known rolls
      rolls[v.face] = k;
      // roll so that corners[(t+k)%4] = layout corner t  =>  corners[t] = layout[(t-k) mod 4]
      const rolled = v.quad.map((_, t) => v.quad[(((t - k) % 4) + 4) % 4]);
      return { face: v.face, corners: rolled };
    });
    const res = resolveOrientations(input);
    expect(res.pairsUsed).toBe(3); // U-F, U-R, F-R
    expect(res.conflicts).toBe(0);
    for (const v of vis) {
      expect(res.rotations[v.face]).toBe(rolls[v.face]);
      // and orientQuad undoes the roll exactly
      const face = input.find((i) => i.face === v.face)!;
      expect(orientQuad(face.corners, res.rotations[v.face]!)).toEqual(v.quad);
    }
  });

  it('recovers rotations on a 2-face view and leaves lone faces unresolved', () => {
    const vis = visibleFaces(0, 0.9); // F and R (near edge-on)
    expect(vis.length).toBe(2);
    const input: OrientableFace[] = vis.map((v) => ({
      face: v.face,
      corners: v.quad.map((_, t) => v.quad[(t + 2) % 4]), // roll both by 2
    }));
    const res = resolveOrientations(input);
    expect(res.rotations[vis[0].face]).toBe(2);
    expect(res.rotations[vis[1].face]).toBe(2);

    const lone = resolveOrientations([input[0]]);
    expect(lone.rotations[vis[0].face]).toBeUndefined();
    expect(lone.pairsUsed).toBe(0);
  });

  it('ignores pairs whose quads do not actually touch (bad detection)', () => {
    const vis = visibleFaces(-0.5, 0.6);
    const input: OrientableFace[] = vis.slice(0, 2).map((v) => ({ face: v.face, corners: v.quad }));
    // teleport the second quad far away: shared-edge match must fail
    const moved = input[1].corners.map(([x, y]) => [x + 500, y] as [number, number]);
    const res = resolveOrientations([input[0], { face: input[1].face, corners: moved }]);
    expect(res.pairsUsed).toBe(0);
  });
});

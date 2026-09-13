// Shared test helpers. Deterministic randomness, quad arithmetic and a
// synthetic orthographic cube projection (mirror of scene.mjs FACE_DATA /
// orient.ts) with known ground truth, used by the orientation suites.
import type { FaceId } from '../src/types';

/** Numerical Recipes LCG in [0, 1): tests must not depend on Math.random. */
export function makeLcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function shiftQuad<Q extends readonly (readonly [number, number])[]>(quad: Q, dx: number, dy: number): Q {
  return quad.map(([x, y]) => [x + dx, y + dy] as const) as unknown as Q;
}

/** Sticker-layout corner tables: each face's 4 corners going around the face, cube spans [-1, 1]. */
export const LAYOUT: Record<FaceId, [number, number, number][]> = {
  U: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
  R: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]],
  F: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]],
  D: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]],
  L: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]],
  B: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]],
};

export const NORMALS: Record<FaceId, [number, number, number]> = {
  U: [0, 1, 0], R: [1, 0, 0], F: [0, 0, 1], D: [0, -1, 0], L: [-1, 0, 0], B: [0, 0, -1],
};

export type V3 = [number, number, number];
export function rotX(v: V3, a: number): V3 {
  const [x, y, z] = v;
  return [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
}
export function rotY(v: V3, a: number): V3 {
  const [x, y, z] = v;
  return [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
}

/** Orthographic camera at +z looking -z; screen y grows downward. */
export function project(v: V3): [number, number] {
  return [160 + 100 * v[0], 160 - 100 * v[1]];
}

/** The faces a camera sees after rotating the cube by ay about Y then ax about X, with their projected corners. */
export function visibleFaces(ax: number, ay: number): { face: FaceId; quad: [number, number][] }[] {
  const out: { face: FaceId; quad: [number, number][] }[] = [];
  for (const f of Object.keys(LAYOUT) as FaceId[]) {
    const n = rotX(rotY(NORMALS[f], ay), ax);
    if (n[2] <= 0.12) continue; // facing away from the camera
    out.push({ face: f, quad: LAYOUT[f].map((c) => project(rotX(rotY(c, ay), ax))) });
  }
  return out;
}

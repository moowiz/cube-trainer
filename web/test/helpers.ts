// Shared test helpers. Deterministic randomness, quad arithmetic and a
// synthetic orthographic cube projection (mirror of scene.mjs FACE_DATA /
// orient.ts) with known ground truth, used by the orientation suites.
import type { FaceId } from '../src/types';

/**
 * Benchmark mode: `npm run bench` (vitest --mode bench) or BENCH=1. The
 * replay suites print their bake-off tables and diagnostics and assert
 * wall-clock budgets only in this mode; `npm test` keeps the correctness
 * assertions and runs in a fraction of the time.
 */
export const BENCH = !!process.env.BENCH || import.meta.env.MODE === 'bench';

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

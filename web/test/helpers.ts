// Shared test helpers. Deterministic randomness, fixture paths, ImageData
// and PNG stand-ins, quad arithmetic and a synthetic orthographic cube
// projection (mirror of scene.mjs FACE_DATA / orient.ts) with known ground
// truth, used by the orientation suites.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Cube from 'cubejs';
import { PNG } from 'pngjs';
import type { ImageDataLike } from '../src/rectify';
import type { FaceId } from '../src/types';

// ---- fixtures ---------------------------------------------------------------------------------

/** The test folder as a path (`import.meta.url` is a file: URL in vitest). */
export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** An absolute path under test/fixtures/. */
export const fixture = (...parts: string[]): string => join(TEST_DIR, 'fixtures', ...parts);
/** A JSON fixture, parsed (the type is the caller's claim). */
export function fixtureJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(fixture(...parts), 'utf8')) as T;
}

/** A PNG on disk as ImageData-like pixels (an absolute path, or one under test/fixtures/ via `fixture`). */
export function loadPng(path: string): ImageDataLike {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

/** A blank RGBA image of the given size, typed as ImageData for the samplers. */
export function makeImage(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) } as unknown as ImageData;
}

export function setPixel(img: ImageData, x: number, y: number, rgb: readonly [number, number, number], alpha = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
  img.data[i + 3] = alpha;
}

/** The one scrambled cube the colour-solver suites share as their truth (a random state, every colour on every face). */
const TRUTH_SCRAMBLE = "F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D";
export const TRUTH: string = new Cube().move(TRUTH_SCRAMBLE).asString();

// ---- 3D scenes ---------------------------------------------------------------------------------

/** {pts, fill} for one poly, points sorted within the poly and rounded, so set-equality survives relabelling and float noise. */
function polySig(p: { pts: readonly (readonly number[])[]; fill: string }): string {
  const pts = p.pts.map((v) => v.map((x) => (Math.round(x * 1e6) / 1e6).toFixed(6)).join(',')).sort();
  return `${pts.join('|')}#${p.fill}`;
}
export const sceneSig = (polys: { pts: readonly (readonly number[])[]; fill: string }[]): string[] => polys.map(polySig).sort();

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

// Tests for the grid-prior seam scorer and refiner (M6, thirds-prior).
// See model/train/grid_check.py for the algorithm this ports.
import { describe, expect, it } from 'vitest';
import { shiftQuad } from './helpers';
import { refineQuad, seamScore } from '../src/detect/gridfit';
import type { ImageDataLike, Quad } from '../src/rectify';

const FACE_X0 = 40;
const FACE_Y0 = 30;
const BRIGHT = 210;
const DARK = 30;
const SEAM_HALF = 2; // 4px-wide seam bands, centered on the thirds

// Deterministic mid-gray "noise" background: no Math.random, small amplitude
// so it reads as near-flat next to the seam contrast (~180 levels).
function bgGray(x: number, y: number): number {
  return 100 + ((x * 7 + y * 13) % 8);
}

function inSeamBand(local: number, size: number): boolean {
  const thirds = [size / 3, (2 * size) / 3];
  return thirds.some((t) => Math.abs(local - t) < SEAM_HALF);
}

/** Synthetic frame: noise background + a bright 3x3 cube face (side `size`)
 * with dark seams at the thirds, top-left corner at (x0, y0). */
function makeFrame(width: number, height: number, size: number, x0 = FACE_X0, y0 = FACE_Y0): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lx = x - x0, ly = y - y0;
      const onFace = lx >= 0 && lx < size && ly >= 0 && ly < size;
      const v = onFace ? (inSeamBand(lx, size) || inSeamBand(ly, size) ? DARK : BRIGHT) : bgGray(x, y);
      const o = (y * width + x) * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function flatFrame(width: number, height: number): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = bgGray(x, y);
      const o = (y * width + x) * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function faceQuad(size: number, x0 = FACE_X0, y0 = FACE_Y0): Quad {
  return [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]] as const;
}


describe('seamScore', () => {
  const SIZE = 96; // face square side == default warpSize, so warping is ~1:1

  it('scores the correct quad high, and a quad shifted 8px lower and below 1.3', () => {
    const img = makeFrame(200, 180, SIZE);
    const correct = seamScore(img, faceQuad(SIZE));
    expect(correct.score).toBeGreaterThan(1.8);

    const shifted = seamScore(img, shiftQuad(faceQuad(SIZE), 8, 8));
    expect(shifted.score).toBeLessThan(correct.score);
    expect(shifted.score).toBeLessThan(1.3);
  });

  it('reports near-zero strength on a flat/noise background (unverifiable)', () => {
    const img = flatFrame(200, 180);
    const result = seamScore(img, faceQuad(SIZE));
    expect(result.strength).toBeLessThan(10);
  });
});

describe('refineQuad', () => {
  // Smaller face than the default warpSize: refinement evaluates at
  // REFINE_WARP=64 internally, and a face much larger than that downsamples
  // enough during search to blur the seam gradient the search needs.
  const SIZE = 48;

  it('recovers a quad perturbed by +/-4px per corner to within 2px, without lowering the score', () => {
    const img = makeFrame(200, 180, SIZE);
    const truth = faceQuad(SIZE);
    // fixed perturbation: enlarge the square by 4px on every side
    const perturbed: Quad = [
      [truth[0][0] - 4, truth[0][1] - 4],
      [truth[1][0] + 4, truth[1][1] - 4],
      [truth[2][0] + 4, truth[2][1] + 4],
      [truth[3][0] - 4, truth[3][1] + 4],
    ];
    const before = seamScore(img, perturbed, 96);
    const { quad: refined, seam } = refineQuad(img, perturbed);

    for (let i = 0; i < 4; i++) {
      expect(Math.abs(refined[i][0] - truth[i][0])).toBeLessThanOrEqual(2);
      expect(Math.abs(refined[i][1] - truth[i][1])).toBeLessThanOrEqual(2);
    }
    expect(seam.score).toBeGreaterThanOrEqual(before.score);
  });

  it('does not throw on a flat background and returns a well-formed result', () => {
    const img = flatFrame(200, 180);
    const result = refineQuad(img, faceQuad(SIZE));
    expect(result.quad).toHaveLength(4);
    expect(Number.isFinite(result.seam.score)).toBe(true);
    expect(Number.isFinite(result.seam.strength)).toBe(true);
  });
});

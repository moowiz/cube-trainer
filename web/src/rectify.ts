// Homography rectification (M6): warp a detected face quad to a square
// canvas so cells can be sampled on a regular grid. Pure functions on
// ImageData-like objects (unit-testable without a camera, per CLAUDE.md).
//
// Uses Heckbert's closed-form square->quad projective map (no linear solver
// needed for the 4-point case) and inverse bilinear sampling.

export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Quad = ReadonlyArray<readonly [number, number]>; // 4 corners, TL,TR,BR,BL

interface SquareToQuad {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

/** Projective map (u,v) in [0,1]^2 -> source pixels, corners TL,TR,BR,BL. */
export function squareToQuad(q: Quad): SquareToQuad {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [number, number][];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  };
}

export function mapUV(m: SquareToQuad, u: number, v: number): [number, number] {
  const w = m.g * u + m.h * v + 1;
  return [(m.a * u + m.b * v + m.c) / w, (m.d * u + m.e * v + m.f) / w];
}

/** Bilinear sample; clamps to the image border. Returns [r,g,b]. */
function sampleBilinear(img: ImageDataLike, x: number, y: number): [number, number, number] {
  const cx = Math.min(Math.max(x, 0), img.width - 1.001);
  const cy = Math.min(Math.max(y, 0), img.height - 1.001);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const fx = cx - x0, fy = cy - y0;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + img.width * 4;
  const i11 = i01 + 4;
  const d = img.data;
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    out[ch] =
      d[i00 + ch] * (1 - fx) * (1 - fy) + d[i10 + ch] * fx * (1 - fy) +
      d[i01 + ch] * (1 - fx) * fy + d[i11 + ch] * fx * fy;
  }
  return out;
}

/**
 * Warp the quad (TL,TR,BR,BL in the face's sticker orientation) to a
 * size x size RGBA buffer. Sampling reads the SOURCE image, so precision is
 * the camera's native resolution regardless of what the detector saw.
 */
export function warpQuad(img: ImageDataLike, quad: Quad, size = 90): ImageDataLike {
  const m = squareToQuad(quad);
  const data = new Uint8ClampedArray(size * size * 4);
  const inv = 1 / (size - 1);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const [sx, sy] = mapUV(m, px * inv, py * inv);
      const [r, g, b] = sampleBilinear(img, sx, sy);
      const o = (py * size + px) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** Cyclically rotate a quad k steps (corner i -> position i-k). */
export function rollQuad(quad: Quad, k: number): Quad {
  const n = ((k % 4) + 4) % 4;
  return quad.map((_, i) => quad[(i + n) % 4]);
}

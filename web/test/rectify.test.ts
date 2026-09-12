import { describe, expect, it } from 'vitest';
import { mapUV, rollQuad, squareToQuad, warpQuad, type ImageDataLike } from '../src/rectify';

function solid(width: number, height: number): ImageDataLike {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function paintRect(img: ImageDataLike, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
  }
}

function px(img: ImageDataLike, x: number, y: number): [number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

describe('squareToQuad', () => {
  it('maps unit-square corners exactly onto the quad, including perspective quads', () => {
    const quad = [[10, 12], [80, 8], [95, 70], [5, 60]] as const;
    const m = squareToQuad(quad);
    const uv: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    uv.forEach(([u, v], i) => {
      const [x, y] = mapUV(m, u, v);
      expect(x).toBeCloseTo(quad[i][0], 6);
      expect(y).toBeCloseTo(quad[i][1], 6);
    });
  });
});

describe('warpQuad', () => {
  it('brings each quadrant of a painted quad to the right output corner', () => {
    // axis-aligned square face at (20,20)-(60,60), quadrants distinct colors
    const img = solid(100, 100);
    paintRect(img, 20, 20, 40, 40, [255, 0, 0]);   // TL red
    paintRect(img, 40, 20, 60, 40, [0, 255, 0]);   // TR green
    paintRect(img, 40, 40, 60, 60, [0, 0, 255]);   // BR blue
    paintRect(img, 20, 40, 40, 60, [255, 255, 0]); // BL yellow
    const w = warpQuad(img, [[20, 20], [60, 20], [60, 60], [20, 60]], 40);
    expect(px(w, 8, 8)).toEqual([255, 0, 0]);
    expect(px(w, 31, 8)).toEqual([0, 255, 0]);
    expect(px(w, 31, 31)).toEqual([0, 0, 255]);
    expect(px(w, 8, 31)).toEqual([255, 255, 0]);
  });

  it('respects corner order: rolling the quad rotates the warped result', () => {
    const img = solid(100, 100);
    paintRect(img, 20, 20, 40, 40, [255, 0, 0]);
    paintRect(img, 40, 20, 60, 40, [0, 255, 0]);
    paintRect(img, 40, 40, 60, 60, [0, 0, 255]);
    paintRect(img, 20, 40, 40, 60, [255, 255, 0]);
    const rolled = rollQuad([[20, 20], [60, 20], [60, 60], [20, 60]], 1);
    const w = warpQuad(img, rolled, 40);
    // source TR (green) is now output TL
    expect(px(w, 8, 8)).toEqual([0, 255, 0]);
  });
});

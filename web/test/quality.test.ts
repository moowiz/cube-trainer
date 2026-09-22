// detect/quality.ts: the four tests the detection tick runs on every quad
// (too small, too dark, blown out, an obscured centre whose ring disagrees).
// Synthetic frames, so each rule can be triggered on its own.
import { describe, expect, it } from 'vitest';
import { MIN_FACE_EDGE_FRAC, minFaceEdgePx } from '../src/colour/patch';
import { quadQuality, quadsQuality, TOO_SMALL_REASON } from '../src/detect/quality';
import type { ImageDataLike } from '../src/rectify';

const W = 320;
const H = 240;

/** A grey frame with 3x3 sticker grids painted at the given boxes. `cells` is row-major; one colour fills all nine. */
function frameWith(faces: { x: number; y: number; s: number; cells: [number, number, number] | [number, number, number][] }[]): ImageDataLike {
  const data = new Uint8ClampedArray(W * H * 4).fill(90);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const { x, y, s, cells } of faces) {
    const cell = s / 3;
    for (let py = y; py < y + s; py++) {
      for (let px = x; px < x + s; px++) {
        const ci = Math.min(2, Math.floor((py - y) / cell)) * 3 + Math.min(2, Math.floor((px - x) / cell));
        const rgb = (typeof cells[0] === 'number' ? cells : (cells as [number, number, number][])[ci]!) as [number, number, number];
        const o = (py * W + px) * 4;
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
      }
    }
  }
  return { width: W, height: H, data };
}
const quadFor = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

// a readable face: nine ordinary sticker colours, the middle one green
const STICKERS: [number, number, number][] = [
  [226, 67, 60], [46, 108, 224], [245, 214, 61],
  [245, 143, 42], [51, 177, 93], [245, 143, 42],
  [46, 108, 224], [245, 214, 61], [226, 67, 60],
];

describe('quadQuality', () => {
  it('passes a face that is big enough, lit and unobstructed', () => {
    const q = quadQuality(frameWith([{ x: 100, y: 60, s: 90, cells: STICKERS }]), quadFor(100, 60, 90));
    expect(q.reason).toBeNull();
    expect(q.minEdgePx).toBeCloseTo(90, 6);
  });

  it('refuses a face blown out end to end by glare', () => {
    const q = quadQuality(frameWith([{ x: 100, y: 60, s: 90, cells: [255, 255, 255] }]), quadFor(100, 60, 90));
    expect(q.reason).toMatch(/glare/);
  });

  it('refuses a near-black, chroma-dead face', () => {
    const q = quadQuality(frameWith([{ x: 100, y: 60, s: 90, cells: [6, 6, 7] }]), quadFor(100, 60, 90));
    expect(q.reason).toMatch(/dark/);
  });

  it('returns one verdict per quad, in input order', () => {
    const frame = frameWith([
      { x: 20, y: 40, s: 80, cells: STICKERS },
      { x: 180, y: 40, s: 80, cells: [255, 255, 255] },
    ]);
    const got = quadsQuality(frame, [quadFor(20, 40, 80), quadFor(180, 40, 80)]);
    expect(got).toHaveLength(2);
    expect(got[0]!.reason).toBeNull();
    expect(got[1]!.reason).toMatch(/glare/);
  });
});

// The frame the tick judges is a letterboxed CROP: a face's size there says nothing about how far
// away the cube is. The gate is the quad's edge in SOURCE px against MIN_FACE_EDGE_FRAC of the
// source frame height.
describe('the size gate, in source px', () => {
  it('defaults to treating the frame as the source: the floor is 0.133 of its height', () => {
    expect(minFaceEdgePx(H)).toBeCloseTo(MIN_FACE_EDGE_FRAC * H, 6);
    const under = Math.floor(minFaceEdgePx(H)) - 3;   // 28 px on a 240-tall frame
    const over = Math.ceil(minFaceEdgePx(H)) + 3;
    const small = quadQuality(frameWith([{ x: 100, y: 60, s: under, cells: STICKERS }]), quadFor(100, 60, under));
    expect(small.reason).toMatch(new RegExp(TOO_SMALL_REASON));
    expect(small.minEdgePx).toBeCloseTo(under, 6);
    expect(quadQuality(frameWith([{ x: 100, y: 60, s: over, cells: STICKERS }]), quadFor(100, 60, over)).reason).toBeNull();
  });

  it('measures the quad in source px through the crop geometry', () => {
    // A 90 px face in a letterboxed crop of a 480x640 frame. At 1.5 model px per source px the
    // face is 60 source px: under the 85 px floor, refused. At 0.5 it is 180 source px: fine.
    const frame = frameWith([{ x: 100, y: 60, s: 90, cells: STICKERS }]);
    const zoomedIn = quadQuality(frame, quadFor(100, 60, 90), { srcPerPx: 1 / 1.5, sourceH: 640 });
    expect(zoomedIn.reason).toMatch(/need 85/);
    expect(zoomedIn.minEdgePx).toBeCloseTo(60, 6);
    const far = quadQuality(frame, quadFor(100, 60, 90), { srcPerPx: 2, sourceH: 640 });
    expect(far.reason).toBeNull();
    expect(far.minEdgePx).toBeCloseTo(180, 6);
  });
});

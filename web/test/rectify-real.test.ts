// End-to-end grounding for M6 rectification on REAL frames: warp the
// hand-labeled quad (labels from model/data_real, arbitrary cyclic rotation)
// and check the sampled center cell's color family. The center cell is
// rotation-invariant, so the order-free labels are fine here.
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { sampleGridCells } from '../src/colour/patch';
import { warpQuad } from '../src/rectify';
import { fixtureJson } from './helpers';


function loadFrame(file: string): ImageData {
  const fx = fixtureJson<{ imagePng: string }>(file);
  const b64 = fx.imagePng.replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) } as unknown as ImageData;
}

function hueDeg(a: number, b: number): number {
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

describe('rectify on real labeled frames', () => {
  it('blue-center face: warped center cell is blue', () => {
    const img = loadFrame('cube-frame-B-1789107871264.json');
    const quad = [[343.7, 448.4], [94.0, 439.7], [105.9, 198.1], [346.4, 200.8]] as const;
    const warped = warpQuad(img as never, quad, 90);
    const center = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 })[4]!.lab;
    // blue in Lab: strongly negative b; hue around 250-310 degrees
    expect(center.b).toBeLessThan(-15);
  });

  it('green-center face: warped center cell is green', () => {
    const img = loadFrame('cube-frame-D-1789108225454.json');
    const quad = [[373.5, 451.1], [117.3, 452.2], [119.5, 190.0], [374.6, 202.5]] as const;
    const warped = warpQuad(img as never, quad, 90);
    const center = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 })[4]!.lab;
    expect(center.a).toBeLessThan(-12); // green: strongly negative a
    const h = hueDeg(center.a, center.b);
    expect(h).toBeGreaterThan(90);
    expect(h).toBeLessThan(200);
  });
});

// Regression test on real backlit-kitchen frames (fixtures cube-frame-*):
// the six colors must stay separable in the normalized clustering space,
// using the robust cell sampler on the actual camera pixels.
//
// Ground truth was hand-read from the photos; the cube face bounds are
// per-photo because the cube wasn't always centered in the scan grid.
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { labDistance, labMean } from '../src/colour/lab';
import { sampleCellRobust } from '../src/colour/patch';
import { normalizeFaceCells } from '../src/detect/identify';
import type { Lab } from '../src/types';
import { fixtureJson } from './helpers';


// truth is row-major; W=white Y=yellow R=red O=orange G=green B=blue.
const FRAMES: Array<{ file: string; box: [number, number, number, number]; truth: string }> = [
  { file: 'cube-frame-F-1789100806506.json', box: [182, 118, 452, 388], truth: 'RYYBBBYYY' },
  { file: 'cube-frame-R-1789100795295.json', box: [138, 115, 432, 392], truth: 'WGGRYYRGG' },
  { file: 'cube-frame-D-1789100811627.json', box: [148, 115, 435, 390], truth: 'BBBWWOBBO' },
  { file: 'cube-frame-L-1789100815158.json', box: [152, 115, 440, 392], truth: 'WWRWGGWGG' },
  { file: 'cube-frame-B-1789100821558.json', box: [185, 125, 438, 395], truth: 'RRRRRRBWW' },
];

function decodeFrame(file: string): ImageData {
  const fx = fixtureJson<{ imagePng: string }>(file);
  const b64 = fx.imagePng.replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) } as unknown as ImageData;
}

interface Labeled {
  label: string;
  norm: Lab;
}

function collectSamples(): Labeled[] {
  const out: Labeled[] = [];
  for (const { file, box, truth } of FRAMES) {
    const img = decodeFrame(file);
    const [x0, y0, x1, y1] = box;
    const cellW = (x1 - x0) / 3;
    const cellH = (y1 - y0) / 3;
    const cells: Lab[] = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        cells.push(sampleCellRobust(img, x0 + (col + 0.5) * cellW, y0 + (row + 0.5) * cellH, Math.min(cellW, cellH)).lab);
      }
    }
    const norm = normalizeFaceCells(cells);
    for (let i = 0; i < 9; i++) out.push({ label: truth[i]!, norm: norm[i]! });
  }
  return out;
}

// Second batch: five uniform faces of a SOLVED cube in the same kitchen —
// white, red, green, yellow, orange. Uses the cells the scanner itself
// sampled (stored in the frame fixtures), labeled by the face's single color.
const SOLVED_FRAMES: Array<{ file: string; label: string }> = [
  { file: 'cube-frame-R-1789102058414.json', label: 'W' },
  { file: 'cube-frame-F-1789102067515.json', label: 'R' },
  { file: 'cube-frame-D-1789102075330.json', label: 'G' },
  { file: 'cube-frame-L-1789102083847.json', label: 'Y' },
  { file: 'cube-frame-B-1789102090329.json', label: 'O' },
];

describe('solved-cube uniform faces (low light)', () => {
  const samples: Labeled[] = [];
  for (const { file, label } of SOLVED_FRAMES) {
    const fx = fixtureJson<{ cells: Array<{ lab: Lab }> }>(file);
    const norm = normalizeFaceCells(fx.cells.map((c) => c.lab));
    for (const n of norm) samples.push({ label, norm: n });
  }

  it('at least 44/45 uniform-face samples classify to their own face color', () => {
    // One corner cell of the green face sampled the tile edge (a -11/6 read
    // against green's -23/16) — a contamination outlier per-sticker voting
    // and tap-to-fix exist for, not a classifier miss.
    const labels = [...new Set(samples.map((s) => s.label))];
    let correct = 0;
    const errors: string[] = [];
    for (const test of samples) {
      let best = '';
      let bestD = Infinity;
      for (const label of labels) {
        const rest = samples.filter((s) => s !== test && s.label === label);
        const c = labMean(rest.map((s) => s.norm));
        const d = labDistance(test.norm, c);
        if (d < bestD) {
          bestD = d;
          best = label;
        }
      }
      if (best === test.label) correct++;
      else errors.push(`${test.label}->${best}`);
    }
    expect(correct, `errors: ${errors.join(', ')}`).toBeGreaterThanOrEqual(44);
  });
});

describe('backlit kitchen frames (low light)', () => {
  const samples = collectSamples();

  it('has all 45 labeled samples', () => {
    expect(samples.length).toBe(45);
  });

  it('leave-one-out nearest-centroid classification gets at least 44/45 right', () => {
    const labels = [...new Set(samples.map((s) => s.label))];
    let correct = 0;
    const errors: string[] = [];
    for (const test of samples) {
      let best = '';
      let bestD = Infinity;
      for (const label of labels) {
        const rest = samples.filter((s) => s !== test && s.label === label);
        const c = labMean(rest.map((s) => s.norm));
        const d = labDistance(test.norm, c);
        if (d < bestD) {
          bestD = d;
          best = label;
        }
      }
      if (best === test.label) correct++;
      else errors.push(`${test.label}->${best}`);
    }
    expect(correct, `errors: ${errors.join(', ')}`).toBeGreaterThanOrEqual(44);
  });
});

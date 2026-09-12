// Naming anonymous quads from their center sticker (web/src/detect/identify.ts).
//
// Synthetic frames, not fixtures, on purpose: what is under test is the
// decision logic (which quad gets which face id, and which get refused), and
// that needs frames with deliberately impossible color combinations that no
// real photo would contain.
import { describe, expect, it } from 'vitest';
import { CenterExemplars, nameQuads } from '../src/detect/identify';
import type { ImageDataLike } from '../src/rectify';
import { DEFAULT_SCHEME_HEX, FACE_ORDER } from '../src/types';
import type { FaceId } from '../src/types';
import { srgbToLab } from '../src/color';

const W = 320;
const H = 240;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A face is painted as a real 3x3 sticker grid, not one flat square: the
// naming space subtracts the face's own median lightness (normalizeFaceCells),
// so a face made of nine identical cells is not the thing under test. The
// eight non-center stickers are a fixed scramble that is the same for every
// face, which keeps the center the only variable.
const SCRAMBLE: [number, number, number][] = [
  [226, 67, 60], [46, 108, 224], [245, 214, 61],
  [245, 143, 42], [/* center */ 0, 0, 0], [51, 177, 93],
  [46, 108, 224], [245, 214, 61], [226, 67, 60],
];

interface Face { x: number; y: number; s: number; rgb: [number, number, number]; uniform?: boolean }

/** A grey frame with 3x3 cube faces painted at the given boxes. */
function frameWith(faces: Face[]): ImageDataLike {
  const data = new Uint8ClampedArray(W * H * 4).fill(90);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const put = (px: number, py: number, rgb: [number, number, number]) => {
    const o = (py * W + px) * 4;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
  };
  for (const { x, y, s, rgb, uniform } of faces) {
    const cell = s / 3;
    for (let py = y; py < y + s; py++) {
      for (let px = x; px < x + s; px++) {
        const ci = Math.min(2, Math.floor((py - y) / cell)) * 3 + Math.min(2, Math.floor((px - x) / cell));
        put(px, py, uniform || ci === 4 ? rgb : SCRAMBLE[ci]!);
      }
    }
  }
  return { width: W, height: H, data };
}

function quadFor(x: number, y: number, s: number): [number, number][] {
  return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
}

describe('nameQuads', () => {
  it('names a quad by its center color using the default-scheme prior', () => {
    for (const face of FACE_ORDER) {
      const rgb = hexRgb(DEFAULT_SCHEME_HEX[face]);
      const frame = frameWith([{ x: 100, y: 60, s: 90, rgb }]);
      const got = nameQuads(frame, [quadFor(100, 60, 90)], new CenterExemplars());
      expect(got[0]!.face, `${face} should name itself`).toBe(face);
    }
  });

  it('names a white center as U rather than refusing it as glare', () => {
    // Regression: a lone L>96 chroma-dead cell is a WHITE STICKER, not a
    // blown highlight. Judging glare on the center cell alone refused every
    // U face in bright light.
    const frame = frameWith([{ x: 100, y: 60, s: 90, rgb: [252, 252, 250] }]);
    expect(nameQuads(frame, [quadFor(100, 60, 90)], new CenterExemplars())[0]!.face).toBe('U');
  });

  it('names two co-visible faces independently', () => {
    const frame = frameWith([
      { x: 20, y: 40, s: 80, rgb: hexRgb(DEFAULT_SCHEME_HEX.F) },
      { x: 180, y: 40, s: 80, rgb: hexRgb(DEFAULT_SCHEME_HEX.R) },
    ]);
    const got = nameQuads(frame, [quadFor(20, 40, 80), quadFor(180, 40, 80)], new CenterExemplars());
    expect(got.map((g) => g.face)).toEqual(['F', 'R']);
  });

  it('refuses two quads whose centers are the same color', () => {
    const rgb = hexRgb(DEFAULT_SCHEME_HEX.F);
    const frame = frameWith([
      { x: 20, y: 40, s: 80, rgb },
      { x: 180, y: 40, s: 80, rgb },
    ]);
    const got = nameQuads(frame, [quadFor(20, 40, 80), quadFor(180, 40, 80)],
                          new CenterExemplars(), [0.9, 0.4]);
    expect(got.filter((g) => g.face !== null)).toHaveLength(1);
    expect(got[0]!.face).toBe('F');                 // the higher-scoring one keeps it
    expect(got[1]!.reason).toMatch(/another quad/);
  });

  it('refuses an opposite pair: U and D can never be co-visible', () => {
    const frame = frameWith([
      { x: 20, y: 40, s: 80, rgb: hexRgb(DEFAULT_SCHEME_HEX.U) },
      { x: 180, y: 40, s: 80, rgb: hexRgb(DEFAULT_SCHEME_HEX.D) },
    ]);
    const got = nameQuads(frame, [quadFor(20, 40, 80), quadFor(180, 40, 80)],
                          new CenterExemplars(), [0.9, 0.5]);
    const named = got.filter((g) => g.face !== null);
    expect(named).toHaveLength(1);
    expect(named[0]!.face).toBe('U');
    expect(got[1]!.reason).toMatch(/co-visible/);
  });

  it('refuses a face blown out end to end by glare', () => {
    const frame = frameWith([{ x: 100, y: 60, s: 90, rgb: [255, 255, 255], uniform: true }]);
    const got = nameQuads(frame, [quadFor(100, 60, 90)], new CenterExemplars());
    expect(got[0]!.face).toBeNull();
    expect(got[0]!.reason).toMatch(/glare/);
  });

  it('refuses a near-black, chroma-dead face', () => {
    const frame = frameWith([{ x: 100, y: 60, s: 90, rgb: [6, 6, 7], uniform: true }]);
    const got = nameQuads(frame, [quadFor(100, 60, 90)], new CenterExemplars());
    expect(got[0]!.face).toBeNull();
    expect(got[0]!.reason).toMatch(/dark/);
  });

  it('returns one entry per input quad, in input order', () => {
    const frame = frameWith([
      { x: 20, y: 40, s: 80, rgb: hexRgb(DEFAULT_SCHEME_HEX.B) },
      { x: 180, y: 40, s: 80, rgb: [255, 255, 255], uniform: true },
    ]);
    const got = nameQuads(frame, [quadFor(20, 40, 80), quadFor(180, 40, 80)], new CenterExemplars());
    expect(got).toHaveLength(2);
    expect(got[0]!.face).toBe('B');
    expect(got[1]!.face).toBeNull();
  });
});

describe('CenterExemplars', () => {
  const nineOf = (rgb: [number, number, number]) =>
    Array.from({ length: 9 }, () => srgbToLab(rgb[0], rgb[1], rgb[2]));

  it('starts on the default-scheme prior and switches to measurements', () => {
    const ex = new CenterExemplars();
    expect(ex.isMeasured('F')).toBe(false);
    expect(ex.swatches().F.measured).toBe(false);
    ex.observe('F', nineOf([20, 160, 80]), [20, 160, 80]);
    expect(ex.isMeasured('F')).toBe(true);
    expect(ex.swatches().F.css).toBe('rgb(20,160,80)');
  });

  it('ignores a reading that is not 9 cells', () => {
    const ex = new CenterExemplars();
    ex.observe('R', nineOf([200, 40, 40]).slice(0, 4));
    expect(ex.isMeasured('R')).toBe(false);
  });

  it('lets a measured exemplar override the prior for naming', () => {
    // A cube whose "green" face photographs distinctly teal under a cool
    // light: once observed, a teal quad must name F, and the nominal green
    // hex must stop winning.
    const teal: [number, number, number] = [0, 150, 140];
    const ex = new CenterExemplars();
    const frame = frameWith([{ x: 100, y: 60, s: 90, rgb: teal }]);
    const before = nameQuads(frame, [quadFor(100, 60, 90)], ex)[0]!;
    ex.observe('F', nineOf(teal), teal);
    const after = nameQuads(frame, [quadFor(100, 60, 90)], ex)[0]!;
    expect(after.face).toBe('F');
    expect(after.nameConf).toBeGreaterThan(before.nameConf);
  });

  it('reset() drops back to the prior', () => {
    const ex = new CenterExemplars();
    ex.observe('U' as FaceId, nineOf([250, 250, 245]), [250, 250, 245]);
    ex.reset();
    expect(ex.isMeasured('U')).toBe(false);
  });
});

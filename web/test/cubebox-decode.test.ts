// Stage-1 output decode: 5 logits -> objectness + box in source px. The
// arithmetic must invert the letterbox exactly, for both the portrait phone
// frame (fills the canvas) and a landscape desktop frame (top/bottom bars).
import { describe, expect, it } from 'vitest';
import { decodeBox } from '../src/detect/cubebox';
import { letterbox, type Box } from '../src/detect/geometry';

const logit = (p: number) => Math.log(p / (1 - p));
const IW = 120, IH = 160;

/** The logits a perfect model would emit for `box` (source px) in a `fullW x fullH` frame. */
function logitsFor(box: Box, fullW: number, fullH: number, obj = 0.9): number[] {
  const lb = letterbox(fullW, fullH, IW, IH);
  const [u0, v0] = lb.toModel(box[0], box[1]);
  const [u1, v1] = lb.toModel(box[2], box[3]);
  return [logit(obj), logit((u0 + u1) / 2 / IW), logit((v0 + v1) / 2 / IH), logit((u1 - u0) / IW), logit((v1 - v0) / IH)];
}

describe('decodeBox', () => {
  it('round-trips a box on a portrait phone frame (no bars)', () => {
    const box: Box = [100, 220, 300, 430];
    const hit = decodeBox(logitsFor(box, 480, 640), IW, IH, letterbox(480, 640, IW, IH));
    expect(hit.obj).toBeCloseTo(0.9, 6);
    hit.box.forEach((v, i) => expect(v).toBeCloseTo(box[i], 6));
  });

  it('round-trips a box on a landscape desktop frame through the top/bottom bars', () => {
    const box: Box = [250, 90, 420, 260];
    const lb = letterbox(640, 480, IW, IH);
    expect(lb.dy).toBeGreaterThan(0); // bars are in play
    const hit = decodeBox(logitsFor(box, 640, 480), IW, IH, lb);
    hit.box.forEach((v, i) => expect(v).toBeCloseTo(box[i], 6));
  });

  it('reports objectness as a probability and leaves the threshold to the caller', () => {
    const hit = decodeBox([logit(0.2), 0, 0, 0, 0], IW, IH, letterbox(480, 640, IW, IH));
    expect(hit.obj).toBeCloseTo(0.2, 6);
    // zero logits = a box centred on the canvas, half its size
    expect(hit.box[0]).toBeCloseTo(480 * 0.25, 6);
    expect(hit.box[3]).toBeCloseTo(640 * 0.75, 6);
  });
});

// M7 any-order voting: synthetic Lab observations converge to a locked,
// cubejs-valid state; glare samples are dropped; partial coverage never locks.
import { describe, expect, it } from 'vitest';
import { isGlareSample, StickerVoter, type FaceObservation } from '../src/assembly';
import { FACE_ORDER } from '../src/types';
import type { FaceId, Lab } from '../src/types';

// distinct, realistic Lab palette per face color
const PALETTE: Record<FaceId, Lab> = {
  U: { L: 90, a: 0, b: 4 },     // white
  R: { L: 45, a: 55, b: 35 },   // red
  F: { L: 52, a: -48, b: 40 },  // green
  D: { L: 85, a: -6, b: 62 },   // yellow
  L: { L: 62, a: 38, b: 58 },   // orange
  B: { L: 36, a: 10, b: -46 },  // blue
};

// deterministic small noise
function noisy(base: Lab, seed: number): Lab {
  const j = (n: number) => ((seed * 37 + n * 101) % 7) - 3;
  return { L: base.L + j(1) * 0.7, a: base.a + j(2) * 0.7, b: base.b + j(3) * 0.7 };
}

function solvedObservation(face: FaceId, seed: number): FaceObservation {
  return { face, conf: 0.95, cells: Array.from({ length: 9 }, (_, i) => noisy(PALETTE[face], seed + i)) };
}

describe('StickerVoter', () => {
  it('locks a solved cube after enough frames, all faces any order', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 8; frame++) {
      // two faces per frame, cycling - never all at once (any-order scanning)
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      v.addFrame([solvedObservation(a, frame), solvedObservation(b, frame + 50)]);
    }
    // not yet: some faces have < MIN_SAMPLES
    expect(v.progress().locked).toBeNull();
    for (let frame = 8; frame < 40 && !v.progress().locked; frame++) {
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      v.addFrame([solvedObservation(a, frame), solvedObservation(b, frame + 50)]);
    }
    const p = v.progress();
    expect(p.locked).not.toBeNull();
    expect(p.locked!.facelets).toBe('UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB');
    expect(p.validationError).toBeNull();
  });

  it('never locks while a face is missing', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 60; frame++) {
      const a = FACE_ORDER[frame % 5]!; // B never observed
      v.addFrame([solvedObservation(a, frame)]);
    }
    const p = v.progress();
    expect(p.locked).toBeNull();
    expect(p.faceFill.B).toBe(0);
    expect(p.faceFill.U).toBe(1);
  });

  it('drops glare samples instead of letting them poison a cell', () => {
    expect(isGlareSample({ L: 99, a: 1, b: 2 })).toBe(true);
    expect(isGlareSample({ L: 90, a: 0, b: 4 })).toBe(false); // plain white sticker keeps its chroma-free look but L is lower
    const v = new StickerVoter();
    for (let frame = 0; frame < 40 && !v.progress().locked; frame++) {
      const obs = [solvedObservation(FACE_ORDER[frame % 6]!, frame), solvedObservation(FACE_ORDER[(frame + 3) % 6]!, frame + 9)];
      // every R-face frame additionally reports cell 0 as blown-out glare
      if (obs[0].face === 'R') obs[0].cells[0] = { L: 99.5, a: 0.5, b: 1 };
      v.addFrame(obs);
    }
    const p = v.progress();
    expect(p.locked).not.toBeNull();
    expect(p.locked!.facelets[9]).toBe('R'); // R cell 0 classified from the clean samples only
  });

  it('ignores low-confidence observations', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 60; frame++) {
      v.addFrame(FACE_ORDER.map((f) => ({ ...solvedObservation(f, frame), conf: 0.2 })));
    }
    expect(v.progress().locked).toBeNull();
    expect(v.progress().faceFill.U).toBe(0);
  });
});

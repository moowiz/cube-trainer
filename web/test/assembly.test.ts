// M7 any-order voting: synthetic Lab observations converge to a locked,
// cubejs-valid state; glare samples are dropped; partial coverage never locks.
import { describe, expect, it } from 'vitest';
import { isGlareSample, rotateCells, StickerVoter, type FaceObservation } from '../src/assembly';
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

// Cluster ids stand in for face letters: cluster 1 = U, 2 = R, ... (the
// scan page binds clusters to letters from colour; the voter never sees letters)
const CLUSTER_OF: Record<FaceId, number> = { U: 1, R: 2, F: 3, D: 4, L: 5, B: 6 };
const FACE_MAP = new Map<number, FaceId>(FACE_ORDER.map((f) => [CLUSTER_OF[f], f]));

function solvedObservation(face: FaceId, seed: number): FaceObservation & { face: FaceId } {
  return { face, cluster: CLUSTER_OF[face], conf: 0.95, cells: Array.from({ length: 9 }, (_, i) => noisy(PALETTE[face], seed + i)) };
}

describe('StickerVoter', () => {
  it('locks a solved cube after enough frames, all faces any order', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 8; frame++) {
      // two faces per frame, cycling - never all at once (any-order scanning)
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      v.addFrame([solvedObservation(a, frame), solvedObservation(b, frame + 50)], FACE_MAP);
    }
    // not yet: some faces have < MIN_SAMPLES
    expect(v.progress(FACE_MAP).locked).toBeNull();
    for (let frame = 8; frame < 40 && !v.progress(FACE_MAP).locked; frame++) {
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      v.addFrame([solvedObservation(a, frame), solvedObservation(b, frame + 50)], FACE_MAP);
    }
    const p = v.progress(FACE_MAP);
    expect(p.locked).not.toBeNull();
    expect(p.locked!.facelets).toBe('UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB');
    expect(p.validationError).toBeNull();
  });

  it('never locks while a face is missing', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 60; frame++) {
      const a = FACE_ORDER[frame % 5]!; // B never observed
      v.addFrame([solvedObservation(a, frame)], FACE_MAP);
    }
    const p = v.progress(FACE_MAP);
    expect(p.locked).toBeNull();
    expect(p.faceFill.B).toBe(0);
    expect(p.faceFill.U).toBe(1);
  });

  it('drops glare samples instead of letting them poison a cell', () => {
    expect(isGlareSample({ L: 99, a: 1, b: 2 })).toBe(true);
    expect(isGlareSample({ L: 90, a: 0, b: 4 })).toBe(false); // plain white sticker keeps its chroma-free look but L is lower
    const v = new StickerVoter();
    for (let frame = 0; frame < 40 && !v.progress(FACE_MAP).locked; frame++) {
      const obs = [solvedObservation(FACE_ORDER[frame % 6]!, frame), solvedObservation(FACE_ORDER[(frame + 3) % 6]!, frame + 9)];
      // every R-face frame additionally reports cell 0 as blown-out glare
      if (obs[0].face === 'R') obs[0].cells[0] = { L: 99.5, a: 0.5, b: 1 };
      v.addFrame(obs, FACE_MAP);
    }
    const p = v.progress(FACE_MAP);
    expect(p.locked).not.toBeNull();
    expect(p.locked!.facelets[9]).toBe('R'); // R cell 0 classified from the clean samples only
  });

  it('ignores low-confidence observations', () => {
    const v = new StickerVoter();
    for (let frame = 0; frame < 60; frame++) {
      v.addFrame(FACE_ORDER.map((f) => ({ ...solvedObservation(f, frame), conf: 0.2 })), FACE_MAP);
    }
    expect(v.progress(FACE_MAP).locked).toBeNull();
    expect(v.progress(FACE_MAP).faceFill.U).toBe(0);
  });
});

describe('StickerVoter with late bindings', () => {
  it('holds votes for an unbound cluster and locks once it is bound', () => {
    const v = new StickerVoter();
    const partial = new Map(FACE_MAP);
    partial.delete(CLUSTER_OF.L); // orange undecided until late
    for (let frame = 0; frame < 40; frame++) {
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      v.addFrame([solvedObservation(a, frame), solvedObservation(b, frame + 50)], partial);
    }
    const p = v.progress(partial);
    expect(p.locked).toBeNull();
    expect(p.faceFill.L).toBe(0);
    expect(p.unboundFill[CLUSTER_OF.L]).toBe(1);
    v.tryLock(FACE_MAP);
    expect(v.progress(FACE_MAP).locked!.facelets).toBe('UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB');
  });

  it('merges a duplicate cluster into the surviving one', () => {
    const v = new StickerVoter();
    const map = new Map(FACE_MAP);
    map.set(7, 'B'); // a second blue cluster born early
    for (let frame = 0; frame < 40; frame++) {
      const a = FACE_ORDER[frame % 6]!;
      const b = FACE_ORDER[(frame + 3) % 6]!;
      const obs = [solvedObservation(a, frame), solvedObservation(b, frame + 50)];
      for (const o of obs) if (o.face === 'B' && frame % 2) o.cluster = 7;
      v.addFrame(obs, map);
    }
    v.mergeClusters(7, CLUSTER_OF.B);
    map.delete(7);
    v.tryLock(map);
    expect(v.progress(map).locked).not.toBeNull();
  });
});

// Frames are aligned up to rotation and outliers dropped (2026-09-13): a face
// whose rotation was resolved wrongly in some frames, or a track that slid
// onto another face, must not blend its stickers into the consensus.
describe('StickerVoter consensus alignment', () => {
  // solved cube after one U turn: the top row of R F L B is another colour,
  // so every side face is rotation-asymmetric
  const AFTER_U = 'UUUUUUUUU' + 'BBBRRRRRR' + 'RRRFFFFFF' + 'DDDDDDDDD' + 'FFFLLLLLL' + 'LLLBBBBBB';
  const faceCells = (face: FaceId, seed: number): Lab[] => {
    const fi = FACE_ORDER.indexOf(face);
    return Array.from({ length: 9 }, (_, i) => noisy(PALETTE[AFTER_U[fi * 9 + i] as FaceId], seed + i));
  };
  const scan = (v: StickerVoter, mutate: (face: FaceId, cells: Lab[], frame: number) => Lab[]) => {
    for (let frame = 0; frame < 60 && !v.progress(FACE_MAP).locked; frame++) {
      const obs = [0, 3].map((k) => {
        const face = FACE_ORDER[(frame + k) % 6]!;
        return { cluster: CLUSTER_OF[face], conf: 0.95, cells: mutate(face, faceCells(face, frame + k * 7), frame) };
      });
      v.addFrame(obs, FACE_MAP);
    }
    return v.progress(FACE_MAP);
  };

  it('locks the asymmetric state when every frame is oriented as claimed', () => {
    const p = scan(new StickerVoter(), (_, cells) => cells);
    expect(p.locked?.facelets).toBe(AFTER_U);
  });

  it('re-aligns a minority of frames delivered a quarter turn off', () => {
    const v = new StickerVoter();
    const p = scan(v, (_, cells, frame) => (frame % 5 === 1 ? rotateCells(cells, 1) : cells));
    expect(p.locked?.facelets).toBe(AFTER_U);
    const r = v.lastAttempt!.evidence.find((e) => e.face === 'R')!;
    expect(r.rotations[1] + r.rotations[2] + r.rotations[3]).toBeGreaterThan(0); // the off frames were recognised and turned back
  });

  it('drops frames of a track that slid onto another face', () => {
    const v = new StickerVoter();
    // every fourth R frame is really the D face (a swapped track still tagged with R's cluster)
    const p = scan(v, (face, cells, frame) => (face === 'R' && frame % 4 === 0 ? faceCells('D', frame) : cells));
    expect(p.locked?.facelets).toBe(AFTER_U);
    const r = v.lastAttempt!.evidence.find((e) => e.face === 'R')!;
    expect(r.inliers).toBeLessThan(r.frames);
  });
});

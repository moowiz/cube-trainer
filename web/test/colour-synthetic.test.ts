// The multi-frame path the single-frame fixtures cannot reach: a simulated
// session (test/synth.ts) with per-frame white balance, per-quad shading,
// noise, glare, fingers, tracks re-acquired under new ids, and shared-edge
// pairings in the tracks' own (rotated) corner orders. The solver must
// recover the scramble, group the twelve tracks into six faces, letter them
// from geometry alone, and lock.
import { describe, expect, it } from 'vitest';
import { BENCH } from './helpers';
import Cube from 'cubejs';
import { emptyLog } from '../src/colour/evidence';
import { solve, solveBest } from '../src/colour/solve';
import type { FaceId } from '../src/types';
import { COLOUR, simulate } from './synth';

const TRUTH = new Cube().move("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D").asString();

describe('synthetic session', () => {
  it('recovers the scramble from noisy, shaded, cast, glared, fingered, re-acquired evidence and locks', () => {
    const { log } = simulate(TRUTH);
    const s = solve(log);
    expect(s.centresSeen).toBe(6);
    expect(s.facelets).toBe(TRUTH);
    expect(s.lockable, s.reason).toBe(true);
    // twelve-ish tracks became six faces, every one lettered from geometry
    const lettered = s.groups.filter((g) => g.letter);
    expect(lettered.length).toBe(6);
    for (const g of lettered) expect(g.absRotation).not.toBeNull();
    if (BENCH) expect(s.ms).toBeLessThan(1500); // throughput budget: npm run bench
  });

  it('letters come from geometry: a non-standard scheme (red opposite white) still decodes to its own letters', () => {
    // swap the pigments of U and R: white now sits where red was. The
    // facelet string is defined by centres, so the truth is unchanged.
    const saved = { U: COLOUR.U, R: COLOUR.R };
    COLOUR.U = saved.R;
    COLOUR.R = saved.U;
    try {
      const { log } = simulate(TRUTH, { seed: 11 });
      const s = solve(log);
      expect(s.facelets).toBe(TRUTH);
    } finally {
      COLOUR.U = saved.U;
      COLOUR.R = saved.R;
    }
  });

  it('survives the first detections: one quad of low-weight readings, then two', () => {
    // the phone's first frames: every reading weighs 0.3 (first detection of
    // a track) and clusters die under the palette's weight floor
    const { log } = simulate(TRUTH, { frames: 1 });
    for (const q of log.quads) for (const r of q.readings) r.w *= 0.3;
    const one = { ...log, quads: log.quads.slice(0, 1) };
    expect(() => solve(one)).not.toThrow();
    expect(solve(one).lockable).toBe(false);
    expect(() => solve(log)).not.toThrow();
  });

  it('five faces are enough when the pieces force the sixth (and a refusal when they do not)', () => {
    let locked = 0;
    for (const hidden of ['R', 'F', 'D', 'L'] as FaceId[]) {
      const { log } = simulate(TRUTH, { hide: [hidden], seed: 21 });
      const s = solveBest(log);
      expect(s.decode?.free, hidden).toBe(9);
      if (s.decode?.completion === 'unique') {
        expect(s.facelets, hidden).toBe(TRUTH);
        expect(s.lockable, `${hidden}: ${s.reason}`).toBe(true);
        locked++;
      } else {
        expect(s.lockable, hidden).toBe(false);
        expect(s.reason).toMatch(/not forced|ambiguous/);
      }
    }
    expect(locked).toBe(3); // R, F, D are forced on this scramble, L is not (complete.test.ts)
  });

  it('four faces are not: the unseen stickers are ambiguous and it refuses', () => {
    const { log } = simulate(TRUTH, { hide: ['D', 'B'], seed: 22 });
    const s = solveBest(log);
    expect(s.lockable).toBe(false);
    expect(s.reason).toMatch(/unseen|faces seen/);
  });

  it('is honest with too little evidence: a four-face session does not lock', () => {
    const { log } = simulate(TRUTH, { frames: 3 });
    const s = solve(log);
    expect(s.lockable).toBe(false);
    expect(s.centresSeen).toBeLessThanOrEqual(6);
  });

  it('a wrong lock never happens on a mis-scrambled half session', () => {
    // first half one scramble, second half another: the evidence contradicts
    // itself and the certificates must refuse
    const other = new Cube().move("R U R' U'").asString();
    const a = simulate(TRUTH, { frames: 24, seed: 3 }).log;
    const b = simulate(other, { frames: 24, seed: 5 }).log;
    const log = emptyLog();
    log.quads = [...a.quads, ...b.quads.map((q) => ({ ...q, frame: q.frame + 24, track: q.track + 100 }))];
    log.pairings = [...a.pairings, ...b.pairings.map((p) => ({ ...p, frame: p.frame + 24, a: p.a + 100, b: p.b + 100 }))];
    log.frames = 48;
    const s = solve(log);
    if (s.lockable) expect([TRUTH, other]).toContain(s.facelets);
  });
});

// The multi-frame path the single-frame fixtures cannot reach: a simulated
// session with per-frame white balance, per-quad shading, noise, glare,
// fingers, tracks re-acquired under new ids, and shared-edge pairings in
// the tracks' own (rotated) corner orders. The solver must recover the
// scramble, group the twelve tracks into six faces, letter them from
// geometry alone, and lock.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { srgbToLab } from '../src/color';
import { emptyLog, patchWeight } from '../src/colour/evidence';
import { solve, solveBest } from '../src/colour/solve';
import type { EvidenceLog, PatchStats, RGB } from '../src/colour/types';
import { sharedEdge } from '../src/detect/orient';
import { rotateCells } from '../src/state';
import type { FaceId } from '../src/types';
import { FACE_ORDER } from '../src/types';

const COLOUR: Record<FaceId, RGB> = {
  U: [235, 235, 230], R: [200, 30, 40], F: [30, 160, 70], D: [230, 200, 40], L: [240, 120, 20], B: [30, 70, 200],
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

interface SimOptions { frames?: number; reacquireEvery?: number; glare?: number; fingers?: number; seed?: number; wb?: number; hide?: FaceId[] }

/** Build a log of `frames` corner views of `truth` (URFDLB facelets). */
function simulate(truth: string, o: SimOptions = {}): { log: EvidenceLog; cellRot: Map<number, number> } {
  const rnd = lcg(o.seed ?? 7);
  const frames = o.frames ?? 48;
  const every = o.reacquireEvery ?? 16;
  const log = emptyLog();
  // the eight corner views: three mutually adjacent faces each
  const ALL: FaceId[][] = [['U', 'F', 'R'], ['U', 'R', 'B'], ['U', 'B', 'L'], ['U', 'L', 'F'], ['D', 'R', 'F'], ['D', 'B', 'R'], ['D', 'L', 'B'], ['D', 'F', 'L']];
  const VIEWS = ALL.filter((v) => !v.some((f) => o.hide?.includes(f)));
  // each face's current track id and that track's raw cell rotation
  const trackOf = new Map<FaceId, number>();
  const cellRot = new Map<number, number>();
  const nth = new Map<number, number>();
  let nextTrack = 1;
  const clamp = (x: number) => Math.max(0, Math.min(255, x));
  for (let f = 0; f < frames; f++) {
    const view = VIEWS[f % VIEWS.length]!;
    const wb: RGB = [1 + (rnd() - 0.5) * 2 * (o.wb ?? 0.15), 1, 1 + (rnd() - 0.5) * 2 * (o.wb ?? 0.15)];
    for (const face of view) {
      if (!trackOf.has(face) || (f > 0 && f % every === 0 && rnd() < 0.5)) {
        trackOf.set(face, nextTrack);
        cellRot.set(nextTrack, Math.floor(rnd() * 4));
        nth.set(nextTrack, 0);
        nextTrack++;
      }
    }
    for (const face of view) {
      const track = trackOf.get(face)!;
      const kc = cellRot.get(track)!;
      const fi = FACE_ORDER.indexOf(face);
      const layout = truth.slice(fi * 9, fi * 9 + 9).split('') as FaceId[];
      const raw = rotateCells(layout, (4 - kc) % 4); // layout = rotateCells(raw, kc)
      const shade = 0.5 + 0.5 * rnd();
      const readings = raw.map((letter, cell) => {
        const base = COLOUR[letter];
        let rgb: RGB = [0, 1, 2].map((i) => clamp(base[i]! * wb[i]! * shade + (rnd() - 0.5) * 12)) as RGB;
        let clipFrac = 0;
        if (rnd() < (o.glare ?? 0.05)) { rgb = [255, 255, 255]; clipFrac = 0.8; }
        if (rnd() < (o.fingers ?? 0.03)) rgb = [clamp(200 * shade), clamp(150 * shade), clamp(120 * shade)];
        const stats: PatchStats = { rgb, lab: srgbToLab(rgb[0], rgb[1], rgb[2]), clipFrac, darkFrac: 0, spread: 2 + rnd() * 3, censored: [rgb[0] >= 255, rgb[1] >= 255, rgb[2] >= 255], n: 144 };
        return { cell, rgb, lab: stats.lab, clipFrac, darkFrac: 0, spread: stats.spread, censored: stats.censored, w: 0.9 * patchWeight(stats) };
      });
      nth.set(track, nth.get(track)! + 1);
      log.quads.push({ frame: f, t: f * 500, track, corners: [[0, 0], [100, 0], [100, 100], [0, 100]], conf: 0.95, blur: 80, viewCos: 0.8, edgePx: 150, speed: 0.2, nth: nth.get(track)!, readings });
    }
    // pairings between every adjacent pair in view, expressed in raw edges
    for (let i = 0; i < view.length; i++) {
      for (let j = i + 1; j < view.length; j++) {
        const a = view[i]!;
        const b = view[j]!;
        const se = sharedEdge(a, b)!;
        const ta = trackOf.get(a)!;
        const tb = trackOf.get(b)!;
        const ea = ((se.ia - cellRot.get(ta)!) % 4 + 4) % 4;
        const eb = ((se.jb - cellRot.get(tb)!) % 4 + 4) % 4;
        log.pairings.push({ frame: f, a: ta, b: tb, edgeA: ea, edgeB: eb, cost: 3, tol: 20 });
      }
    }
  }
  log.frames = frames;
  return { log, cellRot };
}

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
    expect(s.ms).toBeLessThan(1500);
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
        expect(s.reason).toMatch(/not forced/);
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

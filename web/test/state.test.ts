import { describe, it, expect } from 'vitest';
import Cube from 'cubejs';
import { FACE_ORDER } from '../src/types';
import type { FaceId, Lab } from '../src/types';
import {
  FaceStabilizer,
  assembleState,
  validateState,
  solveState,
  inverseMoves,
  type FaceCapture,
} from '../src/state';

// scrambledFacelets() below calls Cube.scramble(), which (per cubejs) solves
// internally to build a scramble — it needs the solver tables just like
// solveState's fallback path does. Pay the ~1s cost once, up front.
Cube.initSolver();

// ---------- helpers ----------

function lab(L: number, a: number, b: number): Lab {
  return { L, a, b };
}

/** Deterministic PRNG (mulberry32) so jitter is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** Default well-separated synthetic palette (rough white/red/green/yellow/orange/blue). */
const DEFAULT_BASE: Record<FaceId, Lab> = {
  U: lab(92, 0, 2),
  R: lab(45, 65, 45),
  F: lab(52, -60, 35),
  D: lab(87, -3, 75),
  L: lab(62, 45, 65),
  B: lab(32, 15, -60),
};

/**
 * Build 6 FaceCaptures from a 54-char facelet string, mapping each letter to
 * a base Lab color plus small deterministic jitter. `overrides` lets a test
 * force specific cells (e.g. two centers) to exact colors with no jitter.
 */
function buildCaptures(
  facelets: string,
  base: Record<FaceId, Lab>,
  jitterMag: number,
  seed = 1,
  overrides: Partial<Record<FaceId, Partial<Record<number, Lab>>>> = {}
): FaceCapture[] {
  const rng = mulberry32(seed);
  const jitter = () => (rng() - 0.5) * 2 * jitterMag;
  const captures: FaceCapture[] = [];
  for (let f = 0; f < FACE_ORDER.length; f++) {
    const face = FACE_ORDER[f]!;
    const cells: Lab[] = [];
    for (let c = 0; c < 9; c++) {
      const override = overrides[face]?.[c];
      if (override) {
        cells.push({ ...override });
        continue;
      }
      const letter = facelets[f * 9 + c] as FaceId;
      const b = base[letter];
      cells.push({ L: b.L + jitter(), a: b.a + jitter(), b: b.b + jitter() });
    }
    captures.push({ face, cells });
  }
  return captures;
}

function scrambledFacelets(): string {
  const cube = new Cube();
  cube.move(Cube.scramble());
  return cube.asString();
}

/** Rotate three facelet positions cyclically: idxs[0]<-idxs[2], idxs[1]<-idxs[0], idxs[2]<-idxs[1]. */
function rotateThree(facelets: string, idxs: readonly [number, number, number]): string {
  const chars = facelets.split('');
  const [a, b, c] = idxs;
  const va = chars[a]!;
  const vb = chars[b]!;
  const vc = chars[c]!;
  chars[a] = vc;
  chars[b] = va;
  chars[c] = vb;
  return chars.join('');
}

function swapChars(facelets: string, i: number, j: number): string {
  const chars = facelets.split('');
  const tmp = chars[i]!;
  chars[i] = chars[j]!;
  chars[j] = tmp;
  return chars.join('');
}

// ---------- FaceStabilizer ----------

describe('FaceStabilizer', () => {
  it('becomes stable only after N consistent frames', () => {
    const s = new FaceStabilizer({ stableFrames: 3, maxCellDrift: 6, minStableMs: 0 });
    const frame = new Array(9).fill(0).map(() => lab(50, 0, 0));

    let r = s.push(frame); // frame 1: no previous, counter stays 0
    expect(r.stable).toBe(false);
    r = s.push(frame); // frame 2: consistent, counter=1
    expect(r.stable).toBe(false);
    r = s.push(frame); // frame 3: consistent, counter=2
    expect(r.stable).toBe(false);
    expect(r.progress).toBeCloseTo(2 / 3, 5);
    r = s.push(frame); // frame 4: consistent, counter=3 >= stableFrames
    expect(r.stable).toBe(true);
    expect(r.progress).toBe(1);
  });

  it('a jumpy frame resets progress', () => {
    const s = new FaceStabilizer({ stableFrames: 3, maxCellDrift: 6, minStableMs: 0 });
    const frame = new Array(9).fill(0).map(() => lab(50, 0, 0));
    s.push(frame);
    let r = s.push(frame); // counter=1
    expect(r.progress).toBeGreaterThan(0);

    const jumpy = frame.map((c, i) => (i === 0 ? lab(c.L + 50, c.a, c.b) : c));
    r = s.push(jumpy); // big drift on cell 0 -> reset
    expect(r.stable).toBe(false);
    expect(r.progress).toBe(0);

    // jumpy frame becomes the new reference: a consistent frame afterwards increments again
    r = s.push(jumpy);
    expect(r.progress).toBeCloseTo(1 / 3, 5);
  });

  it('holds back until minStableMs of wall-clock stability has passed', () => {
    const s = new FaceStabilizer({ stableFrames: 3, maxCellDrift: 6, minStableMs: 700 });
    const frame = new Array(9).fill(0).map(() => lab(50, 0, 0));
    // 60fps-style timestamps: frame gate satisfied long before the time gate
    let t = 1000;
    let r = s.push(frame, t);
    for (let i = 0; i < 10; i++) r = s.push(frame, (t += 16));
    expect(r.stable).toBe(false); // ~160ms elapsed, counter=10 >= 3
    expect(r.progress).toBeLessThan(0.5);
    while (t < 1000 + 700) r = s.push(frame, (t += 16));
    expect(r.stable).toBe(true);
    // ...and a drift resets the clock, not just the counter
    const jumpy = frame.map((c, i) => (i === 0 ? lab(c.L + 50, c.a, c.b) : c));
    r = s.push(jumpy, (t += 16));
    expect(r.moved).toBe(true);
    for (let i = 0; i < 10; i++) r = s.push(jumpy, (t += 16));
    expect(r.stable).toBe(false);
  });

  it('reports moved only when a frame breaks consistency', () => {
    const s = new FaceStabilizer({ stableFrames: 3, maxCellDrift: 6, minStableMs: 0 });
    const frame = new Array(9).fill(0).map(() => lab(50, 0, 0));
    expect(s.push(frame).moved).toBe(false); // first frame: nothing to compare
    expect(s.push(frame).moved).toBe(false);
    const jumpy = frame.map((c, i) => (i === 0 ? lab(c.L + 50, c.a, c.b) : c));
    expect(s.push(jumpy).moved).toBe(true);
    expect(s.push(jumpy).moved).toBe(false); // consistent with the new reference
  });

  it('result() is a sensible median, robust to one outlier frame', () => {
    const s = new FaceStabilizer({ stableFrames: 8, maxCellDrift: 1000 }); // drift irrelevant here
    const mk = (l0: number) => {
      const cells = new Array(9).fill(0).map(() => lab(10, 0, 0));
      cells[0] = lab(l0, 0, 0);
      return cells;
    };
    s.push(mk(10));
    s.push(mk(10));
    s.push(mk(10));
    s.push(mk(100)); // outlier
    s.push(mk(10));

    const result = s.result();
    expect(result[0]!.L).toBe(10); // median of [10,10,10,100,10] discards the outlier
    expect(result[1]!.L).toBe(10);
  });

  it('reset() clears the buffer and counter', () => {
    const s = new FaceStabilizer({ stableFrames: 2 });
    const frame = new Array(9).fill(0).map(() => lab(20, 0, 0));
    s.push(frame);
    s.push(frame);
    s.reset();
    expect(() => s.result()).toThrow();
    const r = s.push(frame);
    expect(r.progress).toBeLessThan(1);
  });
});

// ---------- assembleState ----------

describe('assembleState', () => {
  it('round-trips a scrambled facelet string through synthetic colors', () => {
    const facelets = scrambledFacelets();
    // Captures given out of FACE_ORDER order, to exercise "any order" support.
    const shuffledOrder: FaceId[] = ['F', 'U', 'B', 'D', 'L', 'R'];
    const all = buildCaptures(facelets, DEFAULT_BASE, 1.5, 42);
    const captures = shuffledOrder.map((f) => all.find((c) => c.face === f)!);

    const result = assembleState(captures);

    expect(result.facelets).toBe(facelets);
    expect(result.confidences).toHaveLength(54);
    for (const conf of result.confidences) {
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    }
    for (const face of FACE_ORDER) {
      expect(result.centroids[face]).toBeDefined();
    }
    expect(Object.keys(result.centroids).sort()).toEqual([...FACE_ORDER].sort());
  });

  it('separates close red/orange colors thanks to center seeding', () => {
    const facelets = scrambledFacelets();
    const base: Record<FaceId, Lab> = {
      ...DEFAULT_BASE,
      R: lab(45, 60, 40),
      L: lab(45, 60, 52), // Lab distance ~12 from R
    };
    const captures = buildCaptures(facelets, base, 3, 7);

    const result = assembleState(captures);

    expect(result.facelets).toBe(facelets);
  });

  it('throws a friendly error when two centers are indistinguishable', () => {
    const facelets = scrambledFacelets();
    const sameCenter = lab(50, 50, 20);
    const captures = buildCaptures(facelets, DEFAULT_BASE, 1.5, 3, {
      R: { 4: sameCenter },
      L: { 4: sameCenter },
    });

    expect(() => assembleState(captures)).toThrow(/R.*L|L.*R/);
    expect(() => assembleState(captures)).toThrow(/apart/);
  });
});

// ---------- validateState ----------

describe('validateState', () => {
  it('accepts a dozen random valid cube states', () => {
    for (let i = 0; i < 12; i++) {
      const facelets = Cube.random().asString();
      const result = validateState(facelets);
      expect(result.ok, result.error).toBe(true);
    }
  });

  it('accepts the solved cube', () => {
    expect(validateState(SOLVED).ok).toBe(true);
  });

  it('rejects the wrong length', () => {
    const result = validateState(SOLVED.slice(0, 53));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/54/);
  });

  it('rejects wrong per-color counts', () => {
    const bad = 'R' + SOLVED.slice(1); // one extra R, one fewer U
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/9|exactly/i);
  });

  it('rejects duplicate centers', () => {
    // Swap facelet 0 (a U corner sticker) with facelet 13 (the R center):
    // counts stay balanced, but the R center becomes 'U' like the U center.
    const bad = swapChars(SOLVED, 0, 13);
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/center/i);
  });

  it('rejects one flipped edge', () => {
    // UR edge is facelets [5, 10]; swapping them flips its orientation only.
    const bad = swapChars(SOLVED, 5, 10);
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/flipped/i);
  });

  it('rejects one twisted corner', () => {
    // URF corner is facelets [8, 9, 20]; rotate them, permutation unchanged.
    const bad = rotateThree(SOLVED, [8, 9, 20]);
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/twisted/i);
  });

  it('rejects two swapped edges', () => {
    // Swap UR [5,10] and UF [7,19] stickers pairwise.
    let bad = swapChars(SOLVED, 5, 7);
    bad = swapChars(bad, 10, 19);
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/swapped/i);
  });

  it('rejects an impossible piece (edge with two identical colors)', () => {
    // Swap facelet 10 (UR's 'R') with facelet 1 (UB's 'U'): now the UR edge
    // reads ['U','U'] -- not a real piece -- while counts stay balanced.
    const bad = swapChars(SOLVED, 10, 1);
    const result = validateState(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/piece/i);
    expect(result.badStickers).toBeDefined();
    expect(result.badStickers!.length).toBeGreaterThan(0);
  });
});

// ---------- solveState / warmSolver / inverseMoves ----------

describe('solveState (node fallback)', () => {
  it('solves a scrambled valid state', async () => {
    const facelets = scrambledFacelets();
    expect(validateState(facelets).ok).toBe(true);

    const solution = await solveState(facelets);
    const cube = Cube.fromString(facelets);
    cube.move(solution);
    expect(cube.isSolved()).toBe(true);
  }, 20000);
});

describe('inverseMoves', () => {
  it('inverts a short algorithm', () => {
    expect(inverseMoves("R U F'")).toBe("F U' R'");
  });
});

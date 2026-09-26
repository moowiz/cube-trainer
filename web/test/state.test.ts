import { describe, it, expect } from 'vitest';
import { faceMoves, mergeMoves, movesStr } from '../src/cube/alg';
import Cube from 'cubejs';
import { solveState, validateState } from '../src/state';
import { SOLVED } from '../src/cube/state';

// scrambledFacelets() below calls Cube.scramble(), which (per cubejs) solves
// internally to build a scramble — it needs the solver tables just like
// solveState's fallback path does. Pay the ~1s cost once, up front.
Cube.initSolver();

// ---------- helpers ----------


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

// ---------- solveState ----------

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

describe('mergeMoves', () => {
  const merge = (alg: string) => movesStr(mergeMoves(faceMoves(alg)!));
  it('merges a face across its opposite, which commutes with it', () => {
    expect(merge("D' U' D")).toBe("U'");
    expect(merge("R L R' L'")).toBe('');
    expect(merge("R L' R2 L R")).toBe('');
    expect(merge('U D U2')).toBe("U' D");
  });
  it('leaves the rest alone', () => {
    expect(merge("R U R' U'")).toBe("R U R' U'");
    expect(merge("R2 R'")).toBe('R');
    expect(merge('R F R')).toBe('R F R');
  });
});

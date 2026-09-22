import { describe, it, expect } from 'vitest';
import { decode, coloursToFacelets, type DecodeOptions } from '../src/colour/decode';
import { validateState } from '../src/state';
import { FACE_ORDER } from '../src/types';
import { SOLVED } from '../src/cube/state';

// A known valid scrambled state (9 per colour, distinct centres, every
// corner/edge a real piece, correct parity) and the solved state, both from
// the task spec.
const SCRAMBLED = 'LRFLUFLBUBLDLRRRRFDDRUFDUFDFDBUDFRDLBBBULFULLRBUUBBDRF';

const CENTER_SLOTS = [4, 13, 22, 31, 40, 49];

// Sanity: the fixtures really are legal, so failures below point at the
// decoder and not at a typo in the facelet strings.
if (!validateState(SCRAMBLED).ok) throw new Error(`bad fixture: ${validateState(SCRAMBLED).error}`);
if (!validateState(SOLVED).ok) throw new Error(`bad fixture: ${validateState(SOLVED).error}`);

function legal(colours: readonly number[]): boolean {
  return validateState(coloursToFacelets(colours)).ok;
}

/** letter -> colour id bijection. Identity by default; a shuffle proves the decoder is name-agnostic. */
type Bijection = Record<string, number>;

const IDENTITY_BIJECTION: Bijection = Object.fromEntries(FACE_ORDER.map((f, i) => [f, i]));
// Any fixed permutation of 0..5 works; this one moves every letter off its
// "natural" FACE_ORDER index so an identity-bijection bug would be caught.
const SHUFFLED_BIJECTION: Bijection = { U: 4, R: 0, F: 5, D: 1, L: 3, B: 2 };

/**
 * -log(softmax(scores)) over 6 abstract colours, for one slot's true letter.
 * `bias` adds directly to a colour's raw score before softmax (positive = cheaper).
 */
function costRow(trueLetter: string, bijection: Bijection, bias: Partial<Record<string, number>> = {}): number[] {
  const trueColour = bijection[trueLetter]!;
  const scores = new Array<number>(6).fill(0);
  scores[trueColour] = 8; // strongly preferred
  for (const [letter, b] of Object.entries(bias)) {
    scores[bijection[letter]!] += b ?? 0;
  }
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => -Math.log(e / sum));
}

/** Build a clean 54x6 cost matrix from a facelet string under a colour bijection. */
function cleanCost(facelets: string, bijection: Bijection): number[][] {
  const rows: number[][] = new Array(54);
  for (let s = 0; s < 54; s++) rows[s] = costRow(facelets[s]!, bijection);
  return rows;
}

function runDecode(cost: number[][], opts?: DecodeOptions) {
  return decode(cost, legal, opts);
}

describe('coloursToFacelets', () => {
  it('maps colours back to letters via the centre slots, identity bijection', () => {
    const colours = FACE_ORDER.flatMap((_, fi) => new Array<number>(9).fill(fi));
    expect(coloursToFacelets(colours)).toBe(
      FACE_ORDER.map((f) => f.repeat(9)).join(''),
    );
  });

  it('throws if the six centres are not distinct', () => {
    const colours = new Array<number>(54).fill(0);
    expect(() => coloursToFacelets(colours)).toThrow(/distinct/);
  });
});

describe('decode: clean evidence', () => {
  it('decodes the scrambled state exactly under the identity bijection', () => {
    const cost = cleanCost(SCRAMBLED, IDENTITY_BIJECTION);
    const t0 = performance.now();
    const result = runDecode(cost);
    const ms = performance.now() - t0;
    console.log(`clean scrambled decode: ${ms.toFixed(2)}ms, pops=${result.pops}`);

    expect(result.legal).toBe(true);
    expect(result.colours).not.toBeNull();
    expect(coloursToFacelets(result.colours!)).toBe(SCRAMBLED);
    expect(result.changed).toBe(0);
    expect(result.delta).toBeGreaterThan(5);
  });

  it('decodes the scrambled state exactly under a shuffled bijection (name-agnostic)', () => {
    const cost = cleanCost(SCRAMBLED, SHUFFLED_BIJECTION);
    const result = runDecode(cost);

    expect(result.legal).toBe(true);
    expect(coloursToFacelets(result.colours!)).toBe(SCRAMBLED);
    expect(result.changed).toBe(0);
  });

  it('decodes the solved state exactly', () => {
    const cost = cleanCost(SOLVED, IDENTITY_BIJECTION);
    const result = runDecode(cost);

    expect(result.legal).toBe(true);
    expect(coloursToFacelets(result.colours!)).toBe(SOLVED);
    expect(result.changed).toBe(0);
  });
});

describe('decode: ten reds (unbalanced argmin)', () => {
  it('the balanced 8-per-colour step recovers the truth', () => {
    // Slot 9 (R1, true 'R') gets a small bias toward 'F' so its raw argmin
    // would be 'F' — pushing F's argmin count to 10 and R's to 8, while the
    // true count is 9 R / 9 F. The balanced (exactly-8-of-48) assignment
    // must still pick the truth for slot 9 once centres are excluded.
    const cost = cleanCost(SCRAMBLED, IDENTITY_BIJECTION);
    const trueLetter = SCRAMBLED[9]!;
    cost[9] = costRow(trueLetter, IDENTITY_BIJECTION, { F: 8.5 });

    // Confirm the rigged row's raw argmin really did move off the truth,
    // otherwise this test isn't exercising anything.
    const riggedArgminColour = cost[9]!.indexOf(Math.min(...cost[9]!));
    expect(riggedArgminColour).not.toBe(IDENTITY_BIJECTION[trueLetter]);

    const result = runDecode(cost);

    expect(result.legal).toBe(true);
    expect(coloursToFacelets(result.colours!)).toBe(SCRAMBLED);
    expect(result.changed).toBe(1); // only slot 9 differs from argmin
  });
});

describe('decode: illegal balanced optimum recovered by 2-swap search', () => {
  it('recovers a legal cube (the truth) when two non-adjacent stickers are mislabelled cheaply', () => {
    // Slots 8 and 9 sit on different corner pieces (8 is U9, on ULB/URF
    // depending on layout; 9 is R1). Make each one's evidence prefer the
    // OTHER slot's true colour, slightly more cheaply than its own truth,
    // so the balanced (count-respecting) optimum swaps them even though
    // that breaks both corners. Counts stay exactly 9-per-colour (it's a
    // straight swap), so the balanced step is the count-optimal answer
    // and only the 2-swap legality search can fix it.
    const cost = cleanCost(SCRAMBLED, IDENTITY_BIJECTION);
    const letter8 = SCRAMBLED[8]!;
    const letter9 = SCRAMBLED[9]!;
    expect(letter8).not.toBe(letter9); // otherwise this swap is a no-op

    cost[8] = costRow(letter9, IDENTITY_BIJECTION, { [letter8]: 7.9 });
    cost[9] = costRow(letter8, IDENTITY_BIJECTION, { [letter9]: 7.9 });

    const balancedArgmin8 = cost[8]!.indexOf(Math.min(...cost[8]!));
    const balancedArgmin9 = cost[9]!.indexOf(Math.min(...cost[9]!));
    expect(balancedArgmin8).toBe(IDENTITY_BIJECTION[letter9]);
    expect(balancedArgmin9).toBe(IDENTITY_BIJECTION[letter8]);

    const result = runDecode(cost);

    expect(result.legal).toBe(true);
    expect(result.colours).not.toBeNull();
    expect(coloursToFacelets(result.colours!)).toBe(SCRAMBLED);
  });
});

describe('decode: unobserved face', () => {
  it('still returns a legal cube with distinct centres, and recovers the truth when the rest is clean', () => {
    const cost = cleanCost(SCRAMBLED, IDENTITY_BIJECTION);
    // Zero out all nine slots of the U face (slots 0..8), centre included:
    // "free", i.e. no evidence at all.
    for (let s = 0; s < 9; s++) cost[s] = new Array<number>(6).fill(0);

    const result = runDecode(cost);

    expect(result.legal).toBe(true);
    expect(result.colours).not.toBeNull();
    const facelets = coloursToFacelets(result.colours!);
    const centreLetters = CENTER_SLOTS.map((i) => facelets[i]!);
    expect(new Set(centreLetters).size).toBe(6);
    expect(facelets).toBe(SCRAMBLED);
  });
});

describe('decode: near-uninformative evidence', () => {
  it('returns a legal cube (or gives up cleanly) without throwing, with 54 finite-or-Infinity margins', () => {
    // All rows almost flat: tiny, distinct-but-negligible biases so ties are
    // broken deterministically instead of leaning on argument order. With
    // essentially no evidence, the search has to work hard to find any
    // legal cube at all — cap the budget so the "or gives up cleanly"
    // branch of this test stays fast rather than exhausting the full
    // 30000+12000-pop default budget.
    const cost: number[][] = [];
    for (let s = 0; s < 54; s++) {
      const row = new Array<number>(6);
      for (let c = 0; c < 6; c++) row[c] = 0.001 * ((s * 7 + c * 3) % 5);
      cost.push(row);
    }

    let result: ReturnType<typeof runDecode>;
    expect(() => {
      result = runDecode(cost, { maxPops: 3000, secondPops: 1000 });
    }).not.toThrow();

    if (result!.legal) {
      expect(result!.colours).not.toBeNull();
      expect(legal(result!.colours!)).toBe(true);
    } else {
      expect(result!.colours).toBeNull();
      expect(result!.delta).toBe(Infinity);
    }
    expect(result!.margins).toHaveLength(54);
    for (const m of result!.margins) {
      expect(typeof m).toBe('number');
      expect(Number.isNaN(m)).toBe(false);
      expect(m).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('decode: delta is never negative', () => {
  it('delta >= 0 even when two slots are ambiguous between the same two colours', () => {
    // On the solved cube, make two same-face, same-true-colour slots (R2,
    // R3 - both truly 'R') symmetrically torn toward 'F': a swap between
    // them is a no-op (same colour on both sides, so isAllowedSwap forbids
    // it and it can't even be reached) but any other completion the search
    // turns up cannot be cheaper than the best.
    const cost = cleanCost(SOLVED, IDENTITY_BIJECTION);
    cost[10] = costRow('R', IDENTITY_BIJECTION, { F: 7.5 });
    cost[11] = costRow('R', IDENTITY_BIJECTION, { F: 7.5 });

    const result = runDecode(cost);

    expect(result.delta).toBeGreaterThanOrEqual(0);
  });
});

describe('decode: heap correctness on a slow path', () => {
  it('respects maxPops and reports legal=false, colours=null, delta=Infinity on a tiny budget', () => {
    // A cost matrix rigged so the balanced optimum is illegal (as above)
    // but the swap budget is far too small to find the fix.
    const cost = cleanCost(SCRAMBLED, IDENTITY_BIJECTION);
    const letter8 = SCRAMBLED[8]!;
    const letter9 = SCRAMBLED[9]!;
    cost[8] = costRow(letter9, IDENTITY_BIJECTION, { [letter8]: 7.9 });
    cost[9] = costRow(letter8, IDENTITY_BIJECTION, { [letter9]: 7.9 });

    const result = runDecode(cost, { maxPops: 0 });

    expect(result.legal).toBe(false);
    expect(result.colours).toBeNull();
    expect(result.delta).toBe(Infinity);
    expect(result.pops).toBe(0);
    expect(Number.isFinite(result.cost)).toBe(true);
  });
});

// Face turns as facelet permutations (docs/solve-tracking-design.md 2.3).
//
// A state is a 54-char URFDLB facelet string (cubejs order, see state.ts);
// a move is a permutation of the 54 slots. Only the 18 face turns exist as
// hypotheses: slice and wide moves are face turns plus a whole-cube
// rotation, and rotations change which tracks exist, not the state.

export const MOVES = ['U', "U'", 'U2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'B', "B'", 'B2'] as const;
export type Move = (typeof MOVES)[number];

// Quarter turns clockwise, derived from cubejs (test/moves.test.ts checks
// all 18 against it on random states): out[i] = s[PERM[m][i]].
const QUARTER: Record<'U' | 'R' | 'F' | 'D' | 'L' | 'B', readonly number[]> = {
  U: [6, 3, 0, 7, 4, 1, 8, 5, 2, 45, 46, 47, 12, 13, 14, 15, 16, 17, 9, 10, 11, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 18, 19, 20, 39, 40, 41, 42, 43, 44, 36, 37, 38, 48, 49, 50, 51, 52, 53],
  R: [0, 1, 20, 3, 4, 23, 6, 7, 26, 15, 12, 9, 16, 13, 10, 17, 14, 11, 18, 19, 29, 21, 22, 32, 24, 25, 35, 27, 28, 51, 30, 31, 48, 33, 34, 45, 36, 37, 38, 39, 40, 41, 42, 43, 44, 8, 46, 47, 5, 49, 50, 2, 52, 53],
  F: [0, 1, 2, 3, 4, 5, 44, 41, 38, 6, 10, 11, 7, 13, 14, 8, 16, 17, 24, 21, 18, 25, 22, 19, 26, 23, 20, 15, 12, 9, 30, 31, 32, 33, 34, 35, 36, 37, 27, 39, 40, 28, 42, 43, 29, 45, 46, 47, 48, 49, 50, 51, 52, 53],
  D: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 24, 25, 26, 18, 19, 20, 21, 22, 23, 42, 43, 44, 33, 30, 27, 34, 31, 28, 35, 32, 29, 36, 37, 38, 39, 40, 41, 51, 52, 53, 45, 46, 47, 48, 49, 50, 15, 16, 17],
  L: [53, 1, 2, 50, 4, 5, 47, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 0, 19, 20, 3, 22, 23, 6, 25, 26, 18, 28, 29, 21, 31, 32, 24, 34, 35, 42, 39, 36, 43, 40, 37, 44, 41, 38, 45, 46, 33, 48, 49, 30, 51, 52, 27],
  B: [11, 14, 17, 3, 4, 5, 6, 7, 8, 9, 10, 35, 12, 13, 34, 15, 16, 33, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 36, 39, 42, 2, 37, 38, 1, 40, 41, 0, 43, 44, 51, 48, 45, 52, 49, 46, 53, 50, 47],
};

function compose(a: readonly number[], b: readonly number[]): number[] {
  // apply a then b: out[i] = (a∘s)[b[i]] = s[a[b[i]]]
  return b.map((j) => a[j]!);
}

/** PERM[m][i] = the slot whose sticker lands in slot i after move m. */
export const PERM: Record<Move, readonly number[]> = (() => {
  const out = {} as Record<Move, readonly number[]>;
  for (const f of ['U', 'R', 'F', 'D', 'L', 'B'] as const) {
    const q = QUARTER[f];
    const h = compose(q, q);
    out[f] = q;
    out[`${f}2`] = h;
    out[`${f}'`] = compose(h, q);
  }
  return out;
})();

/** Face (0..5 in URFDLB order) a move turns. */
export function faceOf(m: Move): number {
  return 'URFDLB'.indexOf(m[0]!);
}

export function applyMove(s: string, m: Move): string {
  const p = PERM[m];
  let out = '';
  for (let i = 0; i < 54; i++) out += s[p[i]!];
  return out;
}

/** Same on a letter-index array (0..5 per slot), the reader's working form. */
export function applyMoveIdx(s: Uint8Array, m: Move, out = new Uint8Array(54)): Uint8Array {
  const p = PERM[m];
  for (let i = 0; i < 54; i++) out[i] = s[p[i]!]!;
  return out;
}

export function applySeq(s: string, moves: readonly Move[]): string {
  for (const m of moves) s = applyMove(s, m);
  return s;
}

const MOVE_RE = /^([URFDLB])(2|')?$/;

/** "R U R' U2" -> moves; throws on anything but the 18 face turns. */
export function parseAlg(alg: string): Move[] {
  return alg.trim().split(/\s+/).filter(Boolean).map((tok) => {
    const m = MOVE_RE.exec(tok);
    if (!m) throw new Error(`not a face turn: ${tok}`);
    return tok as Move;
  });
}

export function invertMove(m: Move): Move {
  if (m.endsWith('2')) return m;
  if (m.endsWith("'")) return m[0] as Move;
  return `${m}'` as Move;
}

/** Opposite face index (U-D, R-L, F-B). */
function opposite(face: number): number {
  return (face + 3) % 6;
}

/**
 * Move sequences of exactly `depth` turns with no two consecutive turns of
 * the same face, and turns of opposite faces (which commute) taken in
 * URFDLB order only - so each reachable state appears once per
 * commuting class: 18, 243, 3240 at depths 1..3 (the design's 270 / 4050
 * count both orders of a commuting pair).
 */
export function canonicalSeqs(depth: number): Move[][] {
  const out: Move[][] = [];
  const rec = (seq: Move[], lastFace: number, lastOppOf: number): void => {
    if (seq.length === depth) { out.push(seq.slice()); return; }
    for (const m of MOVES) {
      const f = faceOf(m);
      if (f === lastFace) continue;
      // the previous turn's face is opposite to this one: only in canonical order
      if (lastFace >= 0 && opposite(lastFace) === f && lastFace > f) continue;
      // three in a row on an axis (U D U) is never canonical either
      if (lastOppOf === f) continue;
      seq.push(m);
      rec(seq, f, lastFace >= 0 && opposite(lastFace) === f ? lastFace : -1);
      seq.pop();
    }
  };
  rec([], -1, -1);
  return out;
}

/** Whether two moves commute (same face or opposite faces). */
export function commute(a: Move, b: Move): boolean {
  const fa = faceOf(a), fb = faceOf(b);
  return fa === fb || opposite(fa) === fb;
}

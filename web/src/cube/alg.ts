// Algorithm strings: the one parser for everything typed or listed in the
// trainers (face turns, slices, wide moves, rotations), and the face-turn
// vocabulary the solvers share with the EOCross worker.

/** A face turn: `times` quarter turns clockwise (1, 2, or 3 = anticlockwise). */
export interface Move {
  face: string;
  times: 1 | 2 | 3;
}

/** The 18 face turns in the solvers' order: U U' U2 R R' R2 F F' F2 D D' D2 L L' L2 B B' B2 (an index is a move id). */
export const FACE_MOVES: readonly Move[] = 'URFDLB'.split('').flatMap((face) => [1, 3, 2].map((times) => ({ face, times: times as 1 | 2 | 3 })));

const SUFFIX: Record<number, string> = { 1: '', 2: '2', 3: "'" };

export function moveStr(m: Move): string {
  return m.face + SUFFIX[m.times];
}

export function movesStr(ms: readonly Move[]): string {
  return ms.map(moveStr).join(' ');
}

/** Adjacent turns of one face merged (R2 R' -> R, R R' -> nothing), so a joined sequence reads as one alg. */
export function mergeMoves(ms: readonly Move[]): Move[] {
  const out: Move[] = [];
  for (const m of ms) {
    const last = out[out.length - 1];
    if (last && last.face === m.face) { const q = (last.times + m.times) % 4; out.pop(); if (q) out.push({ face: m.face, times: q as 1 | 2 | 3 }); }
    else out.push(m);
  }
  return out;
}

/** The same turn the other way round (half turns are their own inverse). */
export function flipMove(m: Move): Move {
  return { face: m.face, times: (4 - m.times) as 1 | 2 | 3 };
}

/**
 * Tokens cubejs accepts: parentheses and AUF brackets dropped, Rw-style wide moves lowered.
 * Throws with a readable message on anything else.
 */
export function tokens(alg: string): string[] {
  const out: string[] = [];
  for (const t of alg.replace(/[()[\]]/g, ' ').trim().split(/\s+/).filter(Boolean)) {
    const m = /^([URFDLBMESxyzurfdlb])(w?)(2|')?$/.exec(t);
    if (!m) throw new Error(`Could not read: ${t}`);
    out.push((m[2] ? m[1].toLowerCase() : m[1]) + (m[3] ?? ''));
  }
  return out;
}

/** The inverse alg: tokens reversed, quarter turns flipped. */
export function inverse(alg: string): string {
  return tokens(alg).reverse().map((t) => (t.endsWith("'") ? t.slice(0, -1) : t.endsWith('2') ? t : t + "'")).join(' ');
}

/** Number of face/slice/wide turns in an alg (rotations are free). */
export function moveCount(alg: string): number {
  return tokens(alg).filter((t) => !/^[xyz]/.test(t)).length;
}

/** The alg as face turns, or null if it has anything else (slices, wide moves, rotations). */
export function faceMoves(alg: string): Move[] | null {
  const out: Move[] = [];
  for (const t of tokens(alg)) {
    if (!'URFDLB'.includes(t[0])) return null;
    out.push({ face: t[0], times: t.endsWith("'") ? 3 : t.endsWith('2') ? 2 : 1 });
  }
  return out;
}

const AXIS: Record<string, number> = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };

/**
 * `n` random face turns: never the same face twice in a row, never three in a row on one axis
 * (U D U wastes a move). The one generator (the scan sheet, the EO trainer, the F2L generator);
 * `rng` in [0, 1) so a test can seed it.
 */
export function randomMoves(n: number, rng: () => number = Math.random): Move[] {
  const out: Move[] = [];
  let prev = '', prev2 = '';
  while (out.length < n) {
    const f = 'URFDLB'[Math.floor(rng() * 6)]!;
    if (f === prev) continue;
    if (prev2 && AXIS[f] === AXIS[prev] && AXIS[f] === AXIS[prev2]) continue;
    out.push({ face: f, times: [1, 3, 2][Math.floor(rng() * 3)] as 1 | 2 | 3 });
    prev2 = prev; prev = f;
  }
  return out;
}

/** True for a quarter turn of F or B: the moves that flip edge orientation. */
export const isEoFlip = (m: Move): boolean => (m.face === 'F' || m.face === 'B') && m.times !== 2;

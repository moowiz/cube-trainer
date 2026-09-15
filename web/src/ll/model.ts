// The last-layer trainers' cube model: everything is an alg string applied
// to a solved cube (no state objects to keep valid); a drill's state is
// `setup`, the check is `setup + the moves typed`. Case identification is
// modulo AUF, and for OCLL modulo the permutation too.

import { inverse } from '../cube/alg';
import { facesAt, NORMAL, type Vec } from '../cube/geometry';
import { SOLVED, aufToSolve, state } from '../cube/state';
import { stageOf } from '../stage';
import { solveG1 } from './scramble';
import { CASES, type LLCase, type LLKind } from './cases';

export { inverse, moveCount, tokens } from '../cube/alg';
export { SOLVED, aufToSolve, state } from '../cube/state';

const AUFS = ['', 'U', "U'", 'U2'];

/** The case stage is done: OCLL when F2L is intact and every corner is oriented; PLL when solved. */
export function done(kind: LLKind, alg: string): boolean {
  if (kind === 'pll') return state(alg) === SOLVED;
  const r = stageOf(state(alg));
  return r.pairs === 4 && r.eoBad === 0 && r.ocll;
}

// U-layer sticker positions: the U face, then the top row of each side (Kociemba indices)
const U_LAYER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 36, 37, 38, 45, 46, 47];
/** Which U-layer stickers show U: what an OCLL case looks like, whatever the permutation. */
function orientationPattern(f: string): string {
  return U_LAYER.map((i) => (f[i] === 'U' ? '1' : '0')).join('');
}

// every case in every AUF (and, for PLL, every pre-AUF too: the same permutation seen from another side)
const CASE_KEYS: Record<LLKind, Map<string, LLCase> | null> = { ocll: null, pll: null };
function caseKeys(kind: LLKind): Map<string, LLCase> {
  if (CASE_KEYS[kind]) return CASE_KEYS[kind]!;
  const m = new Map<string, LLCase>();
  for (const c of CASES[kind]) {
    for (const post of AUFS) {
      if (kind === 'ocll') m.set(orientationPattern(state(`${inverse(c.alg)} ${post}`)), c);
      else for (const pre of AUFS) m.set(state(`${pre} ${inverse(c.alg)} ${post}`), c);
    }
  }
  CASE_KEYS[kind] = m;
  return m;
}

/** Which case the state after `alg` is, or null (wrong stage, or not one of the tabled cases). */
export function identify(kind: LLKind, alg: string): LLCase | null {
  const f = state(alg);
  return caseKeys(kind).get(kind === 'ocll' ? orientationPattern(f) : f) ?? null;
}

/** The tabled solution for the state after `alg`: the AUF to do first, the case, and (PLL) the AUF after. */
export function solution(kind: LLKind, alg: string): { pre: string; case: LLCase; post: string } | null {
  const c = identify(kind, alg);
  if (!c) return null;
  for (const pre of AUFS) {
    const after = `${alg} ${pre} ${c.alg}`;
    if (kind === 'ocll') { if (done(kind, after)) return { pre, case: c, post: '' }; continue; }
    const post = aufToSolve(after);
    if (post !== null) return { pre, case: c, post };
  }
  return null;
}

/**
 * A random drill: the inverse of a random case's alg, in a random AUF. OCLL drills also get a
 * random corner/edge permutation first (a PLL alg without whole-cube rotations, so the setup can be
 * applied to a real cube as written), since after F2L the permutation is random too. PLL drills
 * get a random AUF before the inverse too: the same permutation seen from any of its four sides,
 * which is what recognition has to cope with.
 */
export function randomSetup(kind: LLKind, rng: () => number = Math.random): { setup: string; case: LLCase } {
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
  const c = pick(CASES[kind]);
  const parts: string[] = [];
  if (kind === 'ocll' && rng() < 0.8) parts.push(pick(CASES.pll.filter((p) => !/[xyz]/.test(p.alg))).alg);
  if (kind === 'pll') parts.push(pick(AUFS));
  parts.push(inverse(c.alg), pick(AUFS));
  return { setup: parts.filter(Boolean).join(' '), case: c };
}

/**
 * A scramble for a PLL drill's state: face turns only (no rotations, no slices, nothing that reads
 * as a known alg backwards), so it can be applied to a real cube from solved. The optimal phase-2
 * solution inverted (see ./scramble.ts), 7-13 moves; null when the state is not a PLL (an OCLL
 * drill's corners are twisted, so its setup stays the alg as written).
 */
export function scrambleFor(setup: string, rng: () => number = Math.random): string | null {
  const sol = solveG1(state(setup), rng);
  return sol === null ? null : inverse(sol);
}

// ---- PLL arrows: where each top-layer piece has to go ----
// U turns the layer (x, z) -> (-z, x); the AUF that leaves the most pieces home is the frame the
// arrows are drawn in (a case is defined up to AUF), each piece pointing at its slot in that frame.
const rotU = (p: Vec, k: number): Vec => { let [x, y, z] = p; for (let i = 0; i < k; i++) [x, z] = [-z, x]; return [x, y, z]; };
const U_LAYER_POS: readonly Vec[] = [[-1, 1, -1], [0, 1, -1], [1, 1, -1], [-1, 1, 0], [1, 1, 0], [-1, 1, 1], [0, 1, 1], [1, 1, 1]];
/** Arrows (from, to) between top-layer positions, or null when the top layer is not a PLL (corners not oriented). */
export function pllArrows(f: string): { from: Vec; to: Vec }[] | null {
  if (f.slice(0, 9) !== 'UUUUUUUUU') return null;
  const pieces = U_LAYER_POS.map((pos) => {
    const letters = facesAt(pos).map((i) => f[i]!);
    if (!letters.includes('U')) return null;
    const home = letters.reduce<[number, number, number]>((a, l) => [a[0] + NORMAL[l]![0], a[1] + NORMAL[l]![1], a[2] + NORMAL[l]![2]], [0, 0, 0]);
    return { pos, home: home as Vec };
  });
  if (pieces.some((p) => !p)) return null;
  const same = (a: Vec, b: Vec) => a[0] === b[0] && a[2] === b[2];
  let best = 0, bestN = -1;
  for (let k = 0; k < 4; k++) {
    const n = pieces.filter((p) => same(rotU(p!.pos, k), p!.home)).length;
    if (n > bestN) { bestN = n; best = k; }
  }
  return pieces.flatMap((p) => { const to = rotU(p!.home, (4 - best) % 4); return same(p!.pos, to) ? [] : [{ from: p!.pos, to }]; });
}

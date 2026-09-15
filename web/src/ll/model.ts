// The last-layer trainers' cube model: everything is an alg string applied
// to a solved cube (no state objects to keep valid); a drill's state is
// `setup`, the check is `setup + the moves typed`. Case identification is
// modulo AUF, and for OCLL modulo the permutation too.

import { inverse } from '../cube/alg';
import { SOLVED, aufToSolve, state } from '../cube/state';
import { stageOf } from '../stage';
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
 * applied to a real cube as written), since after F2L the permutation is random too.
 */
export function randomSetup(kind: LLKind, rng: () => number = Math.random): { setup: string; case: LLCase } {
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
  const c = pick(CASES[kind]);
  const parts: string[] = [];
  if (kind === 'ocll' && rng() < 0.8) parts.push(pick(CASES.pll.filter((p) => !/[xyz]/.test(p.alg))).alg);
  parts.push(inverse(c.alg), pick(AUFS));
  return { setup: parts.filter(Boolean).join(' '), case: c };
}

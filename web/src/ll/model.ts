// The last-layer trainers' cube model: everything is an alg string applied
// to a solved cube (no state objects to keep valid); a drill's state is
// `setup`, the check is `setup + the moves typed`. Case identification is
// modulo AUF, and for OCLL modulo the permutation too.

import { inverse, moveCount, tokens } from '../cube/alg';
import { facesAt, NORMAL, type Vec } from '../cube/geometry';
import { SOLVED, aufToSolve, faceTurns, state } from '../cube/state';
import { DATA } from '../f2l/data';
import { findCase, fullAlg, SLOTS, SLOT_WORD, slotSolved, slotState } from '../f2l/model';
import { stageOf } from '../stage';
import { solveAny } from './scramble';
import { CASES, casesVersion, type LLCase, type LLKind } from './cases';

export { inverse, moveCount, tokens } from '../cube/alg';
export { SOLVED, aufToSolve, state } from '../cube/state';

const AUFS = ['', 'U', "U'", 'U2'];

/** The case stage is done: OCLL when F2L is intact and every corner is oriented; PLL when solved. */
export function done(kind: LLKind, alg: string): boolean {
  if (kind === 'pll') return state(alg) === SOLVED;
  return reached('pll', alg);
}

/** The cube after `alg` is at the drill's stage or past it (F2L done, and for PLL the corners oriented too). */
export function reached(kind: LLKind, alg: string): boolean {
  const r = stageOf(state(alg));
  return r.pairs === 4 && r.eoBad === 0 && (kind === 'ocll' || r.ocll);
}

/**
 * Where a drill starts: at its own stage, or earlier - the corners still to orient (a PLL drill),
 * the last F2L pair still to insert - so the case has to be recognised after solving the step
 * before it your own way, as in a solve. The earlier steps are timed with the case.
 */
export type LLStart = 'pll' | 'ocll' | 'pair';
export const STARTS: Record<LLKind, LLStart[]> = { ocll: ['ocll', 'pair'], pll: ['pll', 'ocll', 'pair'] };
export const START_LABEL: Record<LLStart, string> = { pll: 'the PLL', ocll: 'OCLL', pair: 'the last F2L pair' };

// U-layer sticker positions: the U face, then the top row of each side (Kociemba indices)
const U_LAYER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 36, 37, 38, 45, 46, 47];
/** Which U-layer stickers show U: what an OCLL case looks like, whatever the permutation. */
function orientationPattern(f: string): string {
  return U_LAYER.map((i) => (f[i] === 'U' ? '1' : '0')).join('');
}

// every case in every AUF (and, for PLL, every pre-AUF too: the same permutation seen from another side)
const CASE_KEYS: Record<LLKind, { at: number; m: Map<string, LLCase> } | null> = { ocll: null, pll: null };
function caseKeys(kind: LLKind): Map<string, LLCase> {
  if (CASE_KEYS[kind]?.at === casesVersion()) return CASE_KEYS[kind]!.m;
  const m = new Map<string, LLCase>();
  for (const c of CASES[kind]) {
    for (const post of AUFS) {
      if (kind === 'ocll') m.set(orientationPattern(state(`${inverse(c.alg)} ${post}`)), c);
      else for (const pre of AUFS) m.set(state(`${pre} ${inverse(c.alg)} ${post}`), c);
    }
  }
  CASE_KEYS[kind] = { at: casesVersion(), m };
  return m;
}

/** Which case the state after `alg` is, or null (wrong stage, or not one of the tabled cases). */
export function identify(kind: LLKind, alg: string): LLCase | null {
  const f = state(alg);
  return caseKeys(kind).get(kind === 'ocll' ? orientationPattern(f) : f) ?? null;
}

/**
 * The case a solved cube is at after doing `c`'s alg: what the drill chains to. Its alg undoes
 * `c`'s, so the two can be practised back to back without a scramble; a case that chains to
 * itself is its own inverse.
 */
export function chainPartner(kind: LLKind, c: LLCase): LLCase | null {
  return identify(kind, c.alg);
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
 * The AUFs that make `alg` solve the drill's stage from the state after `before` (an alternative alg
 * for the case on the cube): the U turn to do first and, for PLL, the one after; null when it does not.
 */
export function fitAlg(kind: LLKind, before: string, alg: string): { pre: string; post: string } | null {
  for (const pre of AUFS) {
    const after = `${before} ${pre} ${alg}`;
    if (kind === 'ocll') { if (done(kind, after)) return { pre, post: '' }; continue; }
    const post = aufToSolve(after);
    if (post !== null) return { pre, post };
  }
  return null;
}

/**
 * A random drill: the inverse of a random case's alg, in a random AUF. OCLL drills also get a
 * random corner/edge permutation first (a PLL alg without whole-cube rotations, so the setup can be
 * applied to a real cube as written), since after F2L the permutation is random too. PLL drills
 * get a random AUF before the inverse too: the same permutation seen from any of its four sides,
 * which is what recognition has to cope with.
 *
 * An earlier start adds to the setup after the permutation: a PLL drill from OCLL, a random OCLL
 * case's alg backwards; from the last pair, a random last-slot case's alg backwards too. The case
 * drawn is the drill's own; the earlier steps are whatever comes up, as in a solve, and the case
 * that actually comes up after them depends on how they are solved (the route() through the
 * standard algs gives one answer). The setup is face turns only; the trainer shows scrambleFor().
 * `pool` is the cases to draw from (the ones being learnt); empty means all of them.
 */
export function randomSetup(kind: LLKind, rng: () => number = Math.random, from: LLStart = kind, pool: readonly LLCase[] = CASES[kind]): { setup: string; case: LLCase } {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
  const c = pick(pool.length ? pool : CASES[kind]);
  const parts: string[] = [];
  // an OCLL drill's permutation is a random PLL (always one: a lone twist's shortest scramble is its alg backwards)
  if (kind === 'ocll') parts.push(pick(CASES.pll.filter((p) => !/[xyz]/.test(p.alg))).alg);
  if (kind === 'pll') parts.push(pick(AUFS), inverse(c.alg), pick(AUFS));
  else parts.push(inverse(c.alg), pick(AUFS));
  if (kind === 'pll' && from !== 'pll') parts.push(inverse(pick(CASES.ocll).alg), pick(AUFS));
  if (from === 'pair') {
    // a random last-slot position of a random slot: the sheet's alg for it backwards (R/U-only, no AUF bracket)
    const slot = pick(SLOTS);
    const cases = Object.values(DATA.slots[slot].cases).filter((f) => f.section === 'Last slot');
    parts.push(inverse(fullAlg('', pick(cases).simple)), pick(AUFS));
  }
  // each part applied in the home frame: the alg before it may end turned (a V perm's y)
  return { setup: parts.filter(Boolean).reduce((acc, part) => faceTurns(`${acc} ${part}`), ''), case: c };
}

/**
 * The moves done, split where the drill's own stage begins: `k` moves of `toks` bring the cube
 * from `setup` to the drill's stage (0 when it starts there), and the case found there - null
 * when the moves never reach it, `skip` when they land on it solved (up to the AUF, for PLL).
 */
export function splitAt(kind: LLKind, setup: string, toks: readonly string[]): { k: number; case: LLCase | 'skip' | null } | null {
  for (let k = 0; k <= toks.length; k++) {
    const alg = `${setup} ${toks.slice(0, k).join(' ')}`;
    if (!reached(kind, alg)) continue;
    return { k, case: done(kind, alg) || (kind === 'pll' && aufToSolve(alg) !== null) ? 'skip' : identify(kind, alg) };
  }
  return null;
}

/** One step of the standard route from a setup to the drill's target: the AUF first, the alg, (PLL) the AUF after. */
export interface RouteStep { stage: 'pair' | 'ocll' | 'pll'; name: string; hint: string; pre: string; alg: string; post: string; case?: LLCase }

/**
 * The route from the state after `alg` to the drill's target through the tabled algs, the last
 * step the drill's own case: the last pair by the sheet's R/L/U alg for its position, OCLL by
 * its alg, then the case. Null when a step has no tabled alg (a wrong stage, an unlisted case).
 */
export function route(kind: LLKind, alg: string): RouteStep[] | null {
  const steps: RouteStep[] = [];
  let cur = alg;
  const f = state(cur);
  const rep = stageOf(f);
  if (rep.eoBad || rep.cross < 4 || rep.pairs < 3) return null;
  if (rep.pairs === 3) {
    const slot = SLOTS.find((s) => !slotSolved(f, s))!;
    const { corner, edge } = slotState(f, slot);
    const hit = findCase(slot, corner, edge);
    if (!hit) return null;
    const full = fullAlg(hit.hit.auf, hit.c.simple);
    const toks = tokens(full);
    const pre = toks[0]?.startsWith('U') ? toks[0] : '';
    steps.push({ stage: 'pair', name: `${SLOT_WORD[slot]} pair`, hint: `the ${SLOT_WORD[slot]} slot is open`, pre, alg: toks.slice(pre ? 1 : 0).join(' '), post: '' });
    cur = `${cur} ${full}`;
  }
  if (kind === 'pll' && !reached('pll', cur)) {
    const sol = solution('ocll', cur);
    if (!sol) return null;
    steps.push({ stage: 'ocll', name: sol.case.name, hint: sol.case.hint, pre: sol.pre, alg: sol.case.alg, post: '', case: sol.case });
    cur = `${cur} ${sol.pre} ${sol.case.alg}`;
  }
  const sol = solution(kind, cur);
  if (!sol) return null;
  steps.push({ stage: kind, name: sol.case.name, hint: sol.case.hint, pre: sol.pre, alg: sol.case.alg, post: sol.post, case: sol.case });
  return steps;
}

/** A route step's moves as one line, [AUF]s in brackets, and plain. */
export const stepShown = (s: RouteStep): string => [s.pre && `[${s.pre}]`, s.alg, s.post && `[${s.post}]`].filter(Boolean).join(' ');
export const stepPlain = (s: RouteStep): string => [s.pre, s.alg, s.post].filter(Boolean).join(' ');
export const stepMoves = (s: RouteStep): number => moveCount(stepPlain(s));

/**
 * A scramble for a drill's state: face turns only (no rotations, no slices, nothing that reads as
 * a known alg backwards), so it can be applied to a real cube from solved without giving the case
 * away. A short solution inverted (see ./scramble.ts): 7-13 moves for a PLL, a few more with the
 * corners twisted or a pair out, the orientation and the permutation mixed into one sequence.
 */
/**
 * The next case to drill: a weighted draw, not a plain one (user, 2026-09-23 - three of the same in a
 * row happens often with a small pool). A case's weight is 1/(1 + how often it has been drawn), so the
 * ones seen less come up more and the counts even out over a handful of rounds, and the case just drawn
 * is left out entirely unless it is the only one. `seen` is read, not written: the caller counts.
 */
export function drawCase(pool: readonly LLCase[], seen: Readonly<Record<string, number>>, last: string | null, rng: () => number = Math.random): LLCase {
  const from = pool.length > 1 && last ? pool.filter((c) => c.id !== last) : pool;
  const weights = from.map((c) => 1 / (1 + (seen[c.id] ?? 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < from.length; i++) { r -= weights[i]!; if (r <= 0) return from[i]!; }
  return from[from.length - 1]!;
}

export function scrambleFor(setup: string, rng: () => number = Math.random): string {
  return inverse(solveAny(state(setup), rng));
}

/**
 * A scramble's trailing top-layer turns (trainer letters; a D turn as the scramble is shown, WCA
 * hold) split off: they only set the AUF the case comes in, which a drill does not care about
 * (user, 2026-09-21), so the drill drops them and moves its setup by their inverse instead.
 */
export function trimAuf(scramble: string): { scramble: string; auf: string } {
  const toks = tokens(scramble);
  let n = toks.length;
  while (n > 0 && /^U/.test(toks[n - 1]!)) n--;
  return { scramble: toks.slice(0, n).join(' '), auf: toks.slice(n).join(' ') };
}

// ---- PLL arrows: where each top-layer piece has to go ----
// U turns the layer (x, z) -> (-z, x); the AUF that leaves the most pieces home is the frame the
// arrows are drawn in (a case is defined up to AUF), each piece pointing at its slot in that frame.
const rotU = (p: Vec, k: number): Vec => { let [x, z] = [p[0], p[2]]; const y = p[1]; for (let i = 0; i < k; i++) [x, z] = [-z, x]; return [x, y, z]; };
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

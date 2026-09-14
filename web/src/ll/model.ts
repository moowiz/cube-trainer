// The last-layer trainers' cube model, on top of cubejs. Everything is an
// alg string applied to a solved cube (no state objects to keep valid): a
// drill's state is `setup`, the check is `setup + the moves typed`.
//
// Frames: the trainer holds white down (D) with a chosen colour in front.
// cubejs applies rotations physically (after `y` the old R face is in
// front), so a facelet string is first NORMALISED - relabelled so a letter
// names the face whose centre currently shows it - which reads the cube in
// its current holding. stage.ts then makes sense of it as long as white is
// still underneath.

/// <reference path="../cubejs.d.ts" />
import Cube from 'cubejs';
import { stageOf } from '../stage';
import { CASES, type LLCase, type LLKind } from './cases';

export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const AUFS = ['', 'U', "U'", 'U2'];

/** Tokens cubejs accepts: parentheses dropped, Rw-style wide moves lowered. Throws on anything else. */
export function tokens(alg: string): string[] {
  const out: string[] = [];
  for (const t of alg.replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean)) {
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

/** Facelets after `alg` from solved, relabelled by centres (see the header). */
export function state(alg: string): string {
  const raw = new Cube().move(tokens(alg).join(' ')).asString();
  const map: Record<string, string> = {};
  'URFDLB'.split('').forEach((face, i) => { map[raw[i * 9 + 4]] = face; });
  return raw.split('').map((c) => map[c]).join('');
}

/** True iff the white centre is still underneath - the only holding the checks understand. */
export function whiteDown(alg: string): boolean {
  return new Cube().move(tokens(alg).join(' ')).asString()[31] === 'D';
}

/** '' when `alg` solves the cube, the U turn that would finish it, or null. */
export function aufToSolve(alg: string): string | null {
  for (const auf of AUFS) if (state(`${alg} ${auf}`) === SOLVED) return auf;
  return null;
}

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

/** Number of face/slice/wide turns in an alg (rotations are free). */
export function moveCount(alg: string): number {
  return tokens(alg).filter((t) => !/^[xyz]/.test(t)).length;
}

// The F2L case finder's logic, on facelet strings: where a slot's pair is,
// which case that is, the two practice-scramble generators, and the text
// that explains an alg (the reason for its shape, and a move-by-move trace).
// Everything here is pure; trainer.ts owns the DOM.
//
// Frame: white down, the chosen colour in front (the trainer's). The trace
// and borrow checks follow an alg move by move in ABSOLUTE space - a wide
// move or x carries the centres with it and "the top layer" stays where it
// was - which is what the sheet's algs assume; the only normalised states
// are the ones the tracker keeps between algs.

import { FACE_MOVES, inverse, mergeMoves, moveCount, movesStr, tokens, type Move } from '../cube/alg';
import { facesAt, key, posName, STICKERS, type Vec } from '../cube/geometry';
import { applyEdgeMove, cubieSolved, EDGE_POS, edgeMoveOf, edgeState, findCorner, findEdge, type EdgeState } from '../cube/pieces';
import { CENTRE, rawFacelets, SOLVED, state, stepStates } from '../cube/state';
import { randomScramble } from '../scramble';
import { stageOf } from '../stage';
import { DATA, type CornerOrient, type F2LCase, type LookupHit, type SlotName } from './data';

export type { CornerOrient, F2LCase, LookupHit, SlotName };

export const SLOTS: readonly SlotName[] = ['FR', 'FL', 'BR', 'BL'];
export const SLOT_WORD: Record<SlotName, string> = { FR: 'front-right', FL: 'front-left', BR: 'back-right', BL: 'back-left' };
export const isSlot = (s: string): s is SlotName => (SLOTS as readonly string[]).includes(s);

/** Where a slot's corner is and which way its white sticker faces. */
export interface CornerState { pos: string; o: CornerOrient }
export interface SlotState { corner: CornerState; edge: string }

/** The slot's edge position and the corner position under it. */
function slotPositions(slot: SlotName): { edge: Vec; corner: Vec } {
  const edge: Vec = [slot[1] === 'R' ? 1 : -1, 0, slot[0] === 'F' ? 1 : -1];
  return { edge, corner: [edge[0], -1, edge[2]] };
}

/** Slot name of an E-layer edge or D-layer corner position, else null. */
export function slotOf(p: Vec): SlotName | null {
  const n = Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]);
  if (n === 2 && p[1] === 0) return posName(p) as SlotName;
  if (n === 3 && p[1] === -1) return posName(p).slice(1) as SlotName;
  return null;
}

// ---- sheet notation --------------------------------------------------------------------------

/**
 * The sheet writes U2', R2' and pairs like U'D; the shared parser does not. One space-separated
 * token per turn, half turns unprimed, so tokens()/inverse()/cubejs all accept it.
 */
// TODO(shared): fold into cube/alg.ts tokens() if another sheet ever needs it
export function normalizeAlg(alg: string): string {
  return (alg.replace(/[()[\]]/g, ' ').match(/[URFDLBMESxyzurfdlb]w?[2']*/g) || [])
    .map((t) => { const m = /^([A-Za-z])(w?)([2']*)$/.exec(t)!; const base = m[2] ? m[1].toLowerCase() : m[1]; return base + (m[3].includes('2') ? '2' : m[3]); })
    .join(' ');
}
const algTokens = (alg: string): string[] => tokens(normalizeAlg(alg));
export const invert = (alg: string): string => inverse(normalizeAlg(alg));

export function uCount(tok: string): number {
  if (!tok) return 0;
  if (tok === 'U') return 1;
  if (tok === 'U2') return 2;
  return 3;
}
export function uTok(n: number): string { return ['', 'U', 'U2', "U'"][((n % 4) + 4) % 4]; }

/**
 * An alg's own (U) bracket combined with the AUF of the position tapped: the AUF to do first, and the rest in
 * canonical tokens (the sheet's L2' is L2 here: the trainer's rows tokenize it with the strict parser, which
 * threw on it, 2026-09-26).
 */
export function withAuf(auf: string, alg: string): { pre: string; rest: string } {
  const m = /^\(([^)]*)\)\s*(.*)$/.exec(alg);
  let pre = 0, rest = alg;
  if (m) { pre = uCount(m[1].replace(/2'$/, '2')); rest = m[2]; }
  return { pre: uTok(uCount(auf) + pre), rest: normalizeAlg(rest) };
}
/** The alg to do from the position tapped, AUF first, in canonical tokens (the sheet's U2' becomes U2). */
export const fullAlg = (auf: string, alg: string): string => { const { pre, rest } = withAuf(auf, alg); return normalizeAlg((pre ? `${pre} ` : '') + rest); };

export function acnUrl(full: string): string {
  const enc = (s: string) => s.replace(/'/g, '-').replace(/\s+/g, '_');
  return `https://alg.cubing.net/?setup=${enc(invert(full))}&alg=${enc(full)}&stickering=F2L`;
}

// ---- reading a facelet string ----------------------------------------------------------------

const orientOf = (face: string): CornerOrient => (face === 'U' || face === 'D' ? 'ud' : face === 'R' || face === 'L' ? 'rl' : 'fb');

export function slotState(f: string, slot: SlotName): SlotState {
  const c = findCorner(f, `D${slot}`, 'D');
  return { corner: { pos: c.name, o: orientOf(c.face) }, edge: posName(EDGE_POS[findEdge(f, slot)]) };
}

/** Both pieces home, the right way round (by position, so it also reads mid-alg states). */
export function slotSolved(f: string, slot: SlotName): boolean {
  const { edge, corner } = slotPositions(slot);
  return cubieSolved(f, edge) && cubieSolved(f, corner);
}

export const lookupKey = (corner: CornerState, edge: string): string => `${corner.pos}-${corner.o}|${edge}`;

/** The sheet's case for a placed pair, with the AUF that lines it up, or null when the sheet has none. */
export function findCase(slot: SlotName, corner: CornerState, edge: string): { hit: LookupHit; c: F2LCase } | null {
  const hit = DATA.slots[slot].lookup[lookupKey(corner, edge)];
  return hit ? { hit, c: DATA.slots[slot].cases[hit.n] } : null;
}

/** A random position from the sheet's lookup for this slot. */
export function randomCase(slot: SlotName, rnd: () => number = Math.random): { corner: CornerState; edge: string } {
  const keys = Object.keys(DATA.slots[slot].lookup);
  const [cpart, epart] = keys[Math.floor(rnd() * keys.length)].split('|');
  const [pos, o] = cpart.split('-');
  return { corner: { pos, o: o as CornerOrient }, edge: epart };
}

// ---- scrambles -------------------------------------------------------------------------------

/** 25 random face turns, WCA-style. */
export function genFull(n = 25): string { return randomScramble(n); }

// F2L practice: a random walk in G = <U, R, L, D, F2, B2> (no F/B quarter turns, so EO is kept),
// then the shortest cross fix in G. Cross edges are then home and still oriented: solved.
const G_MOVES: readonly Move[] = FACE_MOVES.filter((m) => 'URLD'.includes(m.face) || m.times === 2);
const AXIS: Record<string, number> = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
let crossDist: Map<string, number> | null = null;
const slotsKey = (st: EdgeState) => st.slots.join(',');

/** Distance of every cross-edge placement from solved under G (11880 states, built once). */
function crossTable(): Map<string, number> {
  if (crossDist) return crossDist;
  const start: EdgeState = { eo: 0, slots: [4, 5, 6, 7] };
  crossDist = new Map([[slotsKey(start), 0]]);
  let frontier = [start];
  while (frontier.length) {
    const next: EdgeState[] = [];
    for (const s of frontier) {
      const d = crossDist.get(slotsKey(s))!;
      for (const m of G_MOVES) {
        const t = applyEdgeMove(s, edgeMoveOf(m));
        if (!crossDist.has(slotsKey(t))) { crossDist.set(slotsKey(t), d + 1); next.push(t); }
      }
    }
    frontier = next;
  }
  return crossDist;
}

/** Moves in G that put the white edges back (greedy descent on the table). */
function crossFix(f: string): Move[] {
  const dist = crossTable();
  let cur = edgeState(f);
  let d = dist.get(slotsKey(cur))!;
  const out: Move[] = [];
  while (d > 0) {
    for (const m of G_MOVES) {
      const t = applyEdgeMove(cur, edgeMoveOf(m)), e = dist.get(slotsKey(t));
      if (e !== undefined && e < d) { out.push(m); cur = t; d = e; break; }
    }
  }
  return out;
}

/** A scramble in G with EO and the cross solved and the pairs and top layer mixed. */
export function genF2L(rnd: () => number = Math.random): string {
  for (;;) {
    const walk: Move[] = [];
    let p1 = '', p2 = '';
    while (walk.length < 16) {
      const m = G_MOVES[Math.floor(rnd() * G_MOVES.length)];
      if (m.face === p1) continue;
      if (p2 && AXIS[m.face] === AXIS[p1] && AXIS[m.face] === AXIS[p2]) continue;
      walk.push(m); p2 = p1; p1 = m.face;
    }
    const alg = movesStr(mergeMoves([...walk, ...crossFix(state(movesStr(walk)))]));
    if (stageOf(state(alg)).pairs < 4) return alg; // an all-pairs-solved walk is no practice
  }
}

// ---- following an alg move by move (absolute space) -------------------------------------------

const CROSS_POS: readonly Vec[] = [[0, -1, 1], [1, -1, 0], [0, -1, -1], [-1, -1, 0]];
const cornerPos = (f: string, slot: SlotName) => findCorner(f, `D${slot}`, 'D').pos;
const edgePos = (f: string, slot: SlotName) => EDGE_POS[findEdge(f, slot)];
/** Any sticker of the slot's pair is in the top layer. */
const liftedU = (f: string, slot: SlotName) => cornerPos(f, slot)[1] === 1 || edgePos(f, slot)[1] === 1;
const crossUp = (f: string) => ['DF', 'DR', 'DB', 'DL'].some((e) => EDGE_POS[findEdge(f, e)][1] === 1);
const crossHome = (f: string) => CROSS_POS.every((p) => cubieSolved(f, p));

// the two basic 3-move inserts of each slot, and the picture each solves (measured: state(invert(m)))
const INSERTS: Record<SlotName, [string, string][]> = {
  FR: [["R U R'", 'corner above the slot, white on the right, edge at the back'], ["R U' R'", 'corner and edge joined over the front-left, white on the left']],
  FL: [["L' U' L", 'corner above the slot, white on the left, edge at the back'], ["L' U L", 'corner and edge joined over the front-right, white on the right']],
  BR: [["R' U' R", 'corner above the slot, white on the right, edge at the front'], ["R' U R", 'corner and edge joined over the back-left, white on the left']],
  BL: [["L U L'", 'corner above the slot, white on the left, edge at the front'], ["L U' L'", 'corner and edge joined over the back-right, white on the right']],
};
const POP: Record<SlotName, string> = { FR: "R U' R' / R U R'", FL: "L' U L / L' U' L", BR: "R' U R / R' U' R", BL: "L U L' / L U' L'" };

/**
 * Other slots (not the target, not the ones the pair occupies) whose pieces get lifted into the
 * top layer during `alg` and are back home at the end: the alg borrows them, so they must be
 * solved or empty when you start.
 */
export function borrowedSlots(slot: SlotName, alg: string, occ: ReadonlySet<string>): SlotName[] {
  const seen = new Set<SlotName>();
  for (const f of stepStates(SOLVED, normalizeAlg(alg))) {
    for (const s of SLOTS) if (s !== slot && !occ.has(s) && liftedU(f, s)) seen.add(s);
  }
  const end = state(normalizeAlg(alg));
  return [...seen].filter((s) => slotSolved(end, s));
}

// ---- explaining an alg: every claim read off the alg's own moves (test/f2l-explain.test.ts holds each to it) ----

/** The pair in one state: the corner's position and where its white faces, the edge's position and flip. */
function pairSig(f: string, slot: SlotName): string {
  const c = findCorner(f, `D${slot}`, 'D');
  const ep = edgePos(f, slot);
  const i = facesAt(ep).find((k) => f[k] === slot[0])!;
  return `${c.name}${c.face}|${posName(ep)}${STICKERS[i].face}`;
}
const READY = new Map<SlotName, Set<string>>();
/** Every picture a basic insert solves from, with any U turn first. */
function readySigs(slot: SlotName): Set<string> {
  let r = READY.get(slot);
  if (!r) {
    r = new Set(['', 'U', 'U2', "U'"].flatMap((u) => INSERTS[slot].map(([m]) => pairSig(state(invert(`${u} ${m}`.trim())), slot))));
    READY.set(slot, r);
  }
  return r;
}
interface PairAt { cAt: string; eAt: string; cU: boolean; eU: boolean; cHome: boolean; eHome: boolean; white: string; joined: boolean; ready: boolean }
function pairAt(f: string, slot: SlotName): PairAt {
  const c = findCorner(f, `D${slot}`, 'D');
  const ep = edgePos(f, slot);
  const home = slotPositions(slot);
  const cU = c.pos[1] === 1, eU = ep[1] === 1;
  let joined = false;
  if (cU && eU && ((ep[0] === 0 && ep[2] === c.pos[2]) || (ep[2] === 0 && ep[0] === c.pos[0]))) {
    const ci = facesAt(c.pos);
    joined = facesAt(ep).every((i) => f[i] === f[ci.find((k) => STICKERS[k].face === STICKERS[i].face)!]);
  }
  return { cAt: c.name, eAt: posName(ep), cU, eU, cHome: cubieSolved(f, home.corner), eHome: cubieSolved(f, home.edge), white: c.face, joined, ready: readySigs(slot).has(pairSig(f, slot)) };
}
/** Net quarter turns of `face` in `toks`, mod 4. */
const netTurns = (toks: readonly string[], face: string): number =>
  toks.filter((t) => t[0] === face).reduce((n, t) => n + (t.endsWith("'") ? 3 : t.endsWith('2') ? 2 : 1), 0) % 4;
const FB_WORD: Record<string, string> = { F: 'front', B: 'back' };

/**
 * One paragraph on why the alg has the shape it has: a short head (the finder's hint) and a body. The alg is
 * followed move by move from the position it solves (its own AUF done first), and every sentence is one the
 * moves bear out; where a shape has no simple true story the body says less.
 */
export function explain(slot: SlotName, c: F2LCase, alg: string): { head: string; body: string } {
  const full = fullAlg('', alg);
  const { pre, rest } = withAuf('', alg);
  const toks = rest ? tokens(rest) : [];
  const n = toks.length;
  const start = state(invert(full));
  const s0 = pre ? stepStates(start, pre).at(-1)! : start;
  const S = [s0, ...stepStates(s0, toks.join(' '))].map((f) => pairAt(f, slot));
  const cU = c.corner.startsWith('U'), eU = c.edge.startsWith('U');
  const cIn = c.corner === `D${slot}`, eIn = c.edge === slot;
  const cSlot = cU ? null : c.corner.slice(1), eSlot = eU ? null : c.edge;
  const cOther = cSlot && cSlot !== slot ? cSlot : null, eOther = eSlot && eSlot !== slot ? eSlot : null;
  const twisted = cIn && c.co !== 'ud';
  const word = (s: string) => (isSlot(s) ? SLOT_WORD[s] : s);
  const oWord = { ud: 'white up', fb: 'white facing front/back', rl: 'white facing right/left' }[c.co];
  // when each piece first leaves the spot it starts in (state index; the move is toks[k - 1])
  const cUp = S.findIndex((x) => x.cAt !== S[0]!.cAt), eUp = S.findIndex((x) => x.eAt !== S[0]!.eAt);
  const upBy = (k: number) => (k > 0 ? toks[k - 1]! : '');
  const joinedEver = S.some((x) => x.joined);
  const ins = INSERTS[slot].find(([m]) => toks.slice(-3).join(' ') === m);
  const tail = ins && n > 3 ? ` The last three moves are the basic ${ins[0]} insert.` : '';
  // the first state from which U turns and a basic insert finish, reached using only `faces` (and U) before it
  const readyVia = (from: number, faces: string) => {
    const r = S.findIndex((x, i) => i >= from && x.ready);
    return r >= 0 && toks.slice(0, r).every((t) => t[0] === 'U' || faces.includes(t[0])) ? r : -1;
  };
  // which of two pieces comes out first: 'the edge out first, then the corner' (`out` = ' out') or '... first, then ...'
  const order = (a: string, ka: number, b: string, kb: number, out = '') => (ka < kb ? `${a}${out} first, then ${b}` : ka > kb ? `${b}${out} first, then ${a}` : `${a} and ${b}${out} on the same move`);

  const usesD = toks.some((t) => t[0] === 'D');
  const qFB = toks.find((t) => /^[FB]'?$/.test(t));
  const hFB = toks.find((t) => /^[FB]2$/.test(t));
  const slice = toks.some((t) => /^[urfdlbMESxyz]/.test(t));
  const allHalf = toks.every((t) => /2/.test(t) || t[0] === 'U') && toks.some((t) => /2/.test(t) && t[0] !== 'U');
  // the move that puts the pair in for good
  let lastIn = S.length - 1;
  while (lastIn > 0 && S[lastIn - 1]!.cHome && S[lastIn - 1]!.eHome) lastIn--;
  const cornerHomeBy = (() => { let k = S.length - 1; while (k > 0 && S[k - 1]!.cHome) k--; return upBy(k); })();
  const eStays = S.every((x) => x.eHome);
  const dBack = netTurns(toks, 'D') === 0 ? '; they cancel out, so the cross ends where it started' : '';

  let head: string, body: string;
  if (usesD && eIn && eStays && cOther && cornerHomeBy[0] === 'D') {
    head = 'Slide the corner under.';
    body = `The edge is already solved in the slot and never moves. The corner is popped out of the ${word(cOther)} slot and put back into the bottom layer, and the D turns carry it round underneath the edge${dBack}.`;
  } else if (usesD && eIn && eStays && cU && cornerHomeBy[0] === 'D') {
    head = 'Corner under the edge.';
    body = `The edge is already solved in the slot and never moves. The corner goes into the bottom layer at another spot, and the D turns carry it round underneath the edge${dBack}.`;
  } else if (allHalf) {
    head = 'Half-turn shuffle.';
    body = 'Half turns (with U turns) move pieces between the top layer and the slots without changing which way they face. Both pieces already face the right way, so this shuffle is enough to route them home.';
  } else if (usesD) {
    head = 'D-layer conjugate.';
    body = `The D turns swing the bottom layer round while the other moves work${dBack}.`;
  } else if (qFB) {
    const inv = invert(qFB);
    head = qFB[0] === 'F' ? 'F conjugate.' : 'B conjugate.';
    const k = toks.indexOf(qFB);
    body = `A quarter turn of the ${FB_WORD[qFB[0]]} (${qFB}) flips edges, so ${toks.indexOf(inv, k + 1) > k ? `it is paired with ${inv} later in the alg and ` : ''}every edge is oriented again at the end.`;
    if (S[k]!.cHome && S[k + 1]!.cU) body += ` Here ${qFB} opens the slot by lifting the solved corner out.`;
  } else if (hFB) {
    const lastBy = upBy(lastIn);
    head = hFB[0] === 'F' ? 'F2 flip.' : 'B2 flip.';
    body = `A half turn of the ${FB_WORD[hFB[0]]} (${hFB}) moves pieces across that face without flipping any edge.`;
    if (/^[FB]2$/.test(lastBy)) body += ` Here ${lastBy} is the move that puts the pair in; the moves before it line the pieces up for it.`;
  } else if (slice) {
    head = 'Slice shuffle.';
    const centresBack = Object.entries(CENTRE).every(([face, i]) => rawFacelets(full)[i] === face);
    body = `The wide and slice turns carry a middle layer along, so the turns in between can move pieces through it${centresBack ? '; they cancel out by the end, leaving the centres where they started' : ''}.`;
  } else if (cU && eU) {
    if (n === 3) {
      head = 'Direct insert.';
      const pic = ins ? ` (${ins[1]})` : '';
      body = S[0]!.joined
        ? `The corner and edge are already joined in the top layer${pic}. This is a basic 3-move insert: the first turn lifts the slot, the U turn brings the pair over it, and the last turn drops it in.`
        : `The corner and edge are apart in the top layer${pic}. This is a basic 3-move insert: the first turn lifts the slot, the U turn joins the pair over it, and the last turn drops it in.`;
    } else if (c.co === 'ud') {
      head = 'Tilt, then insert.';
      const k = S.findIndex((x) => x.white !== 'U');
      body = `With white facing up the corner can't be joined to the edge and dropped straight in. The opening moves turn it so white no longer faces up (move ${k}, ${upBy(k)})${tail ? ' and set the pair up for a basic insert.' : ', and the rest inserts the pair.'}${tail}`;
    } else {
      head = 'Split and re-pair.';
      body = `Both pieces are in the top layer but not lined up for a basic insert (${oWord}). The opening moves reposition them${tail ? ' into one of the two basic insert pictures.' : ', and the rest inserts the pair.'}${tail}`;
    }
  } else if (twisted && eIn) {
    head = 'Pair in, corner twisted.';
    const lifted = S[3]?.cU && S[3]?.eU;
    body = `Both pieces are in the slot but the corner is rotated. The pair has to come out and go back in: ${lifted ? 'the first three moves lift both pieces out' : 'the opening moves take them out'}, then ${joinedEver ? "they're joined again in the top layer and inserted" : 'they go back in the right way round'}.${tail}`;
  } else if (twisted && eOther) {
    head = 'Twisted corner, pop the edge.';
    body = `The edge is in the ${word(eOther)} slot and the corner is in its own slot the wrong way round. The alg takes ${order('the edge', eUp, 'the corner', cUp, ' out')}, and ${joinedEver ? 're-inserts them as a pair' : 'puts them back in together'}.${tail}`;
  } else if (twisted && eU) {
    head = 'Twisted corner in slot.';
    body = `The corner is in the right slot but rotated. It has to come out and go back in with the edge${joinedEver ? ', joined to it in the top layer' : ''}.${tail}`;
  } else if (cIn && eU) {
    head = joinedEver ? 'Lift the corner, re-pair.' : 'Corner out and back.';
    body = `The corner is home but its edge is on top, and the corner is in the way. The alg takes the corner out${joinedEver ? ', joins it to the edge in the top layer and puts the pair back in' : ' and brings it back in with the edge by the end'}.${tail}`;
  } else if (eIn && cU) {
    head = 'Edge in, corner out.';
    body = `The edge is sitting in the slot without its corner. The alg pulls it out${joinedEver ? ', joins it to the corner in the top layer' : ''} and inserts the pair properly.${tail}`;
  } else if (cOther && eOther) {
    const own = cOther.includes(upBy(cUp)[0] ?? '-') && eOther.includes(upBy(eUp)[0] ?? '-');
    head = 'Two pops, then insert.';
    const where = cOther === eOther ? `Both pieces are in the ${word(cOther)} slot. They are popped out${own ? " with that slot's own turns" : ''}` : `The corner is in the ${word(cOther)} slot and the edge in the ${word(eOther)} slot. Each is popped out${own ? " with its own slot's turns" : ''}`;
    body = `${where}, ${order('the corner', cUp, 'the edge', eUp)}${joinedEver ? ', so they meet in the top layer and join' : ''}.${tail}`;
  } else if (cOther && eIn) {
    const own = cOther.includes(upBy(cUp)[0] ?? '-');
    head = 'Edge out, pop the corner.';
    body = `The edge is in the slot without its corner, and the corner is in the ${word(cOther)} slot. The alg takes ${order('the edge', eUp, 'the corner', cUp, ' out')}${own ? ", popping the corner with its slot's own turns" : ''}${joinedEver ? ', joins them in the top layer' : ''} and inserts the pair.${tail}`;
  } else if (eOther && cIn) {
    const own = eOther.includes(upBy(eUp)[0] ?? '-');
    head = 'Corner out, pop the edge.';
    body = `The corner is home without its edge, and the edge is in the ${word(eOther)} slot. The alg takes ${order('the corner', cUp, 'the edge', eUp, ' out')}${own ? ", popping the edge with its slot's own turns" : ''}${joinedEver ? ', joins them in the top layer' : ''} and inserts the pair.${tail}`;
  } else if (cOther) {
    const r = readyVia(cUp, cOther);
    head = 'Pop the corner, then insert.';
    body = `The corner is in the ${word(cOther)} slot.${r > 0 ? " The first moves pop it out with that slot's own turns so it lands ready for a basic insert." : ` It is popped out${cOther.includes(upBy(cUp)[0] ?? '-') ? " with that slot's own turns" : ''}, and the rest ${joinedEver ? 'joins it to the edge and ' : ''}inserts the pair.`}${tail}`;
  } else if (eOther) {
    const r = readyVia(eUp, eOther);
    head = 'Pop the edge, then insert.';
    body = `The edge is in the ${word(eOther)} slot.${r > 0 ? " The first moves pop it out with that slot's own turns so it lands ready for a basic insert." : ` It is popped out${eOther.includes(upBy(eUp)[0] ?? '-') ? " with that slot's own turns" : ''}, and the rest ${joinedEver ? 'joins it to the corner and ' : ''}inserts the pair.`}${tail}`;
  } else {
    head = 'Pop, then insert.';
    body = `Pieces in wrong slots are popped out with that slot's own moves (${POP[slot]} style), then inserted normally.${tail}`;
  }

  // other slots the alg goes through: lifted and put back (whatever is there comes back), or left changed (a shortcut)
  const occ = new Set([cSlot, eSlot].filter((s): s is string => !!s));
  const bor = borrowedSlots(slot, alg, occ);
  if (bor.length) {
    const names = `${bor.map((s) => SLOT_WORD[s]).join(' and ')} ${bor.length > 1 ? "slots'" : "slot's"}`;
    const fs = [SOLVED, ...stepStates(SOLVED, normalizeAlg(full))], all = algTokens(full);
    const liftMoves = bor.flatMap((b) => fs.slice(1).flatMap((f, i) => (!liftedU(fs[i]!, b) && liftedU(f, b) ? [all[i]!] : [])));
    const byHalf = liftMoves.every((t) => /2/.test(t));
    if (cU && eU && !usesD && !qFB && !hFB && !slice && n > 3) head = 'Borrow a neighbouring slot.';
    body += ` Along the way it lifts the ${names} pieces out${byHalf ? ' (the half turns do that)' : ''} and puts them back before the end, so whatever is in ${bor.length > 1 ? 'those slots ends up where it was' : 'that slot ends up where it was'}.`;
  }
  const end = state(normalizeAlg(full));
  const used = SLOTS.filter((s) => s !== slot && !occ.has(s) && !slotSolved(end, s));
  if (used.length) {
    const names = used.map((s) => SLOT_WORD[s]).join(' and ');
    body += ` This is a slot shortcut: it runs through the ${names} slot${used.length > 1 ? 's' : ''} and leaves other pieces there, so use it only while ${used.length > 1 ? 'those slots are' : 'that slot is'} still unsolved.`;
  }
  return { head, body };
}

/** Where the pair is, in words, for the result panel. */
export function describe(corner: CornerState | null, edge: string | null): string {
  const oWord: Record<CornerOrient, string> = { ud: 'white facing up', rl: 'white facing right/left', fb: 'white facing front/back' };
  const cs = corner ? (corner.pos.startsWith('U') ? `corner at ${corner.pos}, ${oWord[corner.o]}` : `corner in the ${SLOT_WORD[corner.pos.slice(1) as SlotName]} slot, ${oWord[corner.o].replace('up', 'down')}`) : '';
  const es = edge ? (edge.startsWith('U') ? `edge at ${edge}` : `edge in the ${SLOT_WORD[edge as SlotName]} slot`) : '';
  return [cs, es].filter(Boolean).join('; ');
}

export interface Trace {
  caption: string;
  /** move, where the corner went, where the edge went, purpose */
  rows: [string, string, string, string][];
}

const FACE_WORD: Record<string, string> = { U: 'up', D: 'down', F: 'front', B: 'back', R: 'right', L: 'left' };
/** Every cubie by its letters -> where it is (position key, its y, and which facelet shows which letter). */
type PieceMap = Map<string, { pos: string; y: number; sig: string }>;
function pieceMap(f: string): PieceMap {
  const m: PieceMap = new Map();
  const seen = new Set<string>();
  for (const s of STICKERS) {
    const k = key(s.pos);
    if (seen.has(k)) continue;
    seen.add(k);
    const idx = facesAt(s.pos);
    m.set(idx.map((i) => f[i]).sort().join(''), { pos: k, y: s.pos[1], sig: idx.map((i) => `${i}${f[i]}`).join(' ') });
  }
  return m;
}

/**
 * What each move of `full` does to the pair, rule-labelled: inserts, pops, lifts, setups and their
 * undos, and which bystander spot a move clears. Starts from the state the alg solves.
 */
export function trace(slot: SlotName, full: string): Trace {
  const toks = algTokens(full);
  const others = SLOTS.filter((s) => s !== slot);
  const { edge: ePos, corner: cPos } = slotPositions(slot);
  const cId = ['D', ...slot].sort().join(''), eId = [...slot].sort().join('');
  const start = state(invert(full));
  const states = [start, ...stepStates(start, toks.join(' '))];
  const snaps = states.map(pieceMap);
  const snap = (f: string) => {
    const c = findCorner(f, `D${slot}`, 'D');
    const sl = {} as Record<SlotName, boolean>;
    for (const s of others) sl[s] = slotSolved(f, s);
    const cHome = cubieSolved(f, cPos), eHome = cubieSolved(f, ePos);
    return { cp: c.name, wf: FACE_WORD[c.face], ep: posName(edgePos(f, slot)), cHome, eHome, pairOk: cHome && eHome, cross: crossHome(f), sl };
  };
  const isU = (t: string) => t[0] === 'U';
  const inv = (t: string) => invert(t);
  // bracket (i,j): j is the nearest later inverse of i such that every non-pair, non-top-layer piece moved by i
  // is back where it was before i; skip pure triggers (only U and the slot's side moves inside)
  const undoOf: Record<number, number> = {}, setupOf: Record<number, number> = {};
  for (let i = 0; i < toks.length; i++) {
    if (isU(toks[i])) continue;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j] !== inv(toks[i]) || undoOf[j] !== undefined) continue;
      const own = new Set(['U', slot[1]]);
      if (toks.slice(i + 1, j).every((x) => own.has(x[0]))) continue; // plain trigger, not a conjugate
      let ok = true;
      for (const [id, before] of snaps[i]) {
        const after = snaps[i + 1].get(id)!;
        if (before.sig === after.sig) continue; // not moved by i
        if (id === cId || id === eId) continue;
        if (id.includes('U')) continue; // a top-layer piece: junk
        if (before.y === 1) continue; // was sitting in the top layer: not something we're protecting
        if (snaps[j + 1].get(id)!.sig !== before.sig) { ok = false; break; }
      }
      if (ok) { undoOf[j] = i; setupOf[i] = j; break; }
    }
  }
  const insertsHere = INSERTS[slot].map(([m]) => m);
  const first = snap(start);
  const occStart = new Set([first.cp.startsWith('U') ? null : first.cp.slice(1), first.ep.startsWith('U') ? null : first.ep].filter((x): x is string => !!x && x !== slot));
  const slotWord = (p: string) => { if (p.startsWith('U')) return p; const s = p.startsWith('D') ? p.slice(1) : p; return isSlot(s) ? `in ${SLOT_WORD[s]}` : p; };
  const rows: Trace['rows'] = [];
  let prev = first;
  let prevLift = {} as Record<SlotName, boolean>;
  for (const o of others) prevLift[o] = liftedU(start, o);
  let prevCrossUp = crossUp(start);
  toks.forEach((t, k) => {
    const f = states[k + 1];
    const s = snap(f);
    const lab: string[] = [];
    const cMoved = s.cp !== prev.cp || s.wf !== prev.wf, eMoved = s.ep !== prev.ep;
    if (s.pairOk && !prev.pairOk) lab.push('insert: pair solved');
    else if (s.cHome && !prev.cHome) lab.push('corner in');
    else if (s.eHome && !prev.eHome) lab.push('edge in');
    if (!s.pairOk) {
      const word = (p: string) => (isSlot(p) ? SLOT_WORD[p] : p);
      if (!prev.cp.startsWith('U') && s.cp.startsWith('U')) lab.push(prev.cHome ? 'lift corner out' : `pop corner out of ${word(prev.cp.slice(1)) || prev.cp}`);
      if (!prev.ep.startsWith('U') && s.ep.startsWith('U')) lab.push(prev.eHome ? 'lift edge out' : `pop edge out of ${word(prev.ep)}`);
      if (prev.cp.startsWith('U') && !s.cp.startsWith('U') && !s.cHome) lab.push(s.cp.slice(1) === slot ? 'push corner into its slot the wrong way (temporary)' : `tuck corner into ${isSlot(s.cp.slice(1)) ? SLOT_WORD[s.cp.slice(1) as SlotName] : 'the bottom layer'} for now`);
      if (prev.ep.startsWith('U') && !s.ep.startsWith('U') && !s.eHome) lab.push(`tuck edge into ${isSlot(s.ep) ? SLOT_WORD[s.ep] : 'the bottom layer'} for now`);
    }
    const lift = {} as Record<SlotName, boolean>;
    for (const o of others) lift[o] = liftedU(f, o);
    const cu = crossUp(f);
    for (const o of others) {
      if (occStart.has(o)) continue;
      if (!prevLift[o] && lift[o]) lab.push(`lift ${SLOT_WORD[o]} pair out`);
      if (prevLift[o] && !lift[o] && s.sl[o]) lab.push(`return ${SLOT_WORD[o]} pair`);
    }
    if (!prevCrossUp && cu) lab.push('cross edge comes up');
    if (prevCrossUp && !cu && s.cross) lab.push('cross edge back');
    const rest = toks.slice(k + 1).join(' ');
    if (isU(t)) { if (insertsHere.includes(rest)) lab.push('line up for the insert'); else if (cMoved || eMoved) lab.push('reposition'); else lab.push('turn the top layer for the pieces around'); }
    if (setupOf[k] !== undefined) lab.push(`setup (undone by move ${setupOf[k] + 1})`);
    if (undoOf[k] !== undefined) lab.push(`undo move ${undoOf[k] + 1}`);
    if (!lab.length && !isU(t) && prev.wf === 'up' && s.wf !== 'up' && s.cp.startsWith('U')) lab.push('tilt the corner: white off the top');
    if (!lab.length && !isU(t)) {
      let pi = k - 1;
      while (pi >= 0 && isU(toks[pi])) pi--;
      if (pi >= 0 && toks[pi] === inv(t) && !(cMoved || eMoved)) lab.push(`bring the layer back (undo move ${pi + 1})`);
    }
    if (!lab.length && !isU(t) && (cMoved || eMoved)) lab.push(cMoved && eMoved ? 'carry both pieces around' : cMoved ? 'carry the corner around' : 'carry the edge around');
    if (!lab.length && !isU(t)) {
      // does this move empty the spot our corner/edge enters later?
      let found: string | null = null;
      for (let m = k + 1; m < toks.length && !found; m++) {
        const cb = snaps[m], cm = snaps[m + 1];
        for (const [which, id] of [['corner', cId], ['edge', eId]] as const) {
          const pb = cb.get(id)!, pa = cm.get(id)!;
          if (pb.pos === pa.pos || pa.y === 1) continue;
          // enters a non-top spot at move m: was that spot cleared by move k?
          const occAtK = [...snaps[k].entries()].find(([oid, v]) => v.pos === pa.pos && oid !== id);
          if (occAtK && snaps[k + 1].get(occAtK[0])!.pos !== pa.pos) {
            const p = pa.pos.split(',').map(Number) as unknown as Vec;
            found = `clear the ${slotWord(posName(p)).replace(/^in /, '')} spot for the ${which} (move ${m + 1})`;
          }
          break;
        }
      }
      lab.push(found || 'shuffle bystanders');
    }
    const cTxt = cMoved ? `${slotWord(s.cp)}, white ${s.wf}` : '–', eTxt = eMoved ? slotWord(s.ep) : '–';
    rows.push([`${k + 1}. ${t}`, cTxt, eTxt, lab.join('; ')]);
    prev = s; prevLift = lift; prevCrossUp = cu;
  });
  return {
    caption: `Start: corner ${slotWord(first.cp)} with white ${first.wf}, edge ${slotWord(first.ep)}. Labels are rule-generated: what each move does, not always why.`,
    rows,
  };
}

// ---- the favourite alg: any of a case's algs (the sheet's, a slot shortcut, the R/L/U one) can be made
// its main (as a last-layer case's can, ll/cases.ts), which is what the finder lists first, follows and
// solves the pair with on "Solved, next pair". The data table stays as generated; the choice lives here.
// Keeping it (the store's favs collection, synced) is ll/favs.ts's job, so this stays pure for the tests.
const FAV = new Map<string, string>();
/** A case's id for the store: its slot and number ('FR-4'). */
export const caseId = (slot: SlotName, n: number): string => `${slot}-${n}`;
/** The case an id names, or null. */
export function caseOf(id: string): { slot: SlotName; c: F2LCase } | null {
  const m = /^(FR|FL|BR|BL)-(\d+)$/.exec(id);
  if (!m) return null;
  const slot = m[1] as SlotName, c = DATA.slots[slot].cases[m[2]!];
  return c ? { slot, c } : null;
}
/** Every alg a case has: the sheet's, then the slot shortcuts, then the searched R/L/U one when there is one. */
export function allAlgs(c: F2LCase): string[] {
  const out = [...c.algs, ...c.others.map((o) => o.alg)];
  if (c.simple_src === 'search') out.push(c.simple);
  return [...new Set(out)];
}
export function f2lCaseIds(): string[] { return SLOTS.flatMap((s) => Object.values(DATA.slots[s].cases).map((c) => caseId(s, c.n))); }
/** The table's own main: the shortest sheet alg. */
export function f2lStandardAlg(id: string): string | undefined { const c = caseOf(id)?.c; return c && byLength(c.algs)[0]; }
/** The alg the finder leads with: the favourite, else the standard. */
export function f2lMainAlg(id: string): string | undefined { return FAV.get(id) ?? f2lStandardAlg(id); }
export function f2lIsFavourite(id: string): boolean { return FAV.has(id); }
/** Make `alg` (one the case has) its main; null puts the standard back. False for an alg the case lacks. */
export function f2lSetMainAlg(id: string, alg: string | null): boolean {
  const hit = caseOf(id);
  if (!hit) return false;
  if (alg !== null && !allAlgs(hit.c).includes(alg)) return false;
  if (alg === null || alg === f2lStandardAlg(id)) FAV.delete(id); else FAV.set(id, alg);
  return true;
}
/**
 * The algs to list for a case, main first: the favourite when there is one, else the sheet's shortest alg
 * from the position at hand (`auf` the lookup's; advanced) or the R/L/U-only one (simple). The rest of the
 * sheet's algs follow, shortest first; the slot shortcuts are the caller's to add (they need free slots).
 */
export function orderedAlgs(slot: SlotName, c: F2LCase, advanced: boolean, auf = ''): string[] {
  const fav = FAV.get(caseId(slot, c.n));
  const rest = advanced ? byLength(c.algs, auf) : [];
  const main = fav ?? (advanced ? rest[0]! : c.simple);
  return [main, ...rest.filter((a) => a !== main)];
}
/**
 * Algs shortest first as they will be done from the position at hand - `auf` (the lookup's) folded into each
 * alg's own, so a cancelling AUF counts for nothing and an added one counts - the sheet's order among equals
 * (user, 2026-09-26: fewest moves lead, setup moves included).
 */
export function byLength(algs: readonly string[], auf = ''): string[] {
  return algs.map((a, i) => ({ a, i, n: moveCount(fullAlg(auf, a)) })).sort((x, y) => x.n - y.n || x.i - y.i).map((x) => x.a);
}

// ---- a case across the four slots, and where its pieces are -----------------------------------------------
// The sheet numbers each slot's tab on its own, so FL case 17 is not FR case 17 mirrored (2026-09-26: 187 of the
// 249 cases off front-right differ). The slots are mirrors of each other - the same hand motions reflected, as the
// algs are - so a case's number to show is its front-right twin's: the one the mirror onto front-right lands on.

const MIRROR_TO_FR: Record<SlotName, Record<string, string>> = { FR: {}, FL: { L: 'R', R: 'L' }, BR: { F: 'B', B: 'F' }, BL: { F: 'B', B: 'F', L: 'R', R: 'L' } };
const FACE_ORDER = 'UDFBRL';
const mirrorName = (name: string, m: Record<string, string>) => [...name].map((ch) => m[ch] ?? ch).sort((a, b) => FACE_ORDER.indexOf(a) - FACE_ORDER.indexOf(b)).join('');
let twins: Map<string, number> | null = null;
/** The front-right case a slot's case mirrors onto: the number the finder and the sheet show for it on every slot. */
export function twinOf(slot: SlotName, n: number): number {
  if (!twins) {
    twins = new Map();
    const norm = (k: string) => { const [c, e] = k.split('|'); const [pos, o] = c!.split('-'); return `${mirrorName(pos!, {})}-${o}|${mirrorName(e!, {})}`; };
    const fr = new Map(Object.entries(DATA.slots.FR.lookup).map(([k, v]) => [norm(k), v.n]));
    for (const s of SLOTS) for (const c of Object.values(DATA.slots[s].cases)) {
      const m = MIRROR_TO_FR[s];
      const n2 = fr.get(`${mirrorName(c.corner, m)}-${c.co}|${mirrorName(c.edge, m)}`);
      if (n2 === undefined) throw new Error(`${s} case ${c.n} has no front-right twin`);
      twins.set(caseId(s, c.n), n2);
    }
  }
  return twins.get(caseId(slot, n))!;
}
/** The slot's case that is front-right case `n` mirrored. */
export function caseOfTwin(slot: SlotName, n: number): F2LCase | undefined {
  return Object.values(DATA.slots[slot].cases).find((c) => twinOf(slot, c.n) === n);
}

/** Where a case's pieces are, as the groups the case sheet lists them in (from the picture, not the sheet's own sections). */
export type CaseGroup = 'top' | 'ctop-ein' | 'cin-etop' | 'twisted' | 'eother' | 'cother' | 'cin-eother' | 'cother-ein' | 'bothother';
export const GROUPS: readonly CaseGroup[] = ['top', 'ctop-ein', 'cin-etop', 'twisted', 'eother', 'cother', 'cin-eother', 'cother-ein', 'bothother'];
export const GROUP_WORD: Record<CaseGroup, string> = {
  top: 'Both on top',
  'ctop-ein': 'Corner on top, edge in its slot',
  'cin-etop': 'Corner in its slot, edge on top',
  twisted: 'Both in the slot, corner twisted',
  eother: 'Corner on top, edge in another slot',
  cother: 'Corner in another slot, edge on top',
  'cin-eother': 'Corner in its slot, edge in another slot',
  'cother-ein': 'Corner in another slot, edge in its slot',
  bothother: 'Both in other slots',
};
export function caseGroup(slot: SlotName, c: Pick<F2LCase, 'corner' | 'edge'>): CaseGroup {
  const cp = c.corner.startsWith('U') ? 'top' : c.corner.slice(1) === slot ? 'own' : 'other';
  const ep = c.edge.startsWith('U') ? 'top' : c.edge === slot ? 'own' : 'other';
  const g: Record<string, CaseGroup> = {
    'top top': 'top', 'top own': 'ctop-ein', 'own top': 'cin-etop', 'own own': 'twisted', 'top other': 'eother',
    'other top': 'cother', 'own other': 'cin-eother', 'other own': 'cother-ein', 'other other': 'bothother',
  };
  return g[`${cp} ${ep}`]!;
}

/**
 * Both pieces on top: already joined as a pair (touching, the two stickers they share the same colours), touching
 * the wrong way, or apart. Null when a piece is not on top.
 */
export function pairShape(slot: SlotName, c: Pick<F2LCase, 'corner' | 'co' | 'edge'>): 'joined' | 'touching' | 'apart' | null {
  if (!c.corner.startsWith('U') || !c.edge.startsWith('U')) return null;
  if (![...c.edge].every((ch) => c.corner.includes(ch))) return 'apart';
  const cm = DATA.slots[slot].cmap[`${c.corner}-${c.co}`]!, em = DATA.slots[slot].emap[c.edge]!;
  return [...c.edge].every((face) => cm[face] === em[face]) ? 'joined' : 'touching';
}

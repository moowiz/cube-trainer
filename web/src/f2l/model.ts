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

/// <reference path="../cubejs.d.ts" />
import { FACE_MOVES, inverse, mergeMoves, movesStr, tokens, type Move } from '../cube/alg';
import { facesAt, key, posName, STICKERS, type Vec } from '../cube/geometry';
import { applyEdgeMove, cubieSolved, EDGE_POS, edgeMoveOf, edgeState, findCorner, findEdge, type EdgeState } from '../cube/pieces';
import { SOLVED, state, stepStates } from '../cube/state';
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

/** An alg's own (U) bracket combined with the AUF of the position tapped: the AUF to do first, and the rest. */
export function withAuf(auf: string, alg: string): { pre: string; rest: string } {
  const m = /^\(([^)]*)\)\s*(.*)$/.exec(alg);
  let pre = 0, rest = alg;
  if (m) { pre = uCount(m[1].replace(/2'$/, '2')); rest = m[2]; }
  return { pre: uTok(uCount(auf) + pre), rest };
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

const INSERTS: Record<SlotName, [string, string][]> = {
  FR: [["R U R'", 'white on the right, edge at the back'], ["R U' R'", 'white on the front, edge on the right']],
  FL: [["L' U' L", 'white on the left, edge at the back'], ["L' U L", 'white on the front, edge on the left']],
  BR: [["R' U' R", 'white on the right, edge at the front'], ["R' U R", 'white on the back, edge on the right']],
  BL: [["L U L'", 'white on the left, edge at the front'], ["L U' L'", 'white on the back, edge on the left']],
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

/** One line on why the alg has the shape it has, from the case's picture and the moves it uses. */
export function explain(slot: SlotName, c: F2LCase, alg: string): { head: string; body: string } {
  const core = alg.replace(/^\([^)]*\)\s*/, '');
  const toks = algTokens(core);
  const n = toks.length;
  const cU = c.corner.startsWith('U'), eU = c.edge.startsWith('U');
  const cIn = c.corner === `D${slot}`, eIn = c.edge === slot;
  const cSlot = cU ? null : c.corner.slice(1), eSlot = eU ? null : c.edge;
  const usesD = toks.some((t) => /^D/.test(t)), usesF2 = toks.some((t) => /^[FB]2/.test(t)), usesF = toks.some((t) => /^[FB]'?$/.test(t)), wide = toks.some((t) => /^[urfl]/.test(t));
  const ends = INSERTS[slot].find(([m]) => core.endsWith(m));
  const tail = ends ? ` The last three moves are the basic ${ends[0]} insert.` : '';
  const oWord = { ud: 'white up', fb: 'white facing front/back', rl: 'white facing right/left' }[c.co];
  const word = (s: string | null) => (s && isSlot(s) ? SLOT_WORD[s] : s);
  let head: string, body: string;
  const twisted = c.corner === `D${slot}` && c.co !== 'ud' ? ' The corner is in its own slot but twisted, so it gets pulled out along the way.' : '';
  const allHalf = toks.every((t) => /2/.test(t) || /^U/.test(t)) && toks.some((t) => /2/.test(t));
  if (usesD && eIn && !cIn) { head = 'Slide the corner under.'; body = "The edge is already solved in the slot, so the alg never touches it. The corner is popped out, inserted with an ordinary insert into the neighbouring slot's corner spot, and then D' slides the bottom layer one notch so it ends up underneath the edge. The first D pre-rotates the bottom layer so that neighbouring spot holds junk rather than a solved corner, and the outer moves put that neighbour's corner back."; }
  else if (allHalf) { head = 'Half-turn shuffle.'; body = `Half turns of one side plus U turns cycle pieces between the top layer and the slots without ever changing orientation. Because both pieces are already oriented correctly, this shuffle is enough to route them home.${twisted}`; }
  else if (usesD) { head = 'D-layer conjugate.'; body = 'D turns temporarily rotate a helper slot under the working layer so an ordinary insert can use it, then D turns it back. The cross is only "broken" between the setup and the undo.'; }
  else if (usesF2) { head = 'F2 flip.'; body = 'A half turn of F is EO-safe. It swaps the top-right and bottom-left of the front face and flips white from up to down, so with the pieces lined up correctly one F2 inserts the pair; the moves around it are setup and undo.'; }
  else if (usesF) { head = 'F conjugate.'; body = "F cracks the slot open by lifting the solved corner, the middle moves slide the edge in from the top, F' closes it, and the remaining moves put back the cross edge and neighbouring pieces the F disturbed."; }
  else if (wide) { head = 'Slice shuffle.'; body = 'A wide move shifts the middle slice so a half-turn shuffle of one layer swaps pieces between slots, then the wide move undoes the shift.'; }
  else if (cU && eU) {
    if (n === 3) { head = 'Direct insert.'; body = `The pair is already formed above the slot (${oWord}); this is one of the two basic 3-move inserts.`; }
    else if (c.co === 'ud') { head = 'Tilt, then insert.'; body = `A corner with white facing up can't go in directly. The first moves push it into the slot the wrong way and pull it back out tilted, so it re-emerges with white on a side, then it's a normal pair-up and insert.${tail}`; }
    else { head = 'Split and re-pair.'; body = `Both pieces are in the top layer but not lined up (${oWord}). The opening moves reposition them into one of the two basic insert pictures.${tail}`; }
  }
  else if (twisted && eIn) { head = 'Pair in, corner twisted.'; body = `Both pieces are in the slot but the corner is rotated. The pair has to come out and go back in; the first three moves lift it, then it's re-paired and inserted.${tail}`; }
  else if (twisted && eSlot) { head = 'Twisted corner, pop the edge.'; body = `The edge is in the ${word(eSlot)} slot and the corner is in its own slot the wrong way round. The alg pops the edge, pulls the corner out, and re-inserts them as a pair.${tail}`; }
  else if (twisted && eU) { head = 'Twisted corner in slot.'; body = `The corner is in the right slot but rotated. It has to come out and go back in with the edge, which is what the first insert-shaped moves do.${tail}`; }
  else if (cIn && eU) { head = 'Keyhole.'; body = `The solved corner blocks the slot. The alg lifts it out with the edge nearby, re-pairs them in the top layer and reinserts.${tail}`; }
  else if (eIn && cU) { head = 'Edge in, corner out.'; body = `The edge is sitting in the slot without its corner. The alg pulls it out as part of a first insert attempt, re-pairs, and inserts properly.${tail}`; }
  else if (cSlot && eSlot && cSlot !== slot && eSlot !== slot) { head = 'Two pops, then insert.'; body = `The corner is in the ${word(cSlot)} slot and the edge in the ${word(eSlot)} slot. Each is popped out with its own slot's moves, in an order and direction chosen so they meet in the top layer already paired.${tail}`; }
  else if (cSlot && cSlot !== slot) { head = 'Pop the corner, then insert.'; body = `The corner is in the ${word(cSlot)} slot. The first moves pop it out with that slot's own turns so it lands next to the edge, ready for a basic insert.${tail}`; }
  else if (eSlot && eSlot !== slot) { head = 'Pop the edge, then insert.'; body = `The edge is in the ${word(eSlot)} slot. The first moves pop it out with that slot's own turns so it lands ready for a basic insert.${tail}`; }
  else { head = 'Pop, then insert.'; body = `Pieces in wrong slots are popped out with that slot's own moves (${POP[slot]} style), then inserted normally.${tail}`; }
  const occ = new Set([cSlot, eSlot].filter((s): s is string => !!s));
  const bor = borrowedSlots(slot, alg, occ);
  if (bor.length) {
    const names = bor.map((s) => SLOT_WORD[s]).join(' and ');
    if (cU && eU && !usesD && !usesF2 && !usesF && !wide && n > 3) head = 'Borrow a neighbouring slot.';
    body += ` Along the way it pulls the ${names} slot's pieces out (the half turns do that) and puts them back before the end, so that slot ends up untouched — it just needs to be either solved or empty when you start.`;
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

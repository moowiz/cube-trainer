// One solve, taken apart (docs/smart-cube-design.md 6.1, MILESTONES M11): the
// phases of a ZZ solve off its turns and their times, each with its time, its
// turns, the look before its first turn and the idle time inside it, and the
// case each pair and last-layer step was. Pure: a SolveRecord in, numbers out;
// the store keeps the facts and this is re-run on them (an analysis fix changes
// every number on the next read).
//
// Boundaries. EOCross, F2L, OCLL and PLL end the first time the cube is past
// them (the splits' rule, timer/splits.ts): an alg that dips back through an
// earlier stage (a Sune breaks a pair mid-way) never moves a boundary. A pair
// ends the LAST time its slot became solved before F2L was done, so a pair
// broken and remade counts at its remaking; pairs are listed in the order they
// were made. PLL ends when the cube is solved but for a U turn; the rest is AUF.
//
// Frame: the record's turns are WCA letters; they are read in the trainer's
// frame (cube/frame.ts fromWca: white down, the chosen colour in front), as the
// stage predicates and the case tables are.

import { faceMoves, mergeMoves, type Move as AlgMove } from '../cube/alg';
import { fromWca } from '../cube/frame';
import { SOLVED, state } from '../cube/state';
import { caseId, findCase, listFor, SLOTS, slotSolved, slotState, twinOf, type SlotName } from '../f2l/model';
import { identifyFacelets } from '../ll/model';
import { applyMove, type Move } from '../moves/moves';
import { stageOf } from '../stage';
import type { SolveRecord } from '../store/types';

type PhaseId = 'eocross' | 'pair' | 'ocll' | 'pll' | 'auf';

export interface Phase {
  id: PhaseId;
  /** 1..4 for a pair, in the order made */
  n?: number;
  /** ms from the first turn */
  start: number;
  end: number;
  time: number;
  /** the phase's turns merged into face turns (R R -> R2), trainer letters */
  turns: string[];
  /** HTM of `turns` */
  moves: number;
  /** ms from the phase starting to its first turn (last layer: its first turn that is not U, the AUF being part of looking) */
  look: number;
  /** ms of the phase spent between turns beyond PAUSE_MS each: time not turning */
  idle: number;
  /** a turn and its undo straight after, inside the phase */
  misturns: number;
  /** the pair's slot */
  slot?: SlotName;
  /** the case the step started from: F2L `${slot}-${n}` (caseId), OCLL / PLL the table's id; absent when unread */
  caseId?: string;
  /** F2L: the front-right twin's number (the sheet's number on every slot) */
  twin?: number;
  /** the shortest alg for the case from where it was, as the tables have it (F2L: with the slots that were open) */
  par?: number;
  /** that alg, as done from the position (F2L, AUF included) */
  parAlg?: string;
  /** nothing to do: an OCLL or PLL skip, a pair made during EOCross */
  skipped?: boolean;
  /** made on the same turn as the pair before it (a multislot): its time is counted with that pair */
  together?: boolean;
  /** OCLL / PLL: the algs it took (2 for a two-look), and the cases passed through between them */
  algs?: number;
  via?: string[];
}

export interface SolveAnalysis {
  phases: Phase[];
  /** ms, first turn to the last */
  total: number;
  /** ms from the scramble on the cube to the first turn, when recorded */
  inspection?: number;
  /** face turns as recorded (quarter turns from a smart cube) */
  turns: number;
  /** HTM over the solve, same-face runs merged */
  moves: number;
  /** ms spent between turns beyond PAUSE_MS each, the whole solve */
  idle: number;
}

// DECISION: 300 ms between turns is a regrip; beyond it is looking (the design doc's pause threshold).
export const PAUSE_MS = 300;

const RANK = { eo: 0, f2l: 1, ocll: 2, pll: 3, solved: 4 } as const;

/** The WCA turn as quarter/half face turns in the trainer's letters (a smart cube only ever sends face turns). */
function trainerMoves(m: string): Move[] {
  const fm = faceMoves(fromWca(m));
  if (!fm) throw new Error(`not a face turn: ${m}`);
  return fm.map((x) => (x.face + ({ 1: '', 2: '2', 3: "'" } as const)[x.times]) as Move);
}

const solvedButAuf = (f: string): boolean => {
  let g = f;
  for (let k = 0; k < 4; k++) { if (g === SOLVED) return true; g = applyMove(g, 'U'); }
  return false;
};

/** Analyse a solve; null when it has no turns, or its turns do not solve its scramble. */
export function analyseSolve(rec: Pick<SolveRecord, 'scramble' | 'moves' | 'time' | 'inspection'>): SolveAnalysis | null {
  const recMoves = rec.moves;
  if (!recMoves?.length) return null;
  let f: string;
  try { f = state(fromWca(rec.scramble)); } catch { return null; }
  // every state, with the time it was reached: states[0] is the scramble (t 0), states[i] after turn i
  const states: string[] = [f];
  const times: number[] = [0];
  const toks: Move[][] = [[]];
  try {
    for (const mv of recMoves) {
      const ms = trainerMoves(mv.m);
      for (const m of ms) f = applyMove(f, m);
      states.push(f); times.push(mv.t); toks.push(ms);
    }
  } catch { return null; }
  if (!solvedButAuf(f)) return null;
  const N = states.length - 1;
  const rank = states.map((s) => RANK[stageOf(s).stage]);
  const firstAt = (from: number, ok: (i: number) => boolean): number => { for (let i = from; i <= N; i++) if (ok(i)) return i; return N; };

  const E = firstAt(0, (i) => rank[i]! >= 1);
  const F = firstAt(E, (i) => rank[i]! >= 2);
  const O = firstAt(F, (i) => rank[i]! >= 3);
  const P = firstAt(O, (i) => solvedButAuf(states[i]!));

  const phases: Phase[] = [];
  const mk = (id: PhaseId, a: number, b: number, lookSkipsU = false): Phase => {
    const flat: AlgMove[] = [];
    let misturns = 0, idle = 0, look = 0, prev: Move | null = null, sawTurn = false;
    for (let i = a + 1; i <= b; i++) {
      for (const m of toks[i]!) flat.push({ face: m[0]!, times: (m.endsWith("'") ? 3 : m.endsWith('2') ? 2 : 1) as 1 | 2 | 3 });
      const m = toks[i]![0];
      // R then R' (or R' then R); the undo is not the start of another
      const undone: boolean = !!prev && !!m && m[0] !== 'U' && prev[0] === m[0] && prev.length + m.length === 3 && !prev.endsWith('2');
      if (undone) misturns++;
      prev = undone ? null : toks[i]![toks[i]!.length - 1] ?? null;
      const gap = times[i]! - times[i - 1]!;
      idle += Math.max(0, gap - PAUSE_MS);
      if (!sawTurn && (!lookSkipsU || !toks[i]!.every((x) => x[0] === 'U'))) { sawTurn = true; look = times[i]! - times[a]!; }
    }
    // the first turn of the solve starts the clock: no look before it
    if (a === 0) look = 0;
    const merged = mergeMoves(flat);
    const turns = merged.map((x) => x.face + ({ 1: '', 2: '2', 3: "'" } as const)[x.times]);
    return { id, start: times[a]!, end: times[b]!, time: times[b]! - times[a]!, turns, moves: turns.length, look, idle, misturns };
  };

  phases.push(mk('eocross', 0, E));

  // the pairs, in the order they were first solved. DECISION: the FIRST time, not the last (the design doc's
  // "a pair broken and remade counts at its remaking"): in ZZ the next pair's R or L turns lift a solved
  // neighbour out of its slot and put it back as a matter of course (all 33 recorded solves do it), and dating
  // pairs by their last remaking gave two pairs on one turn in every one of them.
  const made: { slot: SlotName; at: number }[] = [];
  for (const slot of SLOTS) {
    if (!slotSolved(states[F]!, slot)) continue;
    made.push({ slot, at: firstAt(E, (i) => slotSolved(states[i]!, slot)) });
  }
  made.sort((a, b) => a.at - b.at);
  let from = E, stepFrom = E, n = 0;
  for (const { slot, at } of made) {
    n++;
    if (at === E) { phases.push({ ...mk('pair', E, E), n, slot, skipped: true }); continue; }
    // made on the turn that made the pair before: one step for both, the case read where that step began
    const together = at === from && from > E;
    if (!together) stepFrom = from;
    const p: Phase = { ...mk('pair', from, at), n, slot, ...(together ? { together: true } : {}) };
    const f0 = states[stepFrom]!;
    const ss = slotState(f0, slot);
    const hit = findCase(slot, ss.corner, ss.edge);
    if (hit && !slotSolved(f0, slot)) {
      p.caseId = caseId(slot, hit.c.n);
      p.twin = twinOf(slot, hit.c.n);
      const solved = new Set(SLOTS.filter((s) => s !== slot && slotSolved(f0, s)));
      const usable = listFor(slot, hit.c, hit.hit.auf, solved).rows.filter((r) => r.usable);
      const best = usable.reduce<(typeof usable)[number] | null>((b, r) => (!b || r.n < b.n ? r : b), null);
      if (best) { p.par = best.n; p.parAlg = best.full; }
    }
    phases.push(p);
    from = at;
  }

  const ocll = mk('ocll', F, O, true);
  if (O === F) ocll.skipped = true;
  else {
    const c = identifyFacelets('ocll', states[F]!);
    if (c) { ocll.caseId = c.id; ocll.par = countOf(c.alg); ocll.parAlg = c.alg; }
  }
  phases.push(ocll);
  const pll = mk('pll', O, P, true);
  if (P === O) pll.skipped = true;
  else {
    const c = identifyFacelets('pll', states[O]!);
    if (c) { pll.caseId = c.id; pll.par = countOf(c.alg); pll.parAlg = c.alg; }
  }
  phases.push(pll);
  // the looks: a last-layer step done as more than one alg passes through the stage's own states (F2L whole, and for
  // PLL the corners oriented) between them; a stretch of U turns alone is an AUF, not an alg
  const looks = (p: Phase, a: number, b: number, kind: 'ocll' | 'pll') => {
    if (p.skipped) return;
    const at = kind === 'ocll' ? 2 : 3;
    let algs = 0, turned = false;
    const via: string[] = [];
    for (let i = a + 1; i <= b; i++) {
      if (toks[i]!.some((m) => m[0] !== 'U')) turned = true;
      if (turned && rank[i]! >= at) {
        algs++; turned = false;
        if (i < b) { const c = identifyFacelets(kind, states[i]!); if (c) via.push(c.id); }
      }
    }
    p.algs = Math.max(1, algs);
    if (via.length) p.via = via;
  };
  looks(ocll, F, O, 'ocll');
  looks(pll, O, P, 'pll');
  phases.push(mk('auf', P, N));

  const all = mk('eocross', 0, N);
  return { phases, total: times[N]!, inspection: rec.inspection, turns: N, moves: phases.reduce((s, p) => s + p.moves, 0), idle: all.idle };
}

/** HTM of a table alg (rotations free). */
function countOf(alg: string): number {
  return alg.replace(/[()[\]]/g, ' ').trim().split(/\s+/).filter((t) => t && !/^[xyz]/.test(t)).length;
}

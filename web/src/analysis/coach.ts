// The coach (MILESTONES M11, docs/smart-cube-trainer-survey.md 3.7): from the
// analysed solves, where the time goes, which cases cost the most, and what to
// work on next, each piece of advice with its reasons and the seconds a solve
// it is worth. Pure, over analyseSolve's output; the UI is coachui.ts.
//
// Every yardstick is the solver's own: a phase's target is the time it takes
// on the solver's better solves (the 25th percentile), a case's is the quick
// look the solver manages on the easy ones plus the shortest alg at the
// solver's own turning speed. Nothing is measured against somebody else's
// splits.

import { algTools, caseOf, TOOL_WORD, SLOT_WORD, type AlgTool } from '../f2l/model';
import { CASES } from '../ll/cases';
import { caseOdds } from '../ll/model';
import type { Phase, SolveAnalysis } from './solve';

export type CaseKind = 'f2l' | 'ocll' | 'pll';
export const KIND_WORD: Record<CaseKind, string> = { f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };

// ---- small statistics ----
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
export const median = (xs: readonly number[]): number => quantile(xs, 0.5);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
/** Seconds, one decimal. */
export const s1 = (ms: number): string => (ms / 1000).toFixed(1);

// ---- where the time goes ----
export type PhaseKey = 'eocross' | 'f2l' | 'ocll' | 'pll' | 'auf';
export const PHASE_WORD: Record<PhaseKey, string> = { eocross: 'EOCross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL', auf: 'AUF' };
const PHASE_IDS: Record<PhaseKey, Phase['id']> = { eocross: 'eocross', f2l: 'pair', ocll: 'ocll', pll: 'pll', auf: 'auf' };

/** A phase of one solve, the pairs summed into F2L. */
interface PhaseSums { time: number; moves: number; look: number; idle: number; misturns: number }
function phaseSums(a: SolveAnalysis, k: PhaseKey): PhaseSums {
  const ps = a.phases.filter((p) => p.id === PHASE_IDS[k]);
  return { time: sum(ps.map((p) => p.time)), moves: sum(ps.map((p) => p.moves)), look: sum(ps.map((p) => p.look)), idle: sum(ps.map((p) => p.idle)), misturns: sum(ps.map((p) => p.misturns)) };
}

export interface PhaseRow {
  key: PhaseKey;
  /** medians over the solves, ms / moves */
  time: number; moves: number; look: number; idle: number;
  /** the phase's time on the better solves: the 25th percentile */
  good: number;
  /** the median's share of the median solve */
  share: number;
  /** turns a second while turning (moves / (time - idle)) */
  tps: number;
}

/** The solves from a full scramble: one that left EOCross (or more) solved is not a solve to measure the phases by. */
export const fullSolves = (list: readonly SolveAnalysis[]): SolveAnalysis[] => list.filter((a) => a.from === 'eo');

/** Each phase's medians; `list` should be full solves (fullSolves). */
export function phaseTable(list: readonly SolveAnalysis[]): PhaseRow[] {
  const total = median(list.map((a) => a.total));
  return (Object.keys(PHASE_WORD) as PhaseKey[]).map((key) => {
    const xs = list.map((a) => phaseSums(a, key));
    const time = median(xs.map((x) => x.time)), moves = median(xs.map((x) => x.moves)), idle = median(xs.map((x) => x.idle));
    const busy = sum(xs.map((x) => x.time - x.idle));
    return { key, time, moves, look: median(xs.map((x) => x.look)), idle, good: quantile(xs.map((x) => x.time), 0.25), share: total ? time / total : 0, tps: busy > 0 ? sum(xs.map((x) => x.moves)) / (busy / 1000) : 0 };
  });
}

// ---- the cases ----
/** One case met in solves: F2L cases are counted as their front-right twin (the sheet's number on every slot). */
export interface CaseRow {
  kind: CaseKind;
  /** F2L: the twin's number as a string; OCLL / PLL: the table's id */
  id: string;
  name: string;
  n: number;
  /** how often it comes up, per solve (F2L: as seen; OCLL / PLL: the odds) */
  perSolve: number;
  /** medians, ms */
  time: number; look: number; exec: number;
  moves: number;
  /** OCLL / PLL: the share of times it took more than one alg, and the case most often passed through */
  multi: number;
  via: string | null;
  /** the shortest alg's HTM, as the tables have it, and the alg (the most common slot's, from where the pair was) */
  par: number | null;
  alg: string | null;
  /** F2L: the slot it came up on most, and every case id it was met as (for the practice pool) */
  slot?: string;
  ids: string[];
  /** F2L: the kinds of move the alg needs beyond one side and U */
  tools: AlgTool[];
  /** ms a time it would save to reach the target, split into its parts */
  gain: { look: number; moves: number; speed: number; total: number };
  /** ms a solve: gain.total x perSolve, shrunk while n is small */
  perSolveGain: number;
  /** focus order: perSolveGain, weighted by how easy the fix is */
  score: number;
}

/** The yardsticks for a kind, from every step of that kind in the solves. */
interface Refs { look: number; tps: number }
function refsOf(steps: readonly Phase[]): Refs {
  // DECISION: the quick look is the 25th percentile of the looks; the speed is the median turning speed of the steps
  const look = steps.length ? quantile(steps.map((p) => p.look), 0.25) : 0;
  const tpsList = steps.filter((p) => p.moves > 0 && p.time - p.look > 0).map((p) => p.moves / ((p.time - p.look) / 1000));
  return { look, tps: tpsList.length ? median(tpsList) : 3 };
}

const stepsOf = (list: readonly SolveAnalysis[], kind: CaseKind): Phase[] =>
  list.flatMap((a) => a.phases.filter((p) => p.id === (kind === 'f2l' ? 'pair' : kind) && !p.skipped && !p.together && p.caseId));

const caseName = (kind: CaseKind, id: string): string =>
  kind === 'f2l' ? `F2L ${id}` : `${KIND_WORD[kind]} ${CASES[kind].find((c) => c.id === id)?.name ?? id}`;

/** An alg is easy to pick up when it is short and only one side and U (or R and L). */
function ease(par: number | null, tools: readonly AlgTool[]): { w: number; word: string } {
  if (par === null) return { w: 0.5, word: '' };
  const hard = tools.some((t) => t === 'FB' || t === 'wide' || t === 'D');
  if (!hard && par <= 8) return { w: 1, word: 'easy' };
  if (!hard && par <= 11) return { w: 0.8, word: 'medium' };
  return { w: 0.55, word: 'harder' };
}

export function caseTable(list: readonly SolveAnalysis[], kind: CaseKind): CaseRow[] {
  const steps = stepsOf(list, kind);
  const refs = refsOf(steps);
  const odds = kind === 'f2l' ? null : caseOdds(kind);
  const groups = new Map<string, Phase[]>();
  for (const p of steps) {
    const id = kind === 'f2l' ? String(p.twin) : p.caseId!;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(p);
  }
  const rows: CaseRow[] = [];
  for (const [id, ps] of groups) {
    const n = ps.length;
    const time = median(ps.map((p) => p.time)), look = median(ps.map((p) => p.look)), moves = median(ps.map((p) => p.moves));
    const exec = median(ps.map((p) => p.time - p.look));
    // the slot met most, and its alg from the position met most there
    const bySlot = new Map<string, Phase[]>();
    for (const p of ps) (bySlot.get(p.caseId!) ?? bySlot.set(p.caseId!, []).get(p.caseId!)!).push(p);
    const main = [...bySlot.values()].sort((a, b) => b.length - a.length)[0]!;
    const withPar = main.filter((p) => p.par !== undefined);
    const par = withPar.length ? median(withPar.map((p) => p.par!)) : null;
    const alg = withPar.length ? mostCommon(withPar.map((p) => p.parAlg!)) : null;
    const tools = kind === 'f2l' && alg ? algTools(alg) : [];
    // the gain: the look beyond the quick look, the moves beyond the alg at the usual speed, the rest is speed
    const gLook = Math.max(0, look - refs.look);
    const gMoves = par === null ? 0 : Math.max(0, moves - par) / refs.tps * 1000;
    const target = refs.look + (par ?? moves) / refs.tps * 1000;
    const total = Math.max(0, time - target);
    const gSpeed = Math.max(0, total - gLook - gMoves);
    const perSolve = odds ? odds.get(id) ?? 0 : n / Math.max(1, list.length);
    // DECISION: a case seen n times counts n/(n+2) of its gain, so one bad solve does not top the list
    const perSolveGain = total * perSolve * (n / (n + 2));
    const e = ease(par, tools);
    const multi = ps.filter((p) => (p.algs ?? 1) > 1).length / n;
    const vias = ps.flatMap((p) => p.via ?? []);
    rows.push({
      kind, id, name: caseName(kind, id), n, perSolve, time, look, exec, moves, par, alg,
      multi, via: vias.length ? mostCommon(vias) : null,
      slot: kind === 'f2l' ? caseOf(main[0]!.caseId!)?.slot : undefined,
      ids: [...bySlot.keys()], tools,
      gain: { look: gLook, moves: gMoves, speed: gSpeed, total }, perSolveGain,
      score: perSolveGain * (gMoves > gLook && gMoves > gSpeed ? e.w : 1),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

function mostCommon<T>(xs: readonly T[]): T {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0]![0];
}

/** What a case's row says to do about it, in a sentence or two. */
export function caseAdvice(r: CaseRow): { what: string; why: string } {
  const g = r.gain;
  const where = r.kind === 'f2l' && r.slot ? ` (${SLOT_WORD[r.slot as keyof typeof SLOT_WORD]}${r.ids.length > 1 ? ' mostly' : ''})` : '';
  const seen = `seen ${r.n}×${r.kind === 'f2l' ? '' : `, comes up ${pct(r.perSolve)} of solves`}`;
  // "learn" wants a real gap in moves: one or two over the alg is an AUF, a regrip, not a different way of doing it
  const moreMoves = r.par !== null && r.moves - r.par >= 3;
  if (r.multi >= 0.5 && r.par !== null && r.alg && g.moves > 0) {
    const via = r.via ? ` through ${CASES[r.kind as 'ocll' | 'pll'].find((c) => c.id === r.via)?.name ?? r.via}` : '';
    return {
      what: `Learn ${r.name} in one look: ${r.alg}`,
      why: `You solve it with two algs${via} (${r.multi < 1 ? `${pct(r.multi)} of the time, ` : ''}${fmtN(r.moves)} moves); the one-look alg is ${r.par}. That is ${s1(g.moves)} s each time, and it comes up ${pct(r.perSolve)} of solves (seen ${r.n}×).`,
    };
  }
  if (moreMoves && g.moves >= g.look && g.moves >= g.speed && r.alg) {
    const e = ease(r.par, r.tools);
    return {
      what: `Learn ${r.alg} for ${r.name}${where}`,
      why: `You average ${fmtN(r.moves)} moves on it; this alg is ${r.par}${e.word ? `, ${e.word}` : ''}${r.tools.length ? ` (${r.tools.map((t) => TOOL_WORD[t]).join(', ')})` : ''}. At your turning speed that is ${s1(g.moves)} s each time (${seen}).`,
    };
  }
  if (g.look >= g.speed) {
    return {
      what: `Recognise ${r.name}${where} sooner`,
      why: `You wait ${s1(r.look)} s before its first turn; your quick look on other ${KIND_WORD[r.kind]} cases is ${s1(r.look - g.look)} s (${seen}).`,
    };
  }
  return {
    what: `Drill ${r.name}${where} until it flows`,
    why: `${fmtN(r.moves)} moves in ${s1(r.exec)} s of turning, slower than your usual pace${r.par !== null ? ` (the alg is ${r.par})` : ''} (${seen}).`,
  };
}
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fmtN = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// ---- what to work on next ----
export interface Advice {
  title: string;
  why: string[];
  /** ms a solve it is worth, roughly */
  gain: number;
  /** F2L case ids to practise, when the advice is about F2L cases */
  f2lIds?: string[];
  kind?: CaseKind;
}

// DECISION: advice needs a handful of solves to say anything; below this the coach only shows the solve itself
export const MIN_SOLVES = 5;

export function advise(all: readonly SolveAnalysis[]): Advice[] {
  // the phases from full solves only; the cases from every solve (a pair or a last layer done is one, whatever the scramble gave)
  const list = fullSolves(all);
  if (list.length < MIN_SOLVES) return [];
  const out: Advice[] = [];
  const rows = phaseTable(list);
  const row = (k: PhaseKey) => rows.find((r) => r.key === k)!;

  // F2L lookahead: the time between turns in F2L, against the better solves'
  const f2l = row('f2l');
  const f2lIdle = list.map((a) => phaseSums(a, 'f2l').idle);
  const idleGain = median(f2lIdle) - quantile(f2lIdle, 0.25);
  if (f2l.idle > 0) {
    out.push({
      title: 'Look ahead in F2L',
      why: [
        `F2L takes ${s1(f2l.time)} s, ${pct(f2l.share)} of your solve, and ${s1(f2l.idle)} s of it is spent not turning (${pct(f2l.idle / Math.max(1, f2l.time))}).`,
        `On your better quarter of solves that dead time is ${s1(quantile(f2lIdle, 0.25))} s.`,
        `Turn slower and without stopping: find the next pair while this one goes in.`,
      ],
      gain: idleGain,
    });
  }

  // EOCross: planning it in inspection
  const eo = row('eocross');
  const eoIdle = list.map((a) => phaseSums(a, 'eocross').idle);
  const eoTimes = list.map((a) => phaseSums(a, 'eocross').time);
  const insp = list.map((a) => a.inspection).filter((x): x is number => typeof x === 'number');
  out.push({
    title: 'Plan the whole EOCross in inspection',
    why: [
      `EOCross takes ${s1(eo.time)} s (${pct(eo.share)} of your solve) for ${fmtN(eo.moves)} moves, and you stop for ${s1(eo.idle)} s of it${insp.length ? ` after ${s1(median(insp))} s of inspection` : ''}.`,
      `Pauses inside it mean the plan ran out. On your better quarter it takes ${s1(quantile(eoTimes, 0.25))} s with ${s1(quantile(eoIdle, 0.25))} s stopped.`,
      `Practice the EOCross mode: plan it all, then do it without looking up.`,
    ],
    gain: eo.time - eo.good,
  });

  // the cases: the best one of each kind to fix
  for (const kind of ['f2l', 'ocll', 'pll'] as CaseKind[]) {
    let cs = caseTable(all, kind).filter((r) => r.n >= (kind === 'f2l' ? 2 : 1));
    // a last layer still done in two looks for several cases: one piece of advice for the set, not one per case
    const twoLook = kind === 'f2l' ? [] : cs.filter((r) => r.multi >= 0.5 && r.par !== null && r.moves - r.par >= 3);
    if (twoLook.length >= 3) {
      const all = CASES[kind as 'ocll' | 'pll'].length;
      const worth = twoLook.slice(0, 4);
      out.push({
        title: `Learn one-look ${KIND_WORD[kind]}: ${worth.map((r) => r.name.replace(`${KIND_WORD[kind]} `, '')).join(', ')} first`,
        why: [
          `${twoLook.length} ${KIND_WORD[kind]} cases (of ${all}) took you two algs (${fmtN(median(twoLook.map((r) => r.moves)))} moves where the one-look alg is ${fmtN(median(twoLook.map((r) => r.par!)))}).`,
          ...worth.map((r) => `${r.name}: ${r.alg} (${r.par} moves; ${s1(r.gain.moves)} s each time, comes up ${pct(r.perSolve)} of solves).`),
          `These are the ones worth the most: how often they come up times the time the second look costs you.`,
        ],
        gain: sum(twoLook.map((r) => r.perSolveGain)),
        kind,
      });
      cs = cs.filter((r) => !twoLook.includes(r));
    }
    const top = cs.slice(0, kind === 'f2l' ? 3 : 2).filter((r) => r.perSolveGain > 50);
    if (!top.length) continue;
    const first = caseAdvice(top[0]!);
    out.push({
      title: first.what,
      why: [first.why, ...top.slice(1).map((r) => { const a = caseAdvice(r); return `Then: ${a.what.charAt(0).toLowerCase()}${a.what.slice(1)}. ${a.why}`; })],
      gain: sum(top.map((r) => r.perSolveGain)),
      kind,
      ...(kind === 'f2l' ? { f2lIds: top.flatMap((r) => r.ids) } : {}),
    });
  }

  // the last layer's recognition: the pause before OCLL and PLL
  const ll = list.map((a) => phaseSums(a, 'ocll').look + phaseSums(a, 'pll').look);
  const llLook = median(ll);
  // DECISION: under 1.2 s a solve of looking before the two last-layer algs is not worth a line
  if (llLook > 1200) {
    out.push({
      title: 'Recognise the last layer faster',
      why: [
        `You spend ${s1(llLook)} s a solve looking before your OCLL and PLL algs start (AUF included).`,
        `The Last layer mode drills recognition: its quiz asks for the case before the alg, and "start from" the last pair makes you recognise after your own F2L, as in a solve.`,
      ],
      gain: llLook - quantile(ll, 0.25),
      kind: 'pll',
    });
  }

  // misturns: a turn undone at once
  const mis = median(list.map((a) => sum(a.phases.map((p) => p.misturns))));
  if (mis >= 2) {
    out.push({
      title: 'Fewer wrong turns',
      why: [`About ${fmtN(mis)} turns a solve are undone straight after. Each costs two turns and the regrip.`, 'Slow down a little where they happen; the solve report marks the phase.'],
      gain: mis * 2 * 1000 / Math.max(1, f2l.tps),
    });
  }

  for (const a of out) a.gain = Math.max(0, a.gain);
  return out.sort((a, b) => b.gain - a.gain);
}

// ---- one solve against the rest ----
interface ReportRow {
  label: string;
  /** the case, when there was one */
  kase?: string;
  time: number;
  /** ms against the solver's median for the same thing (the case, or the phase): positive is slower */
  vs: number | null;
  moves: number;
  par: number | null;
  look: number;
  misturns: number;
  skipped?: boolean;
  together?: boolean;
}

export interface Report { rows: ReportRow[]; total: number; vsTotal: number | null; note: string | null; given: string | null }

function caseLabel(p: Phase): string | undefined {
  if (p.skipped) return p.id === 'pair' ? 'solved already' : p.id === 'eocross' ? 'the scramble had it' : 'skip';
  if (p.id === 'eocross' && p.eo) return `EO ${s1(p.eo.time)} s (${p.eo.moves}) · cross ${s1(p.time - p.eo.time)} s (${p.moves - p.eo.moves})`;
  if (!p.caseId) return undefined;
  if (p.id === 'pair') return `F2L ${p.twin}`;
  const k = p.id as 'ocll' | 'pll';
  return CASES[k].find((c) => c.id === p.caseId)?.name ?? p.caseId;
}

/** One solve, each phase against the solver's medians over `list` (the solve itself left out by the caller or not). */
export function solveReport(a: SolveAnalysis, all: readonly SolveAnalysis[]): Report {
  const list = fullSolves(all);
  const enough = list.length >= 3;
  const byCase = (p: Phase): number | null => {
    if (!enough || !p.caseId || p.skipped) return null;
    const same = list.flatMap((b) => b.phases.filter((q) => q.id === p.id && !q.together && (p.id === 'pair' ? q.twin === p.twin : q.caseId === p.caseId)));
    return same.length >= 2 ? median(same.map((q) => q.time)) : null;
  };
  const byPhase = (id: Phase['id'], n?: number): number | null => {
    if (!enough) return null;
    const xs = list.map((b) => b.phases.find((q) => q.id === id && (n === undefined || q.n === n))?.time).filter((x): x is number => x !== undefined);
    return xs.length ? median(xs) : null;
  };
  const rows: ReportRow[] = a.phases.map((p) => {
    const ref = byCase(p) ?? byPhase(p.id, p.n);
    const label = p.id === 'pair' ? `Pair ${p.n}${p.slot ? ` · ${SLOT_WORD[p.slot]}` : ''}` : PHASE_WORD[p.id === 'eocross' ? 'eocross' : (p.id as PhaseKey)];
    return { label, kase: caseLabel(p), time: p.time, vs: ref === null || p.together || p.skipped ? null : p.time - ref, moves: p.moves, par: p.par ?? null, look: p.look, misturns: p.misturns, skipped: p.skipped, together: p.together };
  });
  // a solve from a scramble that gave part of it away is not compared with full solves
  const tot = enough && a.from === 'eo' ? median(list.map((b) => b.total)) : null;
  // the note: the phase that lost the most against its median, and why
  let note: string | null = null;
  const worst = rows.map((r, i) => ({ r, p: a.phases[i]! })).filter((x) => x.r.vs !== null && x.r.vs > 800).sort((x, y) => y.r.vs! - x.r.vs!)[0];
  if (worst) {
    const { r, p } = worst;
    const bits: string[] = [];
    if (r.par !== null && r.moves - r.par >= 3) bits.push(`${r.moves} moves where the alg is ${r.par}`);
    if (r.misturns) bits.push(`${r.misturns} wrong turn${r.misturns > 1 ? 's' : ''} undone`);
    const lookRef = median(list.flatMap((b) => b.phases.filter((q) => q.id === p.id).map((q) => q.look)));
    if (p.look - lookRef > 700) bits.push(`${s1(p.look)} s before the first turn`);
    if (p.idle > 0.5 * p.time && !bits.length) bits.push(`${s1(p.idle)} s of it not turning`);
    note = `${r.label}${r.kase ? ` (${r.kase})` : ''} cost the most: ${s1(r.time)} s, ${s1(r.vs!)} s over your usual${bits.length ? `, with ${bits.join(' and ')}` : ''}.`;
  }
  const given = a.from === 'eo' ? null
    : `The scramble started at ${PHASE_WORD[a.from as PhaseKey]}: EOCross${a.from !== 'f2l' ? ' and F2L' : ''} ${a.from === 'f2l' ? 'was' : 'were'} already solved${a.from === 'f2l' ? (() => { const n = a.phases.filter((p) => p.id === 'pair' && p.skipped).length; return n ? `, with ${n} pair${n > 1 ? 's' : ''}` : ''; })() : ''}. Not a full solve: it is left out of your phase numbers, and its time is not your usual.`;
  return { rows, total: a.total, vsTotal: tot === null ? null : a.total - tot, note, given };
}

// What an EO case looks like and what its optimal solutions do: the EO
// trainer's strategy note. The general rules and the percentages quoted in
// them were measured over every optimal solution of every EO state
// (docs/eo-patterns.md, tools/eocross/eo-patterns.ts); the per-scramble
// checks are computed live off the 2^12 distance table, so a rule that
// fails on this scramble is called out as such.

import { isEoFlip, moveStr, type Move } from '../cube/alg';
import { EDGE_SLOTS, SLOT_INDEX, applyEdgeMove, badOnFace, edgeMoveOf, type EdgeState } from '../cube/pieces';
import { eoDistance, type SolutionSet } from './solver';

/** The four slots no F/B turn touches: a bad edge there always costs a side move. */
export const OFF_AXIS: readonly number[] = ['UR', 'UL', 'DR', 'DL'].map((n) => SLOT_INDEX[n]);
/** A front edge and the back edge straight behind it on the same side face: moving one onto a face kicks the other off. */
export const ACROSS: readonly [number, number][] = [['UF', 'UB'], ['DF', 'DB'], ['FR', 'BR'], ['FL', 'BL']].map(([a, b]) => [SLOT_INDEX[a], SLOT_INDEX[b]]);

export interface Plan { key: string; counts: number[]; n: number }
export interface FaceCheck { face: 'F' | 'B'; bad: number; extra: number }

export interface EoReading {
  bad: number;
  length: number;
  offAxis: number;
  acrossPairs: number;
  onFace: { F: number; B: number };
  /** F/B plans among the optimal solutions, commonest first */
  plans: Plan[];
  /** solutions whose first move is an F/B quarter turn */
  firstFB: number;
  total: number;
  /** every optimal solution has a half turn / an F2 or B2 */
  halfNeeded: boolean;
  fbHalfNeeded: boolean;
  /** the faces a human rule says to turn now (4 bad; 3 bad with 6+; 1 bad with 2 or 6), and what turning them first costs over optimal */
  checks: FaceCheck[];
}

const popcount = (v: number): number => { let n = 0; for (let x = v; x; x &= x - 1) n++; return n; };
const badAt = (st: EdgeState, slot: number): boolean => ((st.eo >> slot) & 1) === 1;

/** Bad edges on the face at each F/B quarter turn of a solution. */
export function planCounts(start: EdgeState, sol: readonly Move[]): number[] {
  const counts: number[] = [];
  let st = start;
  for (const m of sol) {
    if (isEoFlip(m)) counts.push(badOnFace(st, m.face));
    st = applyEdgeMove(st, edgeMoveOf(m));
  }
  return counts;
}

export function readEO(start: EdgeState, sol: SolutionSet): EoReading {
  const bad = popcount(start.eo);
  const onFace = { F: badOnFace(start, 'F'), B: badOnFace(start, 'B') };
  const plans = new Map<string, Plan>();
  let firstFB = 0, halfNeeded = true, fbHalfNeeded = true;
  for (const s of sol.solutions) {
    const counts = planCounts(start, s), key = counts.join('-');
    const p = plans.get(key) ?? { key, counts, n: 0 };
    p.n++; plans.set(key, p);
    if (s.length && isEoFlip(s[0])) firstFB++;
    if (!s.some((m) => m.times === 2)) halfNeeded = false;
    if (!s.some((m) => m.times === 2 && (m.face === 'F' || m.face === 'B'))) fbHalfNeeded = false;
  }
  if (!sol.solutions.length) { halfNeeded = false; fbHalfNeeded = false; }
  const checks: FaceCheck[] = [];
  for (const face of ['F', 'B'] as const) {
    const n = onFace[face];
    const rule = n === 4 || (n === 3 && bad >= 6) || (n === 1 && (bad === 2 || bad === 6));
    if (!rule) continue;
    const after = applyEdgeMove(start, edgeMoveOf({ face, times: 1 }));
    checks.push({ face, bad: n, extra: eoDistance(after.eo) + 1 - sol.length });
  }
  return {
    bad, length: sol.length,
    offAxis: OFF_AXIS.filter((s) => badAt(start, s)).length,
    acrossPairs: ACROSS.filter(([a, b]) => badAt(start, a) && badAt(start, b)).length,
    onFace,
    plans: [...plans.values()].sort((a, b) => b.n - a.n),
    firstFB, total: sol.solutions.length, halfNeeded, fbHalfNeeded, checks,
  };
}

// ---- words ----
const SIDE: Record<string, string> = { U: 'top', D: 'bottom', R: 'right', L: 'left', F: 'front', B: 'back' };
/** A slot in words: 'UR' -> top-right, 'FR' -> front-right. */
export const slotName = (slot: number): string => [...EDGE_SLOTS[slot]].map((c) => SIDE[c]).join('-');
const faceName = (f: 'F' | 'B'): string => SIDE[f];
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A plan in words: what to do with the bad edges at each F/B turn. */
export function planWords(counts: number[]): string {
  if (!counts.length) return 'no F/B turns';
  const steps = counts.map((c, i) => {
    const last = i === counts.length - 1;
    if (c === 4) return last ? 'gather the last four on one face and turn it' : 'gather four on a face and turn it';
    if (c === 3) return 'put three bad edges on a face and turn it (one of them stays bad, three good ones flip)';
    if (c === 1) return `turn a face with one bad edge (making ${counts.length > 1 ? 'four bad on it' : 'more'})`;
    if (c === 2) return 'turn a face with two bad edges (trading them for the other two)';
    return 'turn a face with no bad edges';
  });
  return steps.join(', then ');
}

export const EO_STRATEGY_SHORT = `<p style="margin:0 0 4px"><b>How EO goes</b> (from every optimal solution of every case, see docs/eo-patterns.md):</p><ul>
<li><b>It always ends by turning a face with all four edges bad.</b> Everything before is setting that up. Never turn a face with no bad edges; you never need to turn one with two.</li>
<li><b>Count the bad edges; the plan follows.</b> 4: gather them on one face. 6: three on a face, turn it, then the last four (usually on the other face). 8: four, then four. 2: one on a face, turn it (making four), then those four. 10: three, four, four – always 6 or 7 moves. 12: 7 moves.</li>
<li><b>Turn when the face is ready.</b> A face with 4 bad: turn it now (optimal 96% of the time). 6 bad with 3 on a face: turn it (96%). 6 bad with only 1 on a face: turning it to make 8 is optimal 70% of the time – more bad edges is not worse.</li>
<li><b>Setup moves are the skill.</b> A side turn adds at most one bad edge to a face; make each one add one to the face you turn next, and never take one off. U2 / D2 / R2 / L2 swap a front edge with the back edge behind it – one move where a quarter turn would need two.</li>
<li><b>Reading the cost:</b> bad edges in the four side-middle slots (top-right, top-left, bottom-right, bottom-left) each cost a move, since no F/B turn reaches them. A front edge and the back edge straight behind it both bad is the expensive shape (moving one in kicks the other out). With 8 bad it is the <i>good</i> edges you place: they want to sit in the side-middle slots.</li>
</ul>`;

/** What THIS scramble's optimal EO solutions do, as HTML bullets. */
export function eoCaseStrategy(start: EdgeState, sol: SolutionSet): string {
  const r = readEO(start, sol);
  const li: string[] = [];
  if (r.bad === 0) return '<p style="margin:0">EO is already solved.</p>';
  const faces = `${r.onFace.F} on the front, ${r.onFace.B} on the back`;
  li.push(`<b>${plural(r.bad, 'bad edge')}: ${faces}, ${r.offAxis} in the side-middle slots.</b> Optimal is ${plural(r.length, 'move')} (${plural(sol.count, 'solution')}).`);
  const cost: string[] = [];
  if (r.offAxis) cost.push(`${r.offAxis === 1 ? 'the side-middle one needs' : `the ${r.offAxis} side-middle ones each need`} a side move to reach a front/back face`);
  if (r.acrossPairs) cost.push(`${r.acrossPairs === 1 ? 'one pair sits' : `${r.acrossPairs} pairs sit`} straight across from each other (front and back on one side ring), the shape that costs most`);
  if (r.bad === 8 && r.offAxis < 4) cost.push(`with 8 bad it is the ${4 - r.offAxis} good edge${4 - r.offAxis === 1 ? '' : 's'} on the front/back faces you have to move out of the way`);
  if (cost.length) li.push(`${cost.join('; ')}.`);
  for (const c of r.checks) {
    const why = c.bad === 4 ? 'all four bad' : c.bad === 3 ? 'three bad' : 'one bad';
    if (c.extra <= 0) li.push(`The ${faceName(c.face)} face has ${why}: turning it now is optimal${c.bad === 1 ? ` (${r.bad === 2 ? 'four bad after it, then gather those' : 'eight bad after it, then four and four'})` : ''}.`);
    else li.push(`The ${faceName(c.face)} face has ${why}, but turning it first costs ${plural(c.extra, 'extra move')} here${c.bad === 3 ? ': the four left would be spread across the rings' : ''}. The optimal lines ${r.firstFB === 0 ? 'all start with a setup move' : 'do something else first'}.`);
  }
  const plans = r.plans.map((p) => `<b>${p.counts.join(' then ')}</b>${r.plans.length > 1 ? ` (${plural(p.n, 'line')})` : ''}`).join(', ');
  li.push(`Plan${r.plans.length > 1 ? 's' : ''} in the optimal solutions – bad edges on the face at each F/B turn: ${plans}. ${r.plans[0] ? capital(planWords(r.plans[0].counts)) + '.' : ''}`);
  const start_ = r.firstFB === r.total ? 'Every optimal line starts with an F/B turn' : r.firstFB === 0 ? 'Every optimal line starts with a setup move' : `${r.firstFB} of ${r.total} optimal lines start with an F/B turn, the rest with a setup move`;
  const half = r.fbHalfNeeded ? '; every one uses an F2 or B2 as a setup' : r.halfNeeded ? '; every one uses a half turn (a front edge swapped with the back edge behind it)' : '';
  li.push(`${start_}${half}.`);
  const ex = sol.solutions[0];
  if (ex) li.push(`For example: <span style="word-spacing:.3em">${ex.map((m) => (isEoFlip(m) ? `<b>${esc(moveStr(m))}</b>` : esc(moveStr(m)))).join(' ')}</span> – the F/B turns in bold, the rest is setup.`);
  return `<ul>${li.map((x) => `<li>${x}</li>`).join('')}</ul>`;
}

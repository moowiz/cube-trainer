// The F2L cases met in a coach export (the Solve tab's "export" JSON: sessions, solves, attempts), against the
// algs the app knows: for every pair of every smart-cube solve, the case (its front-right twin), what was done
// (moves, time, the technique the turns show), the shortest alg from where the pair was, and every alg the
// finder lists for the case with the head explain() gives it. Which cases cost the most moves beyond their alg,
// and what the choices for each are.
//
//   npx vite-node scripts/f2l-review.ts <export.json> [--json out.json] [--top 25] [--explain 0]
//
// The options are the front-right case's (the number the app shows on every slot; the other slots are its mirrors);
// --explain N also prints why each of the top N cases' options works.
import { readFileSync, writeFileSync } from 'node:fs';
import { median, quantile } from '../src/analysis/coach';
import { analyseSolve, type Phase } from '../src/analysis/solve';
import { tokens } from '../src/cube/alg';
import { caseGroup, caseOf, caseOfTwin, explain, fullAlg, GROUP_WORD, pairShape, positionAlgs, SLOT_WORD, type SlotName } from '../src/f2l/model';
import type { SolveRecord } from '../src/store/types';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: f2l-review.ts <export.json> [--json out.json] [--top N]'); process.exit(2); }
const argAt = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const TOP = Number(argAt('--top') ?? 25);
const EXPLAIN = Number(argAt('--explain') ?? 0);

const data = JSON.parse(readFileSync(file, 'utf8')) as { solves: SolveRecord[] };
const solves = data.solves.filter((s) => !s.deleted && s.moves?.length);

/** The turns without any leading U (the AUF differs by position; the alg is the rest). */
const stripAuf = (t: readonly string[]): string => { let i = 0; while (i < t.length && t[i]![0] === 'U') i++; return t.slice(i).join(' '); };

/** What the turns are built from: own side and U, a pop on the other side apart from the insert, both sides interleaved, D, F2/B2. */
function tech(slot: SlotName, t: readonly string[]): string {
  const side = slot[1]!, other = side === 'R' ? 'L' : 'R';
  const parts: string[] = [];
  const has = (re: RegExp) => t.some((x) => re.test(x));
  if (has(/^D/)) parts.push('D');
  if (has(/^[FB]2$/)) parts.push('F2/B2');
  if (has(/^[FB]'?$/)) parts.push('F/B quarter');
  const o = t.map((x, i) => (x[0] === other ? i : -1)).filter((i) => i >= 0);
  const own = t.map((x, i) => (x[0] === side ? i : -1)).filter((i) => i >= 0);
  if (o.length) parts.push(!own.length || o.at(-1)! < own[0]! || o[0]! > own.at(-1)! ? 'pop, then insert' : 'both sides interleaved');
  if (!parts.length) parts.push('own side + U');
  return parts.join(', ');
}

interface PairRow extends Phase { solveId: string; when: number; from: string; tech: string; stripped: string }
const pairs: PairRow[] = [];
let analysed = 0, failed = 0, noCase = 0, together = 0;
for (const s of solves) {
  const a = analyseSolve(s);
  if (!a) { failed++; continue; }
  analysed++;
  for (const p of a.phases) {
    if (p.id !== 'pair' || p.skipped) continue;
    if (p.together) { together++; continue; }
    if (!p.caseId) { noCase++; continue; }
    pairs.push({ ...p, solveId: s.id, when: s.when, from: a.from, tech: tech(p.slot!, p.turns), stripped: stripAuf(p.turns) });
  }
}

// the solver's own yardsticks (coach.ts): turning speed over the pairs, the quick look
const tpsList = pairs.filter((p) => p.moves > 0 && p.time - p.look > 0).map((p) => p.moves / ((p.time - p.look) / 1000));
const tps = median(tpsList);
const quickLook = quantile(pairs.map((p) => p.look), 0.25);
const msPerMove = 1000 / tps;

interface Option { alg: string; full: string; n: number; tools: string[]; needs: string[]; from: string; head: string; body: string; youDo: number }
interface CaseSummary {
  twin: number; group: string; picture: string; n: number; slots: Record<string, number>;
  time: number; look: number; exec: number; moves: number; par: number | null;
  /** moves beyond the alg, summed over the pairs, and the ms they cost at the solver's speed */
  extra: number; extraMs: number; lookMs: number;
  /** what was done: the turns (AUF off) by count, with the technique */
  did: { alg: string; n: number; tech: string; moves: number; head: string }[];
  options: Option[];
  parAlgs: { alg: string; n: number }[];
}
const byTwin = new Map<number, PairRow[]>();
for (const p of pairs) (byTwin.get(p.twin!) ?? byTwin.set(p.twin!, []).get(p.twin!)!).push(p);
const count = <T>(xs: readonly T[]): [T, number][] => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };

const cases: CaseSummary[] = [];
for (const [twin, ps] of byTwin) {
  const slots = Object.fromEntries(count(ps.map((p) => p.slot!)));
  const mainSlot = count(ps.map((p) => p.caseId!))[0]![0];
  const hit = caseOf(mainSlot)!;
  const withPar = ps.filter((p) => p.par !== undefined);
  const par = withPar.length ? median(withPar.map((p) => p.par!)) : null;
  const extra = withPar.reduce((s, p) => s + Math.max(0, p.moves - p.par!), 0);
  const did = count(ps.map((p) => p.stripped)).slice(0, 5).map(([alg, n]) => {
    const p = ps.find((q) => q.stripped === alg)!;
    const h = caseOf(p.caseId!)!;
    let head: string;
    try { head = alg ? explain(h.slot, h.c, alg).head : ''; } catch { head = '?'; }
    return { alg, n, tech: p.tech, moves: tokens(alg || 'U').length - (alg ? 0 : 1), head };
  });
  // the options on the front-right slot (the number the app shows); "you do" counts the mirrors on every slot
  const fr = caseOfTwin('FR', twin)!;
  const mirrorsOf = (alg: string): Set<string> => {
    const out = new Set<string>();
    for (const sl of ['FR', 'FL', 'BR', 'BL'] as SlotName[]) {
      const c = caseOfTwin(sl, twin); if (!c) continue;
      for (const o of positionAlgs(sl, c, '')) if (o.n === fullAlg('', alg).split(' ').length && o.from !== 'own') out.add(stripAuf(tokens(fullAlg('', o.alg))));
    }
    return out;
  };
  const options: Option[] = positionAlgs('FR', fr, '').slice(0, 10).map((o) => {
    const e = explain('FR', fr, o.alg);
    const same = mirrorsOf(o.alg);
    return { alg: o.alg, full: o.full, n: o.n, tools: o.tools, needs: o.needs, from: o.from, head: e.head, body: e.body,
      youDo: ps.filter((p) => p.caseId!.startsWith('FR') ? p.stripped === stripAuf(tokens(fullAlg('', o.alg))) : same.has(p.stripped)).length };
  });
  const white = fr.co === 'ud' ? (fr.corner.startsWith('U') ? 'white up' : 'white down') : fr.co === 'rl' ? `white on the ${fr.corner.includes('R') ? 'right' : 'left'}` : `white on the ${fr.corner.includes('F') ? 'front' : 'back'}`;
  const shape = pairShape('FR', fr);
  const picture = `corner ${fr.corner} (${white}), edge ${fr.edge}${shape ? `, ${shape}` : ''}`;
  cases.push({
    twin, group: GROUP_WORD[caseGroup(hit.slot, hit.c)], picture, n: ps.length, slots,
    time: median(ps.map((p) => p.time)), look: median(ps.map((p) => p.look)), exec: median(ps.map((p) => p.time - p.look)),
    moves: median(ps.map((p) => p.moves)), par, extra, extraMs: extra * msPerMove,
    lookMs: ps.reduce((s, p) => s + Math.max(0, p.look - quickLook), 0),
    did, options, parAlgs: count(withPar.map((p) => p.parAlg!)).slice(0, 3).map(([alg, n]) => ({ alg, n })),
  });
}
cases.sort((a, b) => b.extraMs - a.extraMs);

const s1 = (ms: number) => (ms / 1000).toFixed(1);
console.log(`${solves.length} solves with turns, ${analysed} analysed (${failed} did not solve their scramble), ${pairs.length} pairs with a case (${together} multislotted, ${noCase} unread)`);
console.log(`F2L turning speed ${tps.toFixed(2)} tps (${msPerMove.toFixed(0)} ms a move); quick look ${s1(quickLook)} s; median look ${s1(median(pairs.map((p) => p.look)))} s`);
const totExtra = cases.reduce((s, c) => s + c.extra, 0), totMoves = pairs.reduce((s, p) => s + p.moves, 0), totPar = pairs.reduce((s, p) => s + (p.par ?? p.moves), 0);
console.log(`moves over all pairs ${totMoves}, the shortest algs ${totPar}: ${totExtra} extra (${(100 * totExtra / totPar).toFixed(0)}%), ${s1(totExtra * msPerMove)} s over the sample, ${s1(totExtra * msPerMove / analysed)} s a solve`);
console.log(`technique over all pairs: ${count(pairs.map((p) => p.tech)).map(([t, n]) => `${t} ${n}`).join(' | ')}`);
console.log(`pairs by group: ${count(cases.flatMap((c) => Array<string>(c.n).fill(c.group))).map(([g, n]) => `${g} ${n}`).join(' | ')}`);
console.log();
for (const c of cases.slice(0, TOP)) {
  console.log(`== F2L ${c.twin}  [${c.group}]  seen ${c.n}x (${Object.entries(c.slots).map(([s, n]) => `${SLOT_WORD[s as SlotName]} ${n}`).join(', ')})`);
  console.log(`   median ${s1(c.time)} s (look ${s1(c.look)}, turning ${s1(c.exec)}), ${c.moves} moves, alg ${c.par ?? '?'}; extra moves ${c.extra} = ${s1(c.extraMs)} s over the sample, slow looks ${s1(c.lookMs)} s`);
  console.log(`   front-right picture: ${c.picture}; shortest from where it was: ${c.parAlgs.map((a) => `${a.alg} (${a.n}x)`).join(' | ')}`);
  for (const d of c.did) console.log(`   you did ${d.n}x (${d.moves}, ${d.tech}; ${d.head}): ${d.alg || '(nothing: AUF only)'}`);
  for (const o of c.options) console.log(`   ${o.youDo ? `*${o.youDo}`.padEnd(3) : '   '} ${String(o.n).padStart(2)} ${o.alg.padEnd(32)} ${o.head.padEnd(38)} ${[o.from, ...o.tools, ...(o.needs.length ? [`needs ${o.needs.join('+')} open`] : [])].join(', ')}`);
  if (cases.indexOf(c) < EXPLAIN) for (const o of c.options.slice(0, 5)) console.log(`      > ${o.alg}: ${o.body}`);
}
const out = argAt('--json');
if (out) writeFileSync(out, JSON.stringify({ tps, quickLook, analysed, pairs, cases }, null, 1));

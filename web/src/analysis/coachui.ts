// The coach on the page: the Coach place (what to work on next and why, where
// the time goes, the cases worth the most) and the report under a finished
// solve on the Solve tab. The numbers are coach.ts's; this only draws them.

import type { Store } from '../store/local';
import type { SolveRecord } from '../store/types';
import { ensureStyle, esc } from '../ui/dom';
import { persisted } from '../ui/settings';
import { analysedOne, analysedSolves, type Analysed } from './cache';
import { PAUSE_MS } from './solve';
import { advise, caseAdvice, caseTable, KIND_WORD, median, MIN_SOLVES, PHASE_WORD, phaseTable, quantile, s1, solveReport, type Advice, type CaseKind, type CaseRow } from './coach';

/** What an advice's button does: the app (app/modes.ts) knows how. */
export type CoachAction = { kind: 'f2l-cases'; ids: string[] } | { kind: 'mode'; mode: 'eo' | 'f2l' | 'll'; set?: 'ocll' | 'pll' };

const STYLE = `
  .co { max-width: 760px; margin: 0 auto; }
  .co h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2); margin: 22px 2px 8px; }
  .co .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); }
  .co-next { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .co-next .t { font-size: 19px; font-weight: 650; line-height: 1.35; }
  .co-next .g { color: var(--good); font-weight: 600; font-size: 14px; margin-top: 2px; }
  .co-next ul, .co-more ul { margin: 8px 0 4px; padding-left: 18px; line-height: 1.5; font-size: 14px; }
  .co-next .btn { margin-top: 6px; }
  .co-more { border-bottom: 1px solid var(--line); padding: 8px 2px; }
  .co-more summary { cursor: pointer; font-size: 15px; display: flex; gap: 8px; align-items: baseline; }
  .co-more summary .g { margin-left: auto; color: var(--good); font-size: 13px; white-space: nowrap; }
  .co table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  .co th { text-align: right; font-weight: 600; font-size: 12px; color: var(--ink-2); padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .co td { text-align: right; padding: 6px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .co th:first-child, .co td:first-child { text-align: left; }
  .co-cases { margin-top: 8px; border-top: 1px solid var(--line); }
  .co-case { padding: 9px 2px; border-bottom: 1px solid var(--line); }
  .co-case .h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  .co-case .h .m { color: var(--ink-2); font-size: 13px; font-variant-numeric: tabular-nums; }
  .co-case .h .g { margin-left: auto; color: var(--good); font-size: 13px; font-weight: 600; white-space: nowrap; }
  .co-case .d { font-size: 14px; margin-top: 3px; }
  .co-case .w { font-size: 13px; color: var(--ink-2); line-height: 1.45; margin-top: 1px; }
  @media (max-width: 600px) { .co .share { display: none; } }
  .co .share { display: inline-block; height: 8px; background: var(--ink-2); border-radius: 4px; vertical-align: middle; margin-right: 6px; opacity: .55; }
  .co .note { color: var(--ink-2); font-size: 14px; line-height: 1.5; }
  .co .scroll { overflow-x: auto; }
  /* the report under a solve (Solve tab) */
  .rp { max-width: 560px; margin: 6px auto 10px; font-size: 13px; }
  .rp table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .rp td { padding: 3px 5px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  .rp td:first-child, .rp td.k { text-align: left; }
  .rp td.k { color: var(--ink-2); white-space: normal; }
  .rp .up { color: #B3261E; } .rp .dn { color: var(--good); }
  .rp .nt { margin: 8px 2px 0; line-height: 1.45; }
  .rp .nx { margin: 6px 2px 0; line-height: 1.45; color: var(--ink-2); }
  .rp .nx b { color: var(--ink); font-weight: 600; }
  .rp .btn { padding: 2px 6px; font-size: 13px; }
`;

type Scope = '50' | '200' | 'all';
type Sort = 'focus' | 'slow' | 'seen';

/** Mount the Coach place in `root`; returns its redraw (call it when the place opens). */
export function mountCoach(root: HTMLElement, deps: { store: Promise<Store>; act(a: CoachAction): void }): () => Promise<void> {
  ensureStyle('coach-style', STYLE);
  const { settings: st, save } = persisted<{ scope: Scope; kind: CaseKind; sort: Sort }>('zz-coach', { scope: '50', kind: 'f2l', sort: 'focus' }, (s) => {
    if (!['50', '200', 'all'].includes(s.scope)) s.scope = '50';
    if (!['f2l', 'ocll', 'pll'].includes(s.kind)) s.kind = 'f2l';
    if (!['focus', 'slow', 'seen'].includes(s.sort)) s.sort = 'focus';
  });
  root.innerHTML = `<div class="co">
    <div class="bar"><span>Over</span><div class="eo-seg" data-k="scope"><button type="button" data-v="50">last 50</button><button type="button" data-v="200">last 200</button><button type="button" data-v="all">all</button></div><span class="co-n"></span></div>
    <div class="co-body"><p class="note">Reading your solves…</p></div></div>`;
  const body = root.querySelector<HTMLElement>('.co-body')!;
  let advices: Advice[] = [];

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const seg = t.closest<HTMLElement>('[data-k] [data-v]');
    if (seg) { (st as Record<string, string>)[seg.parentElement!.dataset.k!] = seg.dataset.v!; save(); void draw(); return; }
    const go = t.closest<HTMLElement>('[data-act]');
    if (go) { const a = actionOf(advices[Number(go.dataset.act)]!); if (a) deps.act(a); }
  });

  async function draw(): Promise<void> {
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((g) => g.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === (st as Record<string, string>)[g.dataset.k!])));
    const all = await analysedSolves(deps.store);
    const list = (st.scope === 'all' ? all : all.slice(-Number(st.scope))).map((x) => x.a);
    root.querySelector('.co-n')!.textContent = all.length ? `${list.length} solve${list.length === 1 ? '' : 's'} with turns recorded` : '';
    if (list.length < MIN_SOLVES) {
      body.innerHTML = `<p class="note">The coach reads the turns a smart cube records in timed solves. ${list.length ? `${list.length} so far; it needs ${MIN_SOLVES}.` : 'None yet.'} Do a few solves on the Solve tab with the cube connected.</p>`;
      return;
    }
    advices = advise(list);
    const [top, ...rest] = advices;
    let h = '<h3>Next to work on</h3>';
    if (top) {
      h += `<div class="co-next"><div class="t">${esc(top.title)}</div><div class="g">about ${s1(top.gain)} s a solve</div><ul>${top.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${actBtn(top, 0)}</div>`;
      if (rest.length) h += `<h3>Then</h3>${rest.map((a, i) => `<details class="co-more"><summary><span>${esc(a.title)}</span><span class="g">~${s1(a.gain)} s</span></summary><ul>${a.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${actBtn(a, i + 1)}</details>`).join('')}`;
    }
    // where the time goes
    const rows = phaseTable(list);
    const maxShare = Math.max(...rows.map((r) => r.share));
    h += `<h3>Where the time goes (medians)</h3><div class="scroll"><table><tr><th>phase</th><th>time</th><th>share</th><th>moves</th><th>tps</th><th title="time between turns beyond ${PAUSE_MS} ms each">stopped</th><th title="the 25th percentile: your better solves">good</th></tr>` +
      rows.map((r) => `<tr><td>${PHASE_WORD[r.key]}</td><td>${s1(r.time)}</td><td><span class="share" style="width:${Math.round(40 * r.share / maxShare)}px"></span>${Math.round(r.share * 100)}%</td><td>${fmt(r.moves)}</td><td>${r.tps.toFixed(1)}</td><td>${s1(r.idle)}</td><td>${s1(r.good)}</td></tr>`).join('') +
      `<tr><td><b>Solve</b></td><td><b>${s1(median(list.map((a) => a.total)))}</b></td><td></td><td>${fmt(median(list.map((a) => a.moves)))}</td><td></td><td>${s1(median(list.map((a) => a.idle)))}</td><td>${s1(quantile(list.map((a) => a.total), 0.25))}</td></tr></table></div>`;
    // the cases
    const cases = caseTable(list, st.kind);
    const sorted = st.sort === 'focus' ? cases : st.sort === 'slow' ? [...cases].sort((a, b) => b.time - a.time) : [...cases].sort((a, b) => b.n - a.n);
    h += `<h3>Cases</h3><div class="bar"><div class="eo-seg" data-k="kind"><button type="button" data-v="f2l">F2L</button><button type="button" data-v="ocll">OCLL</button><button type="button" data-v="pll">PLL</button></div>
      <div class="eo-seg" data-k="sort"><button type="button" data-v="focus" title="the seconds a solve fixing it is worth, the easy fixes first">worth most</button><button type="button" data-v="slow">slowest</button><button type="button" data-v="seen">most seen</button></div></div>`;
    h += cases.length ? `<div class="co-cases">${sorted.map(caseHtml).join('')}</div>
      <p class="note">${st.kind === 'f2l' ? 'F2L cases are numbered as the case sheet numbers them (the front-right twin); the alg is for the slot it came up on most, from where the pair was, with the slots that were open. ' : ''}Time and look are medians. "s/solve" is what getting it to your quick look plus the shortest alg at your own turning speed would save, times how often it comes up.</p>`
      : `<p class="note">No ${KIND_WORD[st.kind]} cases read yet.</p>`;
    body.innerHTML = h;
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((g) => g.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === (st as Record<string, string>)[g.dataset.k!])));
  }
  return draw;
}

function caseHtml(r: CaseRow): string {
  const adv = caseAdvice(r);
  const mv = r.par !== null ? `${fmt(r.moves)} moves (alg ${fmt(r.par)})` : `${fmt(r.moves)} moves`;
  return `<div class="co-case"><div class="h"><b>${esc(r.name)}</b><span class="m">seen ${r.n} · ${s1(r.time)} s · look ${s1(r.look)} s · ${mv}</span><span class="g">${s1(r.perSolveGain)} s/solve</span></div>
    <div class="d">${esc(adv.what)}</div><div class="w">${esc(adv.why)}</div></div>`;
}

function actionOf(a: Advice | undefined): CoachAction | null {
  if (!a) return null;
  if (a.f2lIds?.length) return { kind: 'f2l-cases', ids: a.f2lIds };
  if (a.kind === 'ocll' || a.kind === 'pll') return { kind: 'mode', mode: 'll', set: a.kind };
  if (a.title.includes('EOCross')) return { kind: 'mode', mode: 'eo' };
  if (a.title.includes('F2L')) return { kind: 'mode', mode: 'f2l' };
  return null;
}
function actBtn(a: Advice, i: number): string {
  const act = actionOf(a);
  if (!act) return '';
  const label = act.kind === 'f2l-cases' ? 'Practice these F2L cases' : act.mode === 'eo' ? 'Practice EOCross' : act.mode === 'f2l' ? 'Practice F2L' : `Practice ${act.set === 'ocll' ? 'OCLL' : 'PLL'}`;
  return `<button type="button" class="btn" data-act="${i}">${label}</button>`;
}

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// ---- the report under a solve ----

// DECISION: a solve is measured against the 50 analysed solves before it
const BASE_N = 50;

/** The report on one solve, as HTML; '' when it has no turns to read. `all` is analysedSolves()'s list. */
export function reportHtml(rec: SolveRecord, all: readonly Analysed[]): string {
  const a = analysedOne(rec);
  if (!a) return '';
  const at = all.findIndex((x) => x.rec.id === rec.id);
  const before = (at >= 0 ? all.slice(0, at) : all.filter((x) => x.rec.when < rec.when)).slice(-BASE_N).map((x) => x.a);
  const r = solveReport(a, before);
  const vs = (ms: number | null) => (ms === null ? '' : Math.abs(ms) < 50 ? '<span>±0</span>' : `<span class="${ms > 0 ? 'up' : 'dn'}">${ms > 0 ? '+' : '−'}${s1(Math.abs(ms))}</span>`);
  let h = `<div class="rp"><table>`;
  for (const row of r.rows) {
    if (row.label === 'AUF' && row.moves === 0) continue;
    const kase = row.skipped ? row.kase ?? 'skip' : row.together ? 'with the pair before' : row.kase ?? '';
    const p = a.phases[r.rows.indexOf(row)]!;
    const extra = p.algs && p.algs > 1 ? ` · ${p.algs} algs` : '';
    const mv = row.par !== null && !row.together ? `${row.moves}/${fmt(row.par)}` : row.together ? '' : String(row.moves);
    h += `<tr><td>${esc(row.label)}</td><td class="k">${esc(kase + extra)}</td><td>${s1(row.time)}</td><td>${vs(row.vs)}</td><td title="moves / the case's shortest alg">${mv}</td></tr>`;
  }
  h += `<tr><td><b>Solve</b></td><td class="k"></td><td><b>${s1(r.total)}</b></td><td>${vs(r.vsTotal)}</td><td>${a.moves}</td></tr></table>`;
  if (before.length < 3) h += `<p class="nx">After a few more solves each line is compared with your usual.</p>`;
  if (r.note) h += `<p class="nt">${esc(r.note)}</p>`;
  const adv = before.length >= MIN_SOLVES ? advise([...before, a])[0] : undefined;
  if (adv) h += `<p class="nx">Next to work on: <b>${esc(adv.title)}</b> (~${s1(adv.gain)} s a solve). <button type="button" class="btn eo-link" data-coach-open="1">Why</button></p>`;
  return `${h}</div>`;
}

/** The report's style, for the Solve tab. */
export function ensureCoachStyle(): void { ensureStyle('coach-style', STYLE); }

// Progress → Phases: one phase's time over the days (trend.ts), from the full solves, the drills or both, over the
// last week, month or everything. The graph is the Solves view's own (timer/graph.ts: a dot per attempt, the rolling
// averages); above it, the last stretch against the one before.

import type { Store } from '../store/local';
import { mountGraph } from '../timer/graph';
import { dayOf } from '../timer/when';
import { ensureStyle } from '../ui/dom';
import { persisted } from '../ui/settings';
import { analysedSolves } from './cache';
import { s1 } from './coach';
import { compare, TREND_PHASES, TREND_WORD, trendPoints, type TrendPhase, type TrendSource } from './trend';

const STYLE = `
  .tr-row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 0 0 10px; }
  .tr-row .lbl { font-size: 13px; color: var(--ink-2); min-width: 4.5em; }
  .tr-sum { font-size: 15px; margin: 4px 0 10px; } .tr-sum span { color: var(--ink-2); font-size: 13px; }
  .tr-none { color: var(--ink-2); font-size: 14px; }
`;
type Range = 'week' | 'month' | 'all';
const RANGE_DAYS: Record<Range, number> = { week: 7, month: 30, all: Infinity };
const SOURCE_WORD: Record<TrendSource, string> = { solves: 'Solves', drills: 'Drills', both: 'Both' };

export function mountTrend(root: HTMLElement, deps: { store: Promise<Store> }): () => Promise<void> {
  ensureStyle('trend-style', STYLE);
  const { settings: st, save } = persisted<{ phase: TrendPhase; src: TrendSource; range: Range }>('zz-trend', { phase: 'eocross', src: 'both', range: 'week' }, (s) => {
    if (!TREND_PHASES.includes(s.phase)) s.phase = 'eocross';
    if (!['solves', 'drills', 'both'].includes(s.src)) s.src = 'both';
    if (!['week', 'month', 'all'].includes(s.range)) s.range = 'week';
  });
  const seg = (key: string, vals: readonly string[], word: (v: string) => string) =>
    `<div class="eo-seg" data-tr="${key}">${vals.map((v) => `<button type="button" data-v="${v}">${word(v)}</button>`).join('')}</div>`;
  root.innerHTML = `
    <div class="tr-row"><span class="lbl">Phase</span>${seg('phase', TREND_PHASES, (v) => TREND_WORD[v as TrendPhase])}</div>
    <div class="tr-row"><span class="lbl">From</span>${seg('src', ['solves', 'drills', 'both'], (v) => SOURCE_WORD[v as TrendSource])}<span class="lbl">Over</span>${seg('range', ['week', 'month', 'all'], (v) => ({ week: 'Week', month: 'Month', all: 'All' })[v as Range])}</div>
    <p class="tr-sum" id="tr-sum"></p>
    <div id="tr-graph"></div>
    <p class="tr-none" id="tr-note"></p>`;
  const draw = mountGraph(root.querySelector<HTMLElement>('#tr-graph')!);
  const paint = () => root.querySelectorAll<HTMLElement>('[data-tr]').forEach((g) => g.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === st[g.dataset.tr as 'phase' | 'src' | 'range'])));
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tr] button[data-v]');
    if (!b) return;
    const k = b.closest<HTMLElement>('[data-tr]')!.dataset.tr as 'phase' | 'src' | 'range';
    (st as Record<string, string>)[k] = b.dataset.v!;
    save(); void render();
  });
  async function render(): Promise<void> {
    paint();
    const store = await deps.store;
    const [solves, attempts] = await Promise.all([analysedSolves(deps.store), store.listAttempts()]);
    const all = trendPoints(st.phase, st.src, solves, attempts);
    const days = RANGE_DAYS[st.range];
    const since = Number.isFinite(days) ? Date.now() - days * 86_400_000 : -Infinity;
    const pts = all.filter((p) => p.when >= since);
    const word = TREND_WORD[st.phase];
    const sum = root.querySelector<HTMLElement>('#tr-sum')!, note = root.querySelector<HTMLElement>('#tr-note')!;
    const cmpDays = Number.isFinite(days) ? days : 7;
    const c = compare(all, cmpDays);
    const span = cmpDays === 7 ? 'week' : `${cmpDays} days`;
    sum.innerHTML = c.now === null ? `No ${word} in the last ${span}.`
      : `${word}, the last ${span}: <b>${s1(c.now)} s</b> median <span>(${c.n})</span>${c.before !== null ? ` · the ${span} before: ${s1(c.before)} s <span>(${c.nBefore})</span>` : ''}`;
    const fromS = pts.filter((p) => p.from === 'solve').length, fromD = pts.length - fromS;
    note.textContent = pts.length ? `${pts.length} attempts: ${fromS} from solves, ${fromD} from drills.${st.phase === 'eo' || st.phase === 'cross' ? ' Drill attempts are split into EO and Cross from 27 Sep on (older ones kept the total only; an attempt that stopped at EO counts as EO).' : ''}${st.phase === 'f2l' ? ' F2L is timed in full solves only.' : ''}`
      : `Nothing to draw: no ${word} ${st.src === 'solves' ? 'in your solves' : st.src === 'drills' ? 'in your drills' : 'yet'} over this range.`;
    draw({ times: pts.map((p) => p.ms), whens: pts.map((p) => p.when), dated: true, dayOf: (w) => dayOf(w) });
  }
  return render;
}

// The F2L finder's "Practice so far": the targeted pairs solved, per case (the four mirrors counted as
// one, named by the front-right twin), sorted any way - worst first by default - with buttons that set
// the practice pool from it, and the last-layer drills' graph (a line per case, its running ao5). The
// numbers are ll/practice.ts's; the attempts are the store's, filed by the finder (trainer.ts).

import { caseLines, AVG_N, MIN_N, mountCaseGraph } from '../ll/practicegraph';
import { caseStats, DEFAULT_DIR, RECENT, secs, SORT_KEYS, sortStats, type CaseStats, type SortKey, trendText, workOn } from '../ll/practice';
import { dayOf } from '../timer/when';
import { esc } from '../ui/dom';
import { readAttempts } from '../ui/drill';
import { persisted } from '../ui/settings';
import { byTwin, pickedTwins, practiceCases, setPicks } from './pool';

const COLS: { key: SortKey; label: string; title: string }[] = [
  { key: 'name', label: 'case', title: 'the case number (front-right; its mirrors on the other slots count with it)' },
  { key: 'n', label: 'tries', title: 'targeted pairs solved' }, { key: 'best', label: 'best', title: 'the fastest timed try' },
  { key: 'recent', label: 'recent', title: `the mean of the last ${RECENT} timed tries` }, { key: 'trend', label: 'trend', title: `recent against the ${RECENT} tries before those: minus is faster` },
  { key: 'recognition', label: 'recog.', title: 'the cube at the scramble to the first turn' }, { key: 'execution', label: 'exec.', title: 'the first turn to the pair solved' },
  { key: 'last', label: 'last', title: 'when the case last came up' },
];

/** Mount the table in `els`; `changed` is called when its buttons set the pool. Returns the redraw. */
export function mountF2LPractice(els: { body: HTMLElement; graphWrap: HTMLElement; graph: HTMLElement; n: HTMLElement }, changed: () => void): () => Promise<void> {
  const { settings: sortBy, save: saveSort } = persisted<{ key: SortKey; dir: 'asc' | 'desc' }>('zz-f2l-practice-sort', { key: 'work', dir: 'asc' }, (st) => {
    if (!SORT_KEYS.includes(st.key) || st.key === 'quiz') st.key = 'work';
    if (st.dir !== 'asc' && st.dir !== 'desc') st.dir = DEFAULT_DIR[st.key];
  });
  const cases = practiceCases();
  const group = new Map(cases.map((c) => [c.name, c.group]));
  let graph: ReturnType<typeof mountCaseGraph> | null = null;

  async function render(): Promise<void> {
    const attempts = byTwin(await readAttempts('f2l'));
    const all = caseStats(attempts, cases);
    // the rows: every case tried, and the ones picked to practise (a case's mirrors are picked with it)
    const picked = pickedTwins();
    const shown = sortStats(all.filter((s) => s.n > 0 || picked.has(s.name)), sortBy.key, sortBy.dir);
    if (!all.some((s) => s.n > 0)) {
      els.body.innerHTML = '<p class="note">Nothing yet. Pick cases in the case sheet (All 83 cases, then Practise on a card), press Practise picked cases, and solve that pair first: each one is filed here, timed when a smart cube is following.</p>';
      els.graphWrap.hidden = true;
      return;
    }
    const anyFed = all.some((s) => s.recognition !== null);
    const cols = COLS.filter((c) => anyFed || (c.key !== 'recognition' && c.key !== 'execution'));
    const ago = (t: number | null) => { if (t === null) return '–'; const d = (Date.now() - t) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)}d ago`; };
    const th = (c: (typeof COLS)[number]) => {
      const on = sortBy.key === c.key;
      return `<th><button type="button" class="${on ? 'on' : ''}" data-sort="${c.key}" title="${esc(c.title)}">${c.label}${on ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
    };
    const cell = (s: CaseStats, key: SortKey): string => {
      switch (key) {
        case 'name': return `<td title="${esc(group.get(s.name) ?? '')}"><button type="button" class="linkbtn" data-graph="${s.id}">${s.name}</button> <small>${esc(group.get(s.name) ?? '')}</small></td>`;
        case 'n': return `<td>${s.n}</td>`;
        case 'best': return `<td>${secs(s.best)}</td>`;
        case 'recent': return `<td>${secs(s.recent)}</td>`;
        case 'trend': return `<td class="${s.trend === null || Math.abs(s.trend) < 50 ? '' : s.trend < 0 ? 'faster' : 'slower'}">${trendText(s.trend)}</td>`;
        case 'recognition': return `<td>${secs(s.recognition)}</td>`;
        case 'execution': return `<td>${secs(s.execution)}</td>`;
        case 'last': return `<td>${ago(s.last)}</td>`;
        default: return '<td></td>';
      }
    };
    els.body.innerHTML = `<div class="pscroll"><table><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>${shown.map((s) => `
      <tr class="${s.n < 3 ? 'dim' : ''}">${cols.map((c) => cell(s, c.key)).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">${sortBy.key === 'work' ? 'Worst first: the least practised (under three tries, greyed), then the slowest recently.' : 'Tap a heading to sort by it, again to flip it.'} A case's number is the front-right one; its mirrors on the other slots count with it. Recent = the last ${RECENT} timed tries; trend = those against the ${RECENT} before, minus is faster.</p>
      <div class="prow"><button type="button" class="linkbtn" data-work="5">Practise the five to work on</button><button type="button" class="linkbtn" data-work="8">the eight</button>${sortBy.key === 'work' ? '' : '<button type="button" class="linkbtn" data-sort="work">sort worst first</button>'}</div>`;
    const { lines, whens } = caseLines(attempts, cases);
    const drawn = lines.filter((l) => l.points.length);
    els.graphWrap.hidden = !whens.length;
    if (!whens.length) return;
    graph ??= mountCaseGraph(els.graph, 'zz-f2l-graph-hidden');
    els.n.textContent = `Each case's ao${AVG_N} (ao${MIN_N} until there are five), over ${whens.length} timed ${whens.length === 1 ? 'try' : 'tries'}: a line that comes down is a case being learnt.`;
    graph.draw({ lines: drawn, whens, dayOf: (w) => dayOf(w) });
  }

  els.body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>('[data-sort]');
    if (sort) {
      const key = sort.dataset.sort as SortKey;
      sortBy.dir = key === sortBy.key ? (sortBy.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[key];
      sortBy.key = key;
      saveSort(); void render();
      return;
    }
    const one = t.closest<HTMLElement>('[data-graph]');
    if (one) { graph?.only(one.dataset.graph!); els.graphWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const b = t.closest<HTMLElement>('[data-work]');
    if (!b) return;
    void (async () => {
      const stats = workOn(caseStats(byTwin(await readAttempts('f2l')), cases));
      // the worst of what has been tried (an untried case is not one to work on yet: it was never picked)
      const pick = stats.filter((s) => s.n > 0).slice(0, Number(b.dataset.work));
      if (pick.length) { setPicks(pick.map((s) => s.id)); changed(); }
    })();
  });
  return render;
}

// Progress → Drills (user, 2026-09-27: "I assume my drills are saved? I don't see a way to view history or delete
// them"): every drill attempt the store holds, newest first, filtered by drill, each with a delete (a tombstone, so a
// signed-in phone's other devices drop it too) and an undo while the list is up.

import { htm } from '../cube/alg';
import { caseOf, twinOf } from '../f2l/model';
import type { Store } from '../store/local';
import type { AttemptRecord, AttemptStage } from '../store/types';
import { clockOf, dayOf, fullOf } from '../timer/when';
import { ensureStyle, esc } from '../ui/dom';

const STYLE = `
  .dh-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }
  .dh-n { font-size: 13px; color: var(--ink-2); }
  .dh-list { list-style: none; margin: 0; padding: 0; }
  .dh-list li { display: flex; gap: 10px; align-items: baseline; padding: 7px 2px; border-bottom: 1px solid var(--line); font-size: 14px; }
  .dh-list .w { color: var(--ink-2); font-size: 12px; min-width: 6.5em; white-space: nowrap; }
  .dh-list .k { min-width: 4.5em; font-weight: 600; }
  .dh-list .t { min-width: 3.5em; font-variant-numeric: tabular-nums; }
  .dh-list .d { color: var(--ink-2); font-size: 12px; flex: 1; min-width: 0; }
  .dh-list button { font: inherit; font-size: 12px; background: none; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; color: var(--ink-2); cursor: pointer; }
  .dh-list li.gone > :not(button) { text-decoration: line-through; opacity: .5; }
  .dh-more { margin-top: 10px; }
`;
type Filter = 'all' | AttemptStage;
const FILTERS: [Filter, string][] = [['all', 'All'], ['eo', 'EO'], ['f2l', 'F2L'], ['ocll', 'OCLL'], ['pll', 'PLL']];
const STAGE_WORD: Record<AttemptStage, string> = { eo: 'EO', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL', plan: 'Plan' };
const PAGE = 100;

/** A drill attempt in a line: its case, moves against the optimum, the inspection, how it was fed, a peek. */
function detail(a: AttemptRecord): { kase: string; rest: string } {
  let kase = '';
  if (a.caseId) {
    const f = a.stage === 'f2l' ? caseOf(a.caseId) : null;
    kase = f ? `case ${twinOf(f.slot, f.c.n)}` : a.caseId;
  }
  const moves = a.moves.trim() ? htm(a.moves) : 0; // a cube's half turn (two quarter reports) is one move
  const bits = [
    moves ? `${moves} moves${a.optimal !== undefined ? ` (optimal ${a.optimal})` : ''}` : '',
    a.eoSplit !== undefined && a.time !== null ? `EO ${(a.eoSplit / 1000).toFixed(1)} + cross ${((a.time - a.eoSplit) / 1000).toFixed(1)}` : '',
    a.recognition !== undefined ? `inspection ${(a.recognition / 1000).toFixed(1)}` : '',
    a.start === 'repeat' ? 'repeat' : a.start ? `from ${a.start === 'pair' ? 'the last pair' : 'OCLL'}` : '',
    a.quiz ? `named: ${a.quiz === 'gaveUp' ? 'gave up' : a.quiz}` : '',
    a.source === 'typed' ? 'typed' : '',
    a.assisted ? 'peeked' : '',
  ];
  return { kase, rest: bits.filter(Boolean).join(' · ') };
}

export function mountDrillHistory(root: HTMLElement, deps: { store: Promise<Store> }): () => Promise<void> {
  ensureStyle('drillhist-style', STYLE);
  let filter: Filter = 'all', shown = PAGE;
  const gone = new Map<string, AttemptRecord>(); // deleted while the list is up: undoable
  root.innerHTML = `<div class="dh-row"><div class="eo-seg" id="dh-filter">${FILTERS.map(([v, w]) => `<button type="button" data-v="${v}">${w}</button>`).join('')}</div><span class="dh-n" id="dh-n"></span></div>
    <ul class="dh-list" id="dh-list"></ul><button type="button" class="btn dh-more" id="dh-more" hidden></button>`;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  let rows: AttemptRecord[] = [];
  async function render(): Promise<void> {
    $('dh-filter').querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === filter));
    const st = await deps.store;
    const live = await st.listAttempts(filter === 'all' ? undefined : filter);
    // the ones deleted while the list is up stay in it (struck through, with an undo)
    rows = [...live, ...[...gone.values()].filter((g) => filter === 'all' || g.stage === filter)].sort((a, b) => b.when - a.when);
    const list = rows.slice(0, shown);
    $('dh-n').textContent = `${live.length} attempt${live.length === 1 ? '' : 's'}`;
    $('dh-list').innerHTML = list.map((a) => {
      const d = detail(a), del = gone.has(a.id);
      return `<li data-id="${esc(a.id)}"${del ? ' class="gone"' : ''}><span class="w" title="${esc(fullOf(a.when))}">${dayOf(a.when)} ${clockOf(a.when)}</span><span class="k">${STAGE_WORD[a.stage]}${d.kase ? ` ${esc(d.kase)}` : ''}</span><span class="t">${a.time === null ? '–' : (a.time / 1000).toFixed(2)}</span><span class="d">${esc(d.rest)}</span><button type="button" data-del="${esc(a.id)}">${del ? 'Undo' : 'Delete'}</button></li>`;
    }).join('') || '<li class="d">No drill attempts yet.</li>';
    const more = $('dh-more');
    more.hidden = rows.length <= shown;
    more.textContent = `Show ${Math.min(PAGE, rows.length - shown)} more`;
  }
  $('dh-filter').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-v]');
    if (!b) return;
    filter = b.dataset.v as Filter; shown = PAGE; void render();
  });
  $('dh-more').addEventListener('click', () => { shown += PAGE; void render(); });
  $('dh-list').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-del]');
    if (!b) return;
    const id = b.dataset.del!, st = await deps.store;
    const was = gone.get(id);
    if (was) { gone.delete(id); await st.putAttempt({ ...was, deleted: false, editedAt: Date.now() }); }
    else {
      const a = rows.find((r) => r.id === id);
      if (!a) return;
      gone.set(id, a);
      await st.putAttempt({ ...a, deleted: true, editedAt: Date.now() });
    }
    void render();
  });
  return async () => { gone.clear(); shown = PAGE; await render(); };
}

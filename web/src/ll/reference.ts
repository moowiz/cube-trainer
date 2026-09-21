// The last-layer case reference: every OCLL or PLL case with its picture,
// its alg (triggers labelled), what to look for, and what it chains to -
// the case a solved cube is at after the alg, so two cases can be drilled
// back to back with no scramble. Tapping a case drills it; its "play"
// button opens the 3D player (algs/player.ts) in the card instead.

import { nxnAnimatable } from '../algs/nxn3d';
import { mountPlayer } from '../algs/player';
import { inverse, moveCount, tokens } from '../cube/alg';
import { onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { closeSheet, openSheet } from '../shell';
import { triggers } from '../ui/fingertricks';
import { CASES, type LLCase, type LLKind } from './cases';
import { features, type Features } from './features';
import { chainPartner } from './model';
import { ensurePicStyle, picSvg } from './pic';

const STYLE = `
  .llr-filters { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 0 0 12px; }
  .llr-filters .lbl { font-size: 13px; color: var(--ink-2); margin-right: 2px; }
  .llr-filters .gap { flex-basis: 100%; height: 0; }
  .llr-filters .eo-chip.on { color: var(--bg); background: var(--ink); border-color: var(--ink); }
  .llr-filters .eo-chip small { opacity: .7; margin-left: 3px; }
  .llr-count { font-size: 13px; color: var(--ink-2); margin: 0 0 10px; }
  .llr-tags { font-size: 12px; color: var(--ink-2); }
  .llr-chains { font-size: 14px; color: var(--ink-2); margin: 0 0 14px; }
  .llr-chains b { color: var(--ink); font-weight: 600; }
  .llr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; align-items: start; }
  .llr-case { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; align-content: start; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); cursor: pointer; text-align: left; font: inherit; color: inherit; }
  .llr-case:hover { background: #fff; }
  .llr-play { font: inherit; font-size: 12px; padding: 0; border: 0; background: none; color: var(--ink-2); text-decoration: underline; cursor: pointer; justify-self: start; }
  .llr-play.on { color: var(--ink); font-weight: 600; }
  .llr-player { grid-column: 1 / -1; cursor: auto; }
  .llr-player:empty { display: none; }
  .llr-case .ll-pic { grid-row: span 5; max-width: none; margin: 0; }
  .llr-name { font-weight: 600; font-size: 16px; }
  .llr-name small { font-weight: 400; color: var(--ink-2); margin-left: 6px; }
  .llr-alg { font-size: 15px; word-spacing: .25em; line-height: 1.5; }
  .llr-alg .ll-trig { padding-bottom: 12px; }
  .llr-hint, .llr-chain { font-size: 13px; color: var(--ink-2); }
  .llr-chain b { color: var(--ink); font-weight: 600; }
`;

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };

// ---- the filters: each chip is a predicate on a case's features; a case shows when every chip on matches ----
interface Filter { key: string; group: string; label: string; test(f: Features): boolean }
const FILTERS: Filter[] = [
  { key: 'c-solved', group: 'Corners', label: 'solved', test: (f) => f.corners === 'solved' },
  { key: 'c-3', group: 'Corners', label: '3-cycle', test: (f) => f.corners === '3-cycle' },
  { key: 'c-adj', group: 'Corners', label: 'adjacent swap', test: (f) => f.corners === 'adjacent swap' },
  { key: 'c-diag', group: 'Corners', label: 'diagonal swap', test: (f) => f.corners === 'diagonal swap' },
  { key: 'c-2', group: 'Corners', label: 'two swaps', test: (f) => f.corners === 'two swaps' },
  { key: 'e-solved', group: 'Edges', label: 'solved', test: (f) => f.edges === 'solved' },
  { key: 'e-3', group: 'Edges', label: '3-cycle', test: (f) => f.edges === '3-cycle' },
  { key: 'e-adj', group: 'Edges', label: 'adjacent swap', test: (f) => f.edges === 'adjacent swap' },
  { key: 'e-opp', group: 'Edges', label: 'opposite swap', test: (f) => f.edges === 'opposite swap' },
  { key: 'e-2', group: 'Edges', label: 'two swaps', test: (f) => f.edges === 'two swaps' },
  { key: 's-bar3', group: 'Sides', label: 'a bar of three', test: (f) => f.sides.bar3 > 0 },
  { key: 's-head', group: 'Sides', label: 'headlights', test: (f) => f.sides.headlights > 0 },
  { key: 's-nohead', group: 'Sides', label: 'no headlights', test: (f) => f.sides.headlights === 0 },
  { key: 's-bar2', group: 'Sides', label: 'a bar of two', test: (f) => f.sides.bar2 > 0 },
  { key: 's-nobar', group: 'Sides', label: 'no bars at all', test: (f) => f.sides.bar2 === 0 && f.sides.bar3 === 0 },
  { key: 's-blank', group: 'Sides', label: 'a side with nothing', test: (f) => f.sides.none > 0 },
];

/** The tag line under a case: its cycle types and what its sides show, with counts. */
export function tagLine(f: Features): string {
  const sides = [f.sides.bar3 && `bar of three ×${f.sides.bar3}`, f.sides.headlights && `headlights ×${f.sides.headlights}`, f.sides.bar2 && `bar of two ×${f.sides.bar2}`, f.sides.none && `nothing ×${f.sides.none}`].filter(Boolean).join(', ');
  return `corners ${f.corners} · edges ${f.edges} · ${sides}`;
}

/** The alg as HTML with the named triggers bracketed and labelled under their moves. */
export function algHtml(alg: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const toks = tokens(alg);
  const trig = triggers(alg);
  const parts: string[] = [];
  for (let i = 0; i < toks.length; ) {
    const g = trig.find((t) => t.at === i);
    if (g) { parts.push(`<span class="ll-trig">${esc(toks.slice(i, i + g.n).join(' '))}<i>${esc(g.label)}</i></span>`); i += g.n; }
    else { parts.push(esc(toks[i]!)); i++; }
  }
  return parts.join(' ');
}

/** The chain summary: cases that undo themselves, pairs that undo each other, and one-way chains (an alg that permutes too). */
export function chainSummary(kind: LLKind): { self: LLCase[]; pairs: [LLCase, LLCase][]; oneWay: [LLCase, LLCase][] } {
  const self: LLCase[] = [], pairs: [LLCase, LLCase][] = [], oneWay: [LLCase, LLCase][] = [];
  const seen = new Set<string>();
  for (const c of CASES[kind]) {
    const p = chainPartner(kind, c);
    if (!p) continue;
    if (p.id === c.id) self.push(c);
    else if (chainPartner(kind, p)?.id === c.id) { if (!seen.has(c.id)) { pairs.push([c, p]); seen.add(p.id); } }
    else oneWay.push([c, p]);
    seen.add(c.id);
  }
  return { self, pairs, oneWay };
}

/** Open the reference sheet for `kind`; `drill(setup)` is called with a case's setup alg when one is tapped. */
export function openLLReference(kind: LLKind, drill: (setup: string) => void): void {
  if (!document.getElementById('llr-style')) {
    const s = document.createElement('style'); s.id = 'llr-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  ensurePicStyle();
  const panel = document.getElementById('ref-panel');
  const head = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head b');
  const sub = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head .sub');
  if (!panel || !head || !sub) throw new Error('index.html is missing the reference sheet');
  head.textContent = `${TITLE[kind]}: the ${CASES[kind].length} cases`;
  sub.textContent = kind === 'pll'
    ? 'Each case as it looks from the front with its standard alg; the arrows show where each piece goes. Tap a case to drill it.'
    : 'Each case as it looks from the front (any permutation) with its standard alg. Tap a case to drill it.';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const feats = new Map(CASES[kind].map((c) => [c.id, features(state(inverse(c.alg)))]));
  const active = new Set<string>();
  const shown = (c: LLCase) => { const f = feats.get(c.id); return !f || FILTERS.every((x) => !active.has(x.key) || x.test(f)); };
  const filterBar = () => {
    if (kind !== 'pll') return '';
    const count = (x: Filter) => CASES[kind].filter((c) => { const f = feats.get(c.id); return f && x.test(f) && FILTERS.every((y) => y === x || !active.has(y.key) || y.test(f)); }).length;
    let group = '', out = '<div class="llr-filters">';
    for (const x of FILTERS) {
      if (x.group !== group) { out += `${group ? '<span class="gap"></span>' : ''}<span class="lbl">${x.group}</span>`; group = x.group; }
      out += `<button type="button" class="eo-chip${active.has(x.key) ? ' on' : ''}" data-filter="${x.key}">${esc(x.label)}<small>${count(x)}</small></button>`;
    }
    const n = CASES[kind].filter(shown).length;
    return `${out}</div><p class="llr-count">${active.size ? `${n} of ${CASES[kind].length} cases match${n ? '' : ': nothing has all of that'}.` : 'Tap the chips to narrow the list; a case shows when it matches every chip that is on.'}</p>`;
  };
  const render = () => {
    const { self, pairs, oneWay } = chainSummary(kind);
    const names = (cs: LLCase[]) => cs.map((c) => `<b>${esc(c.name)}</b>`).join(', ');
    panel.innerHTML = `
      <p class="llr-chains">Chains: doing an alg on a solved cube sets up the case whose alg undoes it, so these can be drilled back to back with no scramble.
        ${pairs.length ? `Pairs: ${pairs.map(([a, b]) => `<b>${esc(a.name)}</b> ↔ <b>${esc(b.name)}</b>`).join(', ')}.` : ''}
        ${self.length ? `Their own inverse (the alg twice is solved): ${names(self)}.` : ''}
        ${oneWay.length ? `One way: ${oneWay.map(([a, b]) => `<b>${esc(a.name)}</b> → <b>${esc(b.name)}</b>`).join(', ')}.` : ''}</p>
      ${filterBar()}
      <div class="llr-grid">${CASES[kind].filter(shown).map((c) => {
        const p = chainPartner(kind, c);
        const f = feats.get(c.id);
        const chain = !p ? '' : p.id === c.id ? 'Chains to itself: the alg again solves it.' : `Chains to <b>${esc(p.name)}</b>: after the alg, that is the case on the cube${chainPartner(kind, p)?.id === c.id ? ', and its alg brings this one back' : ''}.`;
        return `<div class="llr-case" data-id="${esc(c.id)}" role="button" tabindex="0">
          <div class="ll-pic"><svg viewBox="0 0 200 200" aria-label="${esc(c.name)}">${picSvg(state(inverse(c.alg)), kind)}</svg></div>
          <div class="llr-name">${esc(c.name)}<small>${moveCount(c.alg)} moves</small></div>
          <div class="llr-alg">${algHtml(c.alg)}</div>
          <div class="llr-hint">${esc(c.hint[0]!.toUpperCase() + c.hint.slice(1))}.</div>
          ${f ? `<div class="llr-tags">${esc(tagLine(f))}</div>` : ''}
          <div class="llr-chain">${chain}</div>
          <button type="button" class="llr-play" data-play="${esc(c.id)}">▶ play it in 3D</button>
          <div class="llr-player"></div>
        </div>`;
      }).join('')}</div>`;
  };
  // the 3D player: one open at a time, in the case's card; a redraw drops it
  let player: { destroy(): void; button: HTMLElement } | null = null;
  const closePlayer = () => { player?.destroy(); player?.button.classList.remove('on'); player = null; };
  const draw = () => { closePlayer(); render(); };
  draw();
  panel.onclick = (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>('[data-filter]');
    if (chip) { const k = chip.dataset.filter!; if (active.has(k)) active.delete(k); else active.add(k); draw(); return; }
    const play = t.closest<HTMLElement>('[data-play]');
    if (play) {
      const wasOpen = player?.button === play;
      closePlayer();
      const c = CASES[kind].find((x) => x.id === play.dataset.play);
      if (wasOpen || !c) return;
      const host = play.closest('.llr-case')!.querySelector<HTMLElement>('.llr-player')!;
      const handle = mountPlayer(host, nxnAnimatable(3, c.alg, state(inverse(c.alg))));
      player = { destroy: () => handle.destroy(), button: play };
      play.classList.add('on');
      return;
    }
    if (t.closest('.llr-player')) return; // the player's own controls
    const b = t.closest<HTMLElement>('.llr-case');
    if (!b) return;
    const c = CASES[kind].find((x) => x.id === b.dataset.id);
    if (!c) return;
    closeSheet('ref-sheet');
    drill(inverse(c.alg));
  };
  panel.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).classList.contains('llr-case')) { e.preventDefault(); (e.target as HTMLElement).click(); } };
  if (!schemeHooked) { schemeHooked = true; onSchemeChange(() => { if (!document.getElementById('ref-sheet')!.hidden) draw(); }); }
  openSheet('ref-sheet');
}
let schemeHooked = false;

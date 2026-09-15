// The last-layer case reference: every OCLL or PLL case with its picture,
// its alg (triggers labelled), what to look for, and what it chains to -
// the case a solved cube is at after the alg, so two cases can be drilled
// back to back with no scramble. Tapping a case drills it.

import { inverse, moveCount, tokens } from '../cube/alg';
import { onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { closeSheet, openSheet } from '../shell';
import { triggers } from '../ui/fingertricks';
import { CASES, type LLCase, type LLKind } from './cases';
import { chainPartner } from './model';
import { ensurePicStyle, picSvg } from './pic';

const STYLE = `
  .llr-chains { font-size: 14px; color: var(--ink-2); margin: 0 0 14px; }
  .llr-chains b { color: var(--ink); font-weight: 600; }
  .llr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .llr-case { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); cursor: pointer; text-align: left; font: inherit; color: inherit; }
  .llr-case:hover { background: #fff; }
  .llr-case .ll-pic { grid-row: span 4; max-width: none; margin: 0; }
  .llr-name { font-weight: 600; font-size: 16px; }
  .llr-name small { font-weight: 400; color: var(--ink-2); margin-left: 6px; }
  .llr-alg { font-size: 15px; word-spacing: .25em; line-height: 1.5; }
  .llr-alg .ll-trig { padding-bottom: 12px; }
  .llr-hint, .llr-chain { font-size: 13px; color: var(--ink-2); }
  .llr-chain b { color: var(--ink); font-weight: 600; }
`;

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };

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
  const render = () => {
    const { self, pairs, oneWay } = chainSummary(kind);
    const names = (cs: LLCase[]) => cs.map((c) => `<b>${esc(c.name)}</b>`).join(', ');
    panel.innerHTML = `
      <p class="llr-chains">Chains: doing an alg on a solved cube sets up the case whose alg undoes it, so these can be drilled back to back with no scramble.
        ${pairs.length ? `Pairs: ${pairs.map(([a, b]) => `<b>${esc(a.name)}</b> ↔ <b>${esc(b.name)}</b>`).join(', ')}.` : ''}
        ${self.length ? `Their own inverse (the alg twice is solved): ${names(self)}.` : ''}
        ${oneWay.length ? `One way: ${oneWay.map(([a, b]) => `<b>${esc(a.name)}</b> → <b>${esc(b.name)}</b>`).join(', ')}.` : ''}</p>
      <div class="llr-grid">${CASES[kind].map((c) => {
        const p = chainPartner(kind, c);
        const chain = !p ? '' : p.id === c.id ? 'Chains to itself: the alg again solves it.' : `Chains to <b>${esc(p.name)}</b>: after the alg, that is the case on the cube${chainPartner(kind, p)?.id === c.id ? ', and its alg brings this one back' : ''}.`;
        return `<button type="button" class="llr-case" data-id="${esc(c.id)}">
          <div class="ll-pic"><svg viewBox="0 0 200 200" aria-label="${esc(c.name)}">${picSvg(state(inverse(c.alg)), kind)}</svg></div>
          <div class="llr-name">${esc(c.name)}<small>${moveCount(c.alg)} moves</small></div>
          <div class="llr-alg">${algHtml(c.alg)}</div>
          <div class="llr-hint">${esc(c.hint[0]!.toUpperCase() + c.hint.slice(1))}.</div>
          <div class="llr-chain">${chain}</div>
        </button>`;
      }).join('')}</div>`;
  };
  render();
  panel.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.llr-case');
    if (!b) return;
    const c = CASES[kind].find((x) => x.id === b.dataset.id);
    if (!c) return;
    closeSheet('ref-sheet');
    drill(inverse(c.alg));
  };
  if (!schemeHooked) { schemeHooked = true; onSchemeChange(() => { if (!document.getElementById('ref-sheet')!.hidden) render(); }); }
  openSheet('ref-sheet');
}
let schemeHooked = false;

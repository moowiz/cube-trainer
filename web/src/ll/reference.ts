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
import { CASES, isFavourite, type LLCase, type LLKind, matchesName } from './cases';
import { onFavsChange, setFavourite } from './favs';
import { algAngle, features, type Features } from './features';
import { chainPartner } from './model';
import { ensurePicStyle, picSvg } from './pic';
import { ensureStyle, esc } from '../ui/dom';

const STYLE = `
  /* a phone: the head's blurb under the title and the Close button, not squeezed into a column beside them */
  @media (max-width: 700px) {
    #ref-sheet .zz-sheet-head { flex-wrap: wrap; }
    #ref-sheet .zz-sheet-head .sub { flex-basis: 100%; order: 3; font-size: 12px; }
  }
  .llr-filters { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 0 0 12px; }
  .llr-filters .lbl { font-size: 13px; color: var(--ink-2); margin-right: 2px; }
  .llr-filters .gap { flex-basis: 100%; height: 0; }
  .llr-filters .eo-chip.on { color: var(--bg); background: var(--ink); border-color: var(--ink); }
  .llr-filters .eo-chip small { opacity: .7; margin-left: 3px; }
  .llr-search { font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink); width: 9em; }
  .llr-count { font-size: 13px; color: var(--ink-2); margin: 0 0 10px; }
  .llr-tags { font-size: 12px; color: var(--ink-2); }
  .llr-chains { font-size: 13px; color: var(--ink-2); margin: 0 0 12px; }
  .llr-chains b { color: var(--ink); font-weight: 600; }
  .llr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; align-items: start; }
  .llr-case { display: block; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); text-align: left; font: inherit; color: inherit; }
  .llr-drill { font: inherit; font-size: 13px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--ink); cursor: pointer; }
  .llr-drill:hover { border-color: var(--ink); }
  .llr-head { display: flex; align-items: center; gap: 10px; }
  .llr-head .ll-pic { width: 64px; flex: none; }
  .llr-play { font: inherit; font-size: 12px; padding: 0; border: 0; background: none; color: var(--ink-2); text-decoration: underline; cursor: pointer; justify-self: start; }
  .llr-play.on { color: var(--ink); font-weight: 600; }
  .llr-player { grid-column: 1 / -1; cursor: auto; }
  .llr-player:empty { display: none; }
  .llr-case .ll-pic { max-width: none; margin: 0; }
  .llr-name { font-weight: 600; font-size: 17px; }
  .llr-name small { font-weight: 400; font-size: 13px; color: var(--ink-2); margin-left: 6px; }
  .llr-alg { font-size: 17px; word-spacing: .35em; line-height: 1.9; margin: 8px 0 2px; }
  .llr-alg .ll-trig { padding-bottom: 13px; }
  .llr-more { margin: 6px 0 0; font-size: 13px; color: var(--ink-2); }
  .llr-more summary { cursor: pointer; }
  .llr-alt { margin: 6px 0 0; }
  .llr-alt .llr-alg { font-size: 15px; line-height: 1.8; margin: 0; }
  .llr-alt small { display: block; font-size: 12px; color: var(--ink-2); margin-top: 1px; }
  .llr-fav { font: inherit; font-size: 15px; line-height: 1; padding: 2px 5px; border: 0; background: none; color: var(--ink-2); cursor: pointer; vertical-align: middle; word-spacing: normal; }
  .llr-fav.on { color: #C8930A; }
  .llr-fav:hover { color: var(--ink); }
  .llr-hint { font-size: 13px; color: var(--ink-2); margin-top: 4px; }
  .llr-chain { font-size: 12px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .llr-foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-top: 8px; }
  .llr-foot .llr-tags { flex: 1 1 100%; }
  .llr-hint b, .llr-chain b { color: var(--ink); font-weight: 600; }
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
function tagLine(f: Features): string {
  const sides = [f.sides.bar3 && `bar of three ×${f.sides.bar3}`, f.sides.headlights && `headlights ×${f.sides.headlights}`, f.sides.bar2 && `bar of two ×${f.sides.bar2}`, f.sides.none && `nothing ×${f.sides.none}`].filter(Boolean).join(', ');
  return `corners ${f.corners} · edges ${f.edges} · ${sides}`;
}

/** The alg as HTML with the named triggers bracketed and labelled under their moves. */
export function algHtml(alg: string): string {
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

/**
 * Open the reference sheet for `kind`; `drill(setup)` is called with a case's setup alg when one is tapped,
 * `changed` when a case's main alg is changed with the star (the drill's case may be showing the old one).
 */
export function openLLReference(kind: LLKind, drill: (setup: string) => void, changed?: () => void): void {
  ensureStyle('llr-style', STYLE);
  ensurePicStyle();
  const panel = document.getElementById('ref-panel');
  const head = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head b');
  const sub = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head .sub');
  if (!panel || !head || !sub) throw new Error('index.html is missing the reference sheet');
  head.textContent = `${TITLE[kind]}: the ${CASES[kind].length} cases`;
  sub.textContent = kind === 'pll'
    ? 'The arrows show where each piece goes. Drill this case sets the drill on it, a star makes an alg the one the drill uses. A chain is what an alg leaves on a solved cube: those two drill back to back, no scramble.'
    : 'Each case as it looks from the front, any permutation. Drill this case sets the drill on it, a star makes an alg the one the drill uses. A chain is what an alg leaves on a solved cube: those two drill back to back, no scramble.';
  const feats = () => new Map(CASES[kind].map((c) => [c.id, features(state(inverse(c.alg)))]));
  let feat = feats();
  const active = new Set<string>();
  let namePat = ''; // the name box: "G", "R*", "Ja Jb"
  const shown = (c: LLCase) => { const f = feat.get(c.id); return matchesName(c, namePat) && (!f || FILTERS.every((x) => !active.has(x.key) || x.test(f))); };
  const filterBar = () => {
    const nameBox = `<span class="lbl">Name</span><input class="llr-search" id="llr-name" type="search" placeholder="G, R*, Ja Jb" value="${esc(namePat).replace(/"/g, '&quot;')}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
    if (kind !== 'pll') return `<div class="llr-filters">${nameBox}</div>`;
    const count = (x: Filter) => CASES[kind].filter((c) => { const f = feat.get(c.id); return f && matchesName(c, namePat) && x.test(f) && FILTERS.every((y) => y === x || !active.has(y.key) || y.test(f)); }).length;
    let group = '', out = `<div class="llr-filters">${nameBox}<span class="gap"></span>`;
    for (const x of FILTERS) {
      if (x.group !== group) { out += `${group ? '<span class="gap"></span>' : ''}<span class="lbl">${x.group}</span>`; group = x.group; }
      out += `<button type="button" class="eo-chip${active.has(x.key) ? ' on' : ''}" data-filter="${x.key}">${esc(x.label)}<small>${count(x)}</small></button>`;
    }
    const n = CASES[kind].filter(shown).length;
    return `${out}</div><p class="llr-count">${active.size || namePat ? `${n} of ${CASES[kind].length} cases match${n ? '' : ': nothing has all of that'}.` : 'Type a name (G, R*, Ja Jb) or tap the chips to narrow the list; a case shows when it matches every chip that is on.'}</p>`;
  };
  const render = () => {
    const { self, pairs, oneWay } = chainSummary(kind);
    const names = (cs: LLCase[]) => cs.map((c) => `<b>${esc(c.name)}</b>`).join(', ');
    panel.innerHTML = `
      <p class="llr-chains">${[
        pairs.length ? `Chains: ${pairs.map(([a, b]) => `<b>${esc(a.name)}</b> ↔ <b>${esc(b.name)}</b>`).join(', ')}` : '',
        self.length ? `their own inverse: ${names(self)}` : '',
        oneWay.length ? `one way: ${oneWay.map(([a, b]) => `<b>${esc(a.name)}</b> → <b>${esc(b.name)}</b>`).join(', ')}` : '',
      ].filter(Boolean).join(' · ')}.</p>
      ${filterBar()}
      <div class="llr-grid">${CASES[kind].filter(shown).map((c) => {
        const p = chainPartner(kind, c);
        const f = feat.get(c.id);
        const star = (alg: string, on: boolean) => `<button type="button" class="llr-fav${on ? ' on' : ''}" data-fav="${esc(alg)}" title="${on ? 'This is the alg the drill uses (tap for the standard one)' : 'Make this the alg the drill uses'}">${on ? '★' : '☆'}</button>`;
        const chain = !p ? '' : `<span class="llr-chain" title="${p.id === c.id ? 'The alg again solves it' : 'After the alg, that is the case on the cube'}">${p.id === c.id ? '↻ itself' : `↔ ${esc(p.name)}`}</span>`;
        const alts = c.alts ?? [];
        return `<div class="llr-case" data-id="${esc(c.id)}">
          <div class="llr-head">
            <div class="ll-pic"><svg viewBox="0 0 200 200" aria-label="${esc(c.name)}">${picSvg(state(inverse(c.alg)), kind)}</svg></div>
            <div class="llr-name">${esc(c.name)}<small>${moveCount(c.alg)} moves</small>${isFavourite(kind, c.id) ? '<small>your pick</small>' : ''}</div>
            ${chain}
          </div>
          <div class="llr-alg">${algHtml(c.alg)}${alts.length ? star(c.alg, true) : ''}</div>
          <div class="llr-hint">${esc(c.hint[0]!.toUpperCase() + c.hint.slice(1))}.${kind === 'pll' ? ` <b>For the alg:</b> ${esc(algAngle(c))}.` : ''}</div>
          ${alts.length ? `<details class="llr-more"><summary>${alts.length} other alg${alts.length === 1 ? '' : 's'}</summary>${alts.map((a) => `<div class="llr-alt"><span class="llr-alg">${algHtml(a.alg)}</span>${star(a.alg, false)}<small>${esc(a.note)}</small></div>`).join('')}</details>` : ''}
          <div class="llr-foot"><button type="button" class="llr-drill" data-drill="${esc(c.id)}">Drill this case</button><button type="button" class="llr-play" data-play="${esc(c.id)}">▶ play it in 3D</button>${f ? `<span class="llr-tags">${esc(tagLine(f))}</span>` : ''}</div>
          <div class="llr-player"></div>
        </div>`;
      }).join('')}</div>`;
  };
  // the 3D player: one open at a time, in the case's card; a redraw drops it
  let player: { destroy(): void; button: HTMLElement } | null = null;
  const closePlayer = () => { player?.destroy(); player?.button.classList.remove('on'); player = null; };
  const draw = () => { closePlayer(); render(); };
  draw();
  // the name box: typed into, the list follows; the redraw replaces the box, so the caret goes back where it was
  panel.addEventListener('input', (e) => {
    const box = e.target as HTMLInputElement;
    if (box.id !== 'llr-name') return;
    namePat = box.value;
    const at = box.selectionStart ?? namePat.length;
    draw();
    const again = panel.querySelector<HTMLInputElement>('#llr-name');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  });
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
    const fav = t.closest<HTMLElement>('[data-fav]');
    if (fav) {
      const id = fav.closest<HTMLElement>('.llr-case')!.dataset.id!;
      // the star on the main puts the standard alg back; on an alt it makes that one the main
      if (setFavourite(kind, id, fav.classList.contains('on') ? null : fav.dataset.fav!)) { feat = feats(); draw(); changed?.(); }
      return;
    }
    // Drill this case: everything else in the card (a star, the other-algs fold, the player) is its own control
    const go = t.closest<HTMLElement>('[data-drill]');
    if (!go) return;
    const c = CASES[kind].find((x) => x.id === go.dataset.drill);
    if (!c) return;
    closeSheet('ref-sheet');
    drill(inverse(c.alg));
  };
  if (!schemeHooked) { schemeHooked = true; onSchemeChange(() => { if (!document.getElementById('ref-sheet')!.hidden) draw(); }); }
  // a favourite from another device while the sheet is up: redrawn (the case list is whatever the table says)
  if (!favsHooked) { favsHooked = true; onFavsChange(() => { if (!document.getElementById('ref-sheet')!.hidden) { feat = feats(); draw(); } }); }
  openSheet('ref-sheet');
  // the name box ready to type into (a phone keyboard would cover the list, so only where there is a mouse)
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) panel.querySelector<HTMLInputElement>('#llr-name')?.focus();
}
let schemeHooked = false;
let favsHooked = false;

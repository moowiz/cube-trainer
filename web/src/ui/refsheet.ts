// The case reference sheet every case table opens in (the last-layer drills'
// OCLL and PLL, the F2L finder's slots): one sheet element (#ref-sheet in
// index.html), one style, one set of card parts - the alg with its triggers
// labelled, the star that makes an alg the case's main, your note on each
// alg, the folded other algs, the 3D player - and one wiring: the name box,
// the filter chips, the remembered folds, the store's favourites and notes
// coming in from another device. A table gives the sheet its title, how to
// draw the cards, and what a card's buttons do; nothing here knows the cases.

import { nxnAnimatable } from '../algs/nxn3d';
import { mountPlayer } from '../algs/player';
import { tokens } from '../cube/alg';
import { onSchemeChange } from '../cube/scheme';
import { onFavsChange, setFavourite } from '../ll/favs';
import { noteFor, onNotesChange, setNote } from '../ll/notes';
import { closeSheet, openSheet } from '../shell';
import type { AlgKind } from '../store/types';
import { ensureStyle, esc } from './dom';
import { triggers } from './fingertricks';
import { readStored, writeStored } from './settings';

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
  .llr-feats { flex-basis: 100%; font-size: 13px; color: var(--ink-2); }
  .llr-feats summary { cursor: pointer; }
  .llr-chips { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin-top: 8px; }
  .llr-search { font: inherit; font-size: 14px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink); width: 11em; }
  .llr-search:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .llr-count { font-size: 13px; color: var(--ink-2); margin: -6px 0 12px; }
  .llr-chains { font-size: 13px; color: var(--ink-2); margin: 0 0 12px; }
  .llr-chains b { color: var(--ink); font-weight: 600; }
  .llr-group { font-size: 16px; font-weight: 600; margin: 18px 0 8px; }
  .llr-group:first-child { margin-top: 0; }
  .llr-group small { font-weight: 400; color: var(--ink-2); font-size: 13px; margin-left: 8px; }
  .llr-sub { font-size: 13px; color: var(--ink-2); margin: 10px 0 6px; }
  .llr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; align-items: start; }
  .llr-case { display: block; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); text-align: left; font: inherit; color: inherit; }
  .llr-drill { font: inherit; font-size: 13px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--ink); cursor: pointer; }
  .llr-drill:hover { border-color: var(--ink); }
  .llr-head { display: flex; align-items: center; gap: 10px; }
  .llr-head .ll-pic { width: 64px; flex: none; }
  .llr-head .llr-3d { width: 84px; height: 84px; flex: none; }
  .llr-head .llr-3d svg { width: 100%; height: 100%; display: block; }
  .llr-head .llr-3d polygon { stroke: #2b3340; stroke-width: 1.2; stroke-linejoin: round; }
  .llr-head .llr-3d polygon.solved { fill-opacity: .85; }
  .llr-head .llr-3d polygon.pair { stroke: var(--ink); stroke-width: 3; }
  .llr-play { font: inherit; font-size: 12px; padding: 0; border: 0; background: none; color: var(--ink-2); text-decoration: underline; cursor: pointer; justify-self: start; }
  .llr-play.on { color: var(--ink); font-weight: 600; }
  .llr-player { grid-column: 1 / -1; cursor: auto; }
  .llr-player:empty { display: none; }
  .llr-case .ll-pic { max-width: none; margin: 0; }
  .llr-name { font-weight: 600; font-size: 17px; }
  .llr-name small { font-weight: 400; font-size: 13px; color: var(--ink-2); margin-left: 6px; }
  .llr-alg { font-size: 17px; word-spacing: .35em; line-height: 1.9; margin: 8px 0 2px; }
  .llr-alg .ll-trig { padding-bottom: 13px; }
  .llr-alg .llr-auf { color: var(--ink-2); font-weight: 400; }
  .llr-more { margin: 6px 0 0; font-size: 13px; color: var(--ink-2); }
  .llr-more summary { cursor: pointer; }
  .llr-alt { margin: 6px 0 0; }
  .llr-alt .llr-alg { font-size: 15px; line-height: 1.8; margin: 0; }
  .llr-alt small { display: block; font-size: 12px; color: var(--ink-2); margin-top: 1px; }
  .llr-fav { font: inherit; font-size: 15px; line-height: 1; padding: 2px 5px; border: 0; background: none; color: var(--ink-2); cursor: pointer; vertical-align: middle; word-spacing: normal; }
  .llr-fav.on { color: #C8930A; }
  .llr-fav:hover { color: var(--ink); }
  .llr-hint { font-size: 13px; color: var(--ink-2); margin-top: 4px; }
  .llr-note { font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); line-height: 1.4; resize: vertical; }
  .llr-note::placeholder { color: var(--ink-2); }
  .llr-note:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .llr-note.has { background: #FFFDF2; border-color: #E4D9A8; }
  .llr-chain { font-size: 12px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  .llr-foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-top: 8px; }
  .llr-foot .llr-tags { flex: 1 1 100%; }
  .llr-hint b, .llr-chain b { color: var(--ink); font-weight: 600; }
`;

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

/** The star on an alg: on the main it puts the standard back, on another alg it makes that one the main. */
export function starHtml(alg: string, on: boolean): string {
  return `<button type="button" class="llr-fav${on ? ' on' : ''}" data-fav="${esc(alg)}" title="${on ? 'This is the alg the drill uses (tap for the standard one)' : 'Make this the alg the drill uses'}">${on ? '★' : '☆'}</button>`;
}

/**
 * Your own note on an alg: what tells it from its twin, how you hold it. One per alg, so an
 * alternative keeps its own (user, 2026-09-23). The card's `data-id` and the sheet's kind say whose.
 */
export function noteHtml(kind: AlgKind, caseId: string, alg: string, what: string): string {
  const t = noteFor(kind, caseId, alg);
  return `<textarea class="llr-note${t ? ' has' : ''}" rows="${t ? Math.min(4, Math.ceil(t.length / 46) + (t.match(/\n/g)?.length ?? 0)) : 1}" data-note="${esc(alg)}" placeholder="Your note on ${esc(what)}…">${esc(t)}</textarea>`;
}

/** A case's other algs, folded: each with its star, its note (`what` names the case) and a line on it. */
export function altsHtml(kind: AlgKind, caseId: string, alts: readonly { alg: string; note: string }[], what: string, show: (alg: string) => string = algHtml): string {
  if (!alts.length) return '';
  return `<details class="llr-more"><summary>${alts.length} other alg${alts.length === 1 ? '' : 's'}</summary>${alts.map((a) => `<div class="llr-alt"><span class="llr-alg">${show(a.alg)}</span>${starHtml(a.alg, false)}<small>${esc(a.note)}</small>${noteHtml(kind, caseId, a.alg, what)}</div>`).join('')}</details>`;
}

/** The name box: typed into, the list follows (the sheet keeps the caret through the redraw). */
export function nameBoxHtml(value: string, placeholder: string): string {
  return `<span class="lbl">Name</span><input class="llr-search" id="llr-name" type="search" placeholder="${esc(placeholder)}" value="${esc(value).replace(/"/g, '&quot;')}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
}

/** A filter chip with its count. */
export function chipHtml(key: string, label: string, on: boolean, count: number): string {
  return `<button type="button" class="eo-chip${on ? ' on' : ''}" data-filter="${esc(key)}">${esc(label)}<small>${count}</small></button>`;
}

export interface RefSheetSpec {
  kind: AlgKind;
  title: string;
  sub: string;
  /** the sheet's body: the filters and the cards (a card is `.llr-case[data-id]`) */
  render(): string;
  /** the cards are in the page: draw what markup alone cannot (3D pictures) */
  mounted?(panel: HTMLElement): void;
  /** a `[data-filter]` chip was tapped */
  onFilter?(key: string): void;
  /** the name box changed */
  onName?(value: string): void;
  /** a card's `[data-go]` button: the case goes to the trainer (the sheet closes first) */
  onGo?(id: string): void;
  /** the alg and the state it starts from, for a card's `[data-play]` button */
  playFor?(id: string): { alg: string; setup: string } | null;
  /** a favourite changed (starred here, or synced in): the trainer's case may show the old alg */
  onFavChange?(): void;
}

interface Open { spec: RefSheetSpec; draw(): void; closePlayer(): void; player: { destroy(): void; button: HTMLElement } | null }
let current: Open | null = null;
let hooked = false;
const visible = () => !document.getElementById('ref-sheet')!.hidden;

/** Open the sheet on `spec`. Returns `draw`, to redraw it from outside. */
export function openRefSheet(spec: RefSheetSpec): () => void {
  ensureStyle('llr-style', STYLE);
  const panel = document.getElementById('ref-panel');
  const head = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head b');
  const sub = document.querySelector<HTMLElement>('#ref-sheet .zz-sheet-head .sub');
  if (!panel || !head || !sub) throw new Error('index.html is missing the reference sheet');
  head.textContent = spec.title;
  sub.textContent = spec.sub;
  // the 3D player: one open at a time, in the case's card; a redraw drops it
  current?.closePlayer();
  const open: Open = {
    spec, player: null,
    closePlayer() { open.player?.destroy(); open.player?.button.classList.remove('on'); open.player = null; },
    draw() { open.closePlayer(); panel.innerHTML = spec.render(); spec.mounted?.(panel); },
  };
  current = open;
  open.draw();
  if (!hooked) {
    hooked = true;
  // a fold (the chips, a section) open or closed: remembered by its id (toggle does not bubble, so it is caught on the way down)
  panel.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement;
    if (!d.id || !d.classList.contains('llr-fold')) return;
    writeStored(`zz-ref-fold:${d.id}`, d.open ? '1' : '0');
  }, true);
  // a note: kept when the field is left (or the sheet closed), and the card is not redrawn under the caret
  panel.addEventListener('focusout', (e) => {
    const box = e.target as HTMLTextAreaElement;
    const alg = box.dataset?.note;
    if (alg === undefined) return;
    const id = box.closest<HTMLElement>('.llr-case')!.dataset.id!;
    setNote(current!.spec.kind, id, alg, box.value);
    box.classList.toggle('has', !!box.value.trim());
  });
  // the name box: typed into, the list follows; the redraw replaces the box, so the caret goes back where it was
  panel.addEventListener('input', (e) => {
    const box = e.target as HTMLInputElement;
    if (box.id !== 'llr-name') return;
    const at = box.selectionStart ?? box.value.length;
    current!.spec.onName?.(box.value);
    current!.draw();
    const again = panel.querySelector<HTMLInputElement>('#llr-name');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  });
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>('[data-filter]');
    if (chip) { current!.spec.onFilter?.(chip.dataset.filter!); current!.draw(); return; }
    const play = t.closest<HTMLElement>('[data-play]');
    if (play) {
      const wasOpen = current!.player?.button === play;
      current!.closePlayer();
      const p = current!.spec.playFor?.(play.dataset.play!);
      if (wasOpen || !p) return;
      const host = play.closest('.llr-case')!.querySelector<HTMLElement>('.llr-player')!;
      const handle = mountPlayer(host, nxnAnimatable(3, p.alg, p.setup));
      current!.player = { destroy: () => handle.destroy(), button: play };
      play.classList.add('on');
      return;
    }
    const fav = t.closest<HTMLElement>('[data-fav]');
    if (fav) {
      const id = fav.closest<HTMLElement>('.llr-case')!.dataset.id!;
      // the star on the main puts the standard alg back; on another alg it makes that one the main
      if (setFavourite(current!.spec.kind, id, fav.classList.contains('on') ? null : fav.dataset.fav!)) { current!.draw(); current!.spec.onFavChange?.(); }
      return;
    }
    // the case to the trainer: everything else in the card (a star, the other-algs fold, the player) is its own control
    const go = t.closest<HTMLElement>('[data-go]');
    if (!go) return;
    closeSheet('ref-sheet');
    current!.spec.onGo?.(go.dataset.go!);
  });
    onSchemeChange(() => { if (visible()) current?.draw(); });
    // a favourite from another device while the sheet is up: redrawn (the case list is whatever the table says)
    onFavsChange(() => { if (visible()) { current?.draw(); current?.spec.onFavChange?.(); } });
    // a note from another device: redrawn, unless one is being written here (the caret would jump)
    onNotesChange(() => { if (visible() && !document.activeElement?.classList.contains('llr-note')) current?.draw(); });
  }
  openSheet('ref-sheet');
  // the name box ready to type into (a phone keyboard would cover the list, so only where there is a mouse)
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) panel.querySelector<HTMLInputElement>('#llr-name')?.focus();
  return open.draw;
}

/** Whether a remembered fold is open (`fallback` before it was ever toggled). */
export function foldOpen(id: string, fallback = false): boolean {
  const v = readStored(`zz-ref-fold:${id}`);
  return v === '' || v === null ? fallback : v === '1';
}

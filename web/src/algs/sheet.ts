// The algs sheet: the other puzzles' cheat sheet (2x2, 4x4, 5x5,
// Pyraminx, Skewb, FTO) in index.html's #algs-sheet. A puzzle picker,
// the puzzle's notation and intro, then its sections of cases: for the
// cubes a picture of the case (the alg's inverse on the n×n model, in the
// user's colour scheme; the FTO from its front corner), the alg, what it does, and a link that plays it
// in a 3D viewer - the FTO plays here, in the card (fto3d.ts), with twizzle as a second link. Content is
// data.ts; nothing here decides what an alg is.

import { applyFto, ftoTokens, invertFto, twizzleFto } from '../cube/fto';
import { applyNxN, expandNxN, invertTokens, rawNxN } from '../cube/nxn';
import { onSchemeChange } from '../cube/scheme';
import { algsHooks } from '../shell';
import { PUZZLES } from './data';
import { ftoAnimatable } from './fto3d';
import { nxnAnimatable } from './nxn3d';
import { picFto, picIso, picTop } from './pic';
import { mountPlayer } from './player';
import type { AlgCase, Puzzle, PuzzleId } from './types';

const KEY = 'zz-algs';

const STYLE = `
  .algs-pick { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 14px; }
  .algs-pick button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; }
  .algs-pick button.on { color: var(--bg); background: var(--ink); border-color: var(--ink); font-weight: 600; }
  .algs-intro { font-size: 14px; color: var(--ink-2); margin: 0 0 6px; line-height: 1.45; max-width: 760px; }
  .algs-intro b { color: var(--ink); font-weight: 600; }
  .algs-notation { font-size: 13px; color: var(--ink-2); margin: 0 0 16px; line-height: 1.5; max-width: 760px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .algs-notation code { font: inherit; color: var(--ink); font-weight: 600; }
  .algs-sec h3 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); margin: 18px 2px 4px; }
  .algs-sec h3 small { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 8px; }
  details.algs-sec summary { cursor: pointer; list-style: none; }
  details.algs-sec summary::-webkit-details-marker { display: none; }
  details.algs-sec summary h3 { display: inline-block; }
  details.algs-sec summary h3::before { content: '▸ '; }
  details.algs-sec[open] summary h3::before { content: '▾ '; }
  .algs-sec .blurb { font-size: 14px; color: var(--ink-2); margin: 0 0 10px; line-height: 1.45; max-width: 760px; }
  .algs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .algs-case { display: grid; grid-template-columns: 1fr; gap: 3px 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  .algs-case.pic { grid-template-columns: 92px 1fr; }
  .algs-case .algs-pic { grid-row: span 6; }
  .algs-case .algs-pic svg { display: block; width: 100%; height: auto; }
  .algs-case .algs-pic rect { stroke: #2b3340; stroke-width: 1.2; }
  .algs-name { font-weight: 600; font-size: 16px; }
  .algs-name small { font-weight: 400; color: var(--ink-2); margin-left: 6px; }
  .algs-alg { font-size: 16px; word-spacing: .2em; line-height: 1.45; color: var(--ink); font-variant-numeric: tabular-nums; }
  .algs-alt { font-size: 13px; color: var(--ink-2); word-spacing: .15em; line-height: 1.45; }
  .algs-alt b { color: var(--ink); font-weight: 600; }
  .algs-note { font-size: 13px; color: var(--ink-2); line-height: 1.4; }
  .algs-links { font-size: 12px; margin-top: 2px; }
  .algs-links a { color: var(--ink-2); }
  .algs-links a + a { margin-left: 10px; }
  .algs-links button { font: inherit; font-size: 12px; padding: 0; border: 0; background: none; color: var(--ink-2); text-decoration: underline; cursor: pointer; margin-right: 10px; }
  .algs-links button.on { color: var(--ink); font-weight: 600; }
  .algs-player { grid-column: 1 / -1; }
  .algs-player:empty { display: none; }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// alg.cubing.net and twizzle take an alg in the URL with spaces as _ and primes as - (their own URL form; commas and brackets are fine as they are)
const urlAlg = (alg: string) => alg.trim().replace(/\s+/g, '_').replace(/'/g, '-');

/**
 * The alg's inverse: the setup that puts the case on a solved puzzle. The cube rule (a half turn is its own
 * inverse) serves the pyraminx and skewb too; the FTO's `X2` is `X'`, so it has its own.
 */
export function setupAlg(p: Puzzle, alg: string): string {
  return p.id === 'fto' ? invertFto(ftoTokens(alg)).join(' ') : invertTokens(expandNxN(alg)).join(' ');
}

/**
 * The 3D viewer link for a case: alg.cubing.net for the cubes, pyraminx and skewb; twizzle for the FTO, which
 * gets the alg in Ben's letters with the rotations pushed through (twizzle reads neither lowcubes' letters nor
 * `Rw` / `Uo`). Both show the case, then play the alg.
 */
export function viewerUrl(p: Puzzle, c: AlgCase): string | null {
  if (!p.viewer) return null;
  if (p.id !== 'fto') return `https://alg.cubing.net/?puzzle=${p.viewer}&alg=${urlAlg(c.alg)}&setup=${urlAlg(setupAlg(p, c.alg))}`;
  const alg = twizzleFto(c.alg, c.frame ?? 'ben');
  return `https://alpha.twizzle.net/edit/?puzzle=${p.viewer}&alg=${urlAlg(alg)}&setup-alg=${urlAlg(setupAlg(p, alg))}`;
}

/** The picture of a case: the alg's inverse on a solved puzzle (an n×n turned by the case's setup rotation for the view; the FTO from its front corner); null when there is none. */
export function caseSvg(p: Puzzle, c: AlgCase): string | null {
  if (c.pic === 'none') return null;
  let inner: string;
  if (p.id === 'fto') inner = picFto(applyFto(setupAlg(p, c.alg), undefined, c.frame ?? 'ben'));
  else if (p.n) {
    const state = rawNxN(p.n, c.setup ?? '', applyNxN(p.n, setupAlg(p, c.alg)));
    inner = c.pic === 'iso' ? picIso(p.n, state) : picTop(p.n, state, c.pic === 'top2' ? 2 : 1);
  } else return null;
  return `<svg viewBox="0 0 200 200" aria-label="${esc(c.name)}">${inner}</svg>`;
}

/** How many moves an alg is, counting a wide or slice move as one and a whole-puzzle rotation as none. */
export function algLength(p: Puzzle, alg: string): number {
  if (p.n) return expandNxN(alg).length;
  if (p.id === 'fto') return ftoTokens(alg).filter((t) => !/^(?:[A-Za-z]+o|[RLF]t)(?:2'|2|')?$/.test(t)).length;
  return alg.replace(/[()[\]:,]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function caseHtml(p: Puzzle, c: AlgCase, idx: number): string {
  const svg = caseSvg(p, c);
  const link = viewerUrl(p, c);
  const playable = p.id === 'fto' || !!p.n;
  return `<div class="algs-case${svg ? ' pic' : ''}">
    ${svg ? `<div class="algs-pic">${svg}</div>` : ''}
    <div class="algs-name">${esc(c.name)}<small>${algLength(p, c.alg)} moves</small></div>
    <div class="algs-alg">${esc(c.alg)}</div>
    ${c.alt?.length ? `<div class="algs-alt">${c.alt.map((a) => `<b>or</b> ${esc(a)}`).join('<br>')}</div>` : ''}
    ${c.note ? `<div class="algs-note">${esc(c.note)}</div>` : ''}
    <div class="algs-links">${playable ? `<button type="button" data-play="${idx}">▶ play it here</button>` : ''}${link ? `<a href="${link}" target="_blank" rel="noopener">${p.id === 'fto' ? 'twizzle' : '▶ play it in 3D'}</a>` : ''}${c.source ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}</div>
    ${playable ? '<div class="algs-player"></div>' : ''}
  </div>`;
}

const allCases = (p: Puzzle): AlgCase[] => p.sections.flatMap((s) => s.cases);

function puzzleHtml(p: Puzzle): string {
  return `
    ${p.intro ? `<p class="algs-intro">${p.intro}</p>` : ''}
    <div class="algs-notation">${p.notation}</div>
    ${p.sections.map((s) => {
      const body = `${s.blurb ? `<p class="blurb">${s.blurb}</p>` : ''}<div class="algs-grid">${s.cases.map((c) => caseHtml(p, c, allCases(p).indexOf(c))).join('')}</div>`;
      return s.folded
        ? `<details class="algs-sec"><summary><h3>${esc(s.title)}<small>${s.cases.length} cases</small></h3></summary>${body}</details>`
        : `<section class="algs-sec"><h3>${esc(s.title)}</h3>${body}</section>`;
    }).join('')}`;
}

/** Mount the sheet: the picker, the remembered puzzle, redraws on scheme changes. Called once from main.ts. */
export function initAlgs(): void {
  const panel = document.getElementById('algs-panel');
  if (!panel) throw new Error('index.html is missing the algs sheet');
  const s = document.createElement('style'); s.id = 'algs-style'; s.textContent = STYLE; document.head.appendChild(s);
  let chosen: PuzzleId = PUZZLES[0]!.id;
  try { const v = localStorage.getItem(KEY); if (PUZZLES.some((p) => p.id === v)) chosen = v as PuzzleId; } catch { /* no storage */ }
  let drawn = false;
  // the 3D player: one open at a time, inside the case's card; a redraw of the sheet drops it
  let player: { destroy(): void; button: HTMLElement } | null = null;
  const closePlayer = () => { player?.destroy(); player?.button.classList.remove('on'); player = null; };
  const render = () => {
    closePlayer();
    const p = PUZZLES.find((x) => x.id === chosen) ?? PUZZLES[0]!;
    panel.innerHTML = `<div class="algs-pick">${PUZZLES.map((x) => `<button type="button" data-p="${x.id}" class="${x.id === chosen ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div><div class="algs-body">${puzzleHtml(p)}</div>`;
    drawn = true;
  };
  panel.addEventListener('click', (e) => {
    const play = (e.target as HTMLElement).closest<HTMLElement>('[data-play]');
    if (play) {
      const wasOpen = player?.button === play;
      closePlayer();
      if (wasOpen) return;
      const p = PUZZLES.find((x) => x.id === chosen)!;
      const c = allCases(p)[Number(play.dataset.play)]!;
      const host = play.closest('.algs-case')!.querySelector<HTMLElement>('.algs-player')!;
      const handle = p.id === 'fto'
        ? mountPlayer(host, ftoAnimatable(c.alg, c.frame ?? 'ben', applyFto(setupAlg(p, c.alg), undefined, c.frame ?? 'ben')))
        : mountPlayer(host, nxnAnimatable(p.n!, c.alg, rawNxN(p.n!, c.setup ?? '', applyNxN(p.n!, setupAlg(p, c.alg)))));
      player = { destroy: () => handle.destroy(), button: play };
      play.classList.add('on');
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
    if (!b) return;
    chosen = b.dataset.p as PuzzleId;
    try { localStorage.setItem(KEY, chosen); } catch { /* no storage */ }
    render();
    panel.closest('.zz-sheet')?.scrollTo({ top: 0 });
  });
  algsHooks.onOpen = () => { if (!drawn) render(); };
  onSchemeChange(() => { if (drawn) render(); });
  // ?tab=algs opened the sheet from initShell, before this hook existed
  if (!panel.closest<HTMLElement>('.zz-sheet')?.hidden) render();
}

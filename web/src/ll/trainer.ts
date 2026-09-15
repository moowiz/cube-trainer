// The last-layer drill, mounted twice: once as the OCLL tab, once as PLL.
// Same shape as the EO trainer: a case (random, or a cube handed over by a
// scan or the previous stage), a picture, a timer, the moves you did,
// Check, hints that reveal the case, and the standard alg with its AUF.
// The picture is the usual top-down last-layer diagram: the top face with
// the twelve side stickers around it, drawn in the trainer's colour scheme.

import { type LLCase, type LLKind } from './cases';
import { aufToSolve, done, moveCount, randomSetup, solution, state, tokens, whiteDown } from './model';
import { stageOf } from '../stage';

/** What the page provides: colours for face letters, tab switching, and the next stage's loader. */
export interface LLBus {
  faceHex?(face: string): string;
  faceColorName?(face: 'F' | 'R' | 'B' | 'L'): string;
  showTab(t: string): void;
  sheetOpen(): boolean;
  toast(msg: string): void;
  pll?: { load(scramble: string): void };
}

export interface LLTrainer {
  /** Show the cube reached by `scramble` from solved (white down, the chosen colour in front). */
  load(scramble: string): void;
  render(): void;
  /** The alg from solved that reaches the case shown (empty when none). */
  setup(): string;
}

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };
const BLURB: Record<LLKind, string> = {
  ocll: 'Orient the last layer’s corners. After EO the edges are already oriented, so there are 7 cases.',
  pll: 'Permute the last layer: 21 cases. Finish with the AUF so the cube is solved.',
};
const DEFAULT_HEX: Record<string, string> = { U: '#F5D63D', D: '#FBFBF9', F: '#2E6CE0', B: '#33B15D', R: '#E2433C', L: '#F58F2A' };

// top-view layout: the U face reads U1..U9 back-left to front-right; the side strips read left to right
// (back: B3 B2 B1, front: F1 F2 F3) or back to front (left: L1 L2 L3, right: R3 R2 R1) in Kociemba indices
const SIDES = { back: [47, 46, 45], front: [18, 19, 20], left: [36, 37, 38], right: [11, 10, 9] };

const STYLE = `
  .ll-panel { max-width: 560px; margin: 0 auto; }
  @media (min-width: 820px) {
    .ll-panel { max-width: 900px; display: grid; grid-template-columns: 360px 1fr; gap: 0 32px; align-items: start; }
    .ll-panel .eo-head { grid-column: 1 / -1; }
    .ll-panel .ll-left { position: sticky; top: 16px; }
  }
  .ll-pic { max-width: 300px; margin: 0 auto; }
  .ll-pic svg { display: block; width: 100%; height: auto; }
  .ll-pic rect { stroke: #2b3340; stroke-width: 1.2; }
  .ll-case { font-size: 16px; min-height: 22px; }
  .ll-case b { font-weight: 600; }
  .ll-moves { width: 100%; font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); resize: vertical; letter-spacing: .02em; }
  .ll-moves:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .ll-alg { font-size: 16px; word-spacing: .3em; margin: 6px 0; }
  .ll-alg small { font-size: 13px; color: var(--ink-2); word-spacing: normal; }
`;

export function mountLL(root: HTMLElement, kind: LLKind, bus: LLBus): LLTrainer {
  if (!document.getElementById('ll-style')) {
    const s = document.createElement('style'); s.id = 'll-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  const id = (n: string) => `${kind}-${n}`;
  root.innerHTML = `
    <div class="ll-panel">
      <div class="eo-head">
        <div><h1>${TITLE[kind]}</h1><p>${BLURB[kind]}</p></div>
        <button id="${id('next')}" class="btn eo-primary" type="button">New case</button>
      </div>
      <div class="ll-left">
        <div class="ll-pic"><svg id="${id('pic')}" viewBox="0 0 200 200" aria-label="last layer"></svg></div>
        <div class="eo-status">
          <div class="ll-case" id="${id('case')}"></div>
          <div class="eo-timer" id="${id('timer')}">0.00</div>
        </div>
        <div class="eo-scramble" id="${id('setup')}"></div>
        <p class="eo-note" id="${id('orient')}"></p>
      </div>
      <div class="ll-right">
        <div class="eo-hints" id="${id('hints')}">
          <button type="button" class="eo-chip" data-hint="name">Hint: case name</button>
          <button type="button" class="eo-chip" data-hint="look">Hint: what to look for</button>
        </div>
        <div class="eo-row">
          <button id="${id('timerBtn')}" class="btn eo-primary" type="button" style="flex:1">Start timer</button>
          <button id="${id('timerReset')}" class="btn" type="button" title="Reset timer (Esc)">Reset</button>
        </div>
        <p class="eo-note">Solve it on your cube. Space starts and stops the timer, N is a new case.</p>
        <label class="eo-lbl" for="${id('sol')}">Moves you did</label>
        <textarea id="${id('sol')}" class="ll-moves" rows="2" placeholder="${kind === 'pll' ? "e.g. U R U R' U' R' F R2 U' R' U' R U R' F' U2" : "e.g. U2 R U R' U R U2 R'"}" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
        <div class="eo-row">
          <button id="${id('check')}" class="btn eo-primary" type="button">Check</button>
          <button id="${id('clear')}" class="btn" type="button">Clear</button>
        </div>
        <div class="eo-flash" id="${id('flash')}"></div>
        <div class="eo-result" id="${id('result')}">
          <h2 id="${id('rTitle')}"></h2>
          <p id="${id('rSub')}"></p>
          <div id="${id('rAlg')}"></div>
          <div id="${id('handoff')}"></div>
        </div>
        <div style="padding:8px 2px 0"><button class="eo-link" id="${id('showAlg')}" type="button">Show the alg</button></div>
        <div class="eo-stats" id="${id('stats')}"></div>
      </div>
    </div>`;
  const $ = (n: string) => document.getElementById(id(n))!;
  const HINT_LABEL: Record<string, string> = { name: 'Hint: case name', look: 'Hint: what to look for' };

  // state: the drill is an alg from solved; the check is that alg plus the moves typed
  let setup = '';
  let sol: ReturnType<typeof solution> = null;
  let shown: string | null = null; // the alg whose state the picture shows (setup + moves after a Check)
  let startAt: number | null = null, endAt: number | null = null;
  let assisted = false, recorded = false;
  const results: { t: number; n: number; std: number }[] = [];

  const hex = (letter: string) => bus.faceHex?.(letter) || DEFAULT_HEX[letter];
  const fc = (f: 'F' | 'R' | 'B' | 'L') => bus.faceColorName?.(f) ?? { F: 'blue', R: 'red', B: 'green', L: 'orange' }[f];
  const flash = (m: string) => { $('flash').textContent = m; };
  const active = () => !root.hidden && !bus.sheetOpen();
  const running = () => startAt !== null && endAt === null;
  const elapsed = () => (startAt === null ? null : ((endAt ?? performance.now()) - startAt) / 1000);

  function drawPic(): void {
    const f = state(shown ?? setup);
    let out = '';
    const cell = (x: number, y: number, w: number, h: number, letter: string) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${hex(letter)}"/>`;
    for (let i = 0; i < 9; i++) out += cell(41 + (i % 3) * 40, 41 + Math.floor(i / 3) * 40, 38, 38, f[i]);
    SIDES.back.forEach((k, i) => { out += cell(41 + i * 40, 24, 38, 13, f[k]); });
    SIDES.front.forEach((k, i) => { out += cell(41 + i * 40, 163, 38, 13, f[k]); });
    SIDES.left.forEach((k, i) => { out += cell(24, 41 + i * 40, 13, 38, f[k]); });
    SIDES.right.forEach((k, i) => { out += cell(163, 41 + i * 40, 13, 38, f[k]); });
    $('pic').innerHTML = out;
  }

  function caseText(): string {
    if (!sol) {
      const r = stageOf(state(setup));
      if (r.stage === 'solved') return kind === 'pll' ? 'Solved already: a PLL skip.' : 'Solved already.';
      if (kind === 'ocll' && r.stage === 'pll') return 'Corners already oriented: an OCLL skip.';
      return `Not ${kind === 'ocll' ? 'an' : 'a'} ${TITLE[kind]} case: this cube is at ${r.stage === 'eo' ? 'EO' : r.stage === 'f2l' ? 'F2L' : r.stage.toUpperCase()}.`;
    }
    return `<b>${sol.case.name}</b>`;
  }

  function render(): void {
    drawPic();
    const open = $('hints').querySelector('.eo-chip[data-hint="name"].open');
    $('case').innerHTML = open || $('result').classList.contains('show') && recorded ? caseText() : '';
    $('setup').innerHTML = setup ? 'Setup: <span></span>' : '';
    if (setup) $('setup').querySelector('span')!.textContent = setup;
    $('orient').textContent = `Hold the cube white down with ${fc('F')} facing you (${fc('R')} on the right). Apply the setup to a solved cube, or just make the top layer match the picture.`;
    const st = $('stats');
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, ms = results.reduce((a, r) => a + r.std, 0) / results.length;
      st.textContent = `This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (standard algs mean ${ms.toFixed(1)}).`;
    } else st.textContent = '';
  }

  function resetHints(): void {
    root.querySelectorAll<HTMLButtonElement>('.eo-chip').forEach((b) => { b.textContent = HINT_LABEL[b.dataset.hint!]; b.classList.remove('open'); });
  }

  function start(alg: string): void {
    setup = alg.trim();
    sol = solution(kind, setup);
    shown = null; startAt = null; endAt = null; assisted = false; recorded = false;
    ($('sol') as HTMLTextAreaElement).value = '';
    $('result').classList.remove('show'); $('handoff').innerHTML = ''; $('rAlg').innerHTML = '';
    $('timerBtn').textContent = 'Start timer';
    resetHints(); flash('');
    render();
    if (!sol) $('case').innerHTML = caseText();
  }

  function newCase(): void { start(randomSetup(kind).setup); }

  function toggleTimer(): void {
    if (running()) { endAt = performance.now(); $('timerBtn').textContent = 'Start timer'; $('sol').focus(); }
    else { startAt = performance.now(); endAt = null; $('timerBtn').textContent = 'Stop'; }
  }
  function resetTimer(): void { startAt = null; endAt = null; $('timerBtn').textContent = 'Start timer'; }
  function tick(): void { const t = elapsed(); $('timer').textContent = t === null ? '0.00' : t.toFixed(2); requestAnimationFrame(tick); }

  /** The standard solution as a line: AUF, alg, AUF. */
  function algLine(): string {
    if (!sol) return '';
    return [sol.pre, sol.case.alg, sol.post].filter(Boolean).join(' ');
  }

  function check(): void {
    const txt = ($('sol') as HTMLTextAreaElement).value.trim();
    if (!txt) { flash('Type the moves you did first.'); return; }
    let toks: string[];
    try { toks = tokens(txt); } catch (err) { flash(err instanceof Error ? err.message : String(err)); return; }
    const alg = `${setup} ${toks.join(' ')}`;
    if (!whiteDown(alg)) { flash('Keep white underneath (no x or z rotations): the check reads the cube white down.'); return; }
    flash('');
    if (running()) toggleTimer();
    shown = alg;
    const n = moveCount(txt), t = elapsed(), ts = t === null ? '' : `, ${t.toFixed(2)}s`;
    const r = $('result'); $('handoff').innerHTML = ''; $('rAlg').innerHTML = '';
    let ok = done(kind, alg), note = '';
    if (kind === 'pll' && !ok) {
      const auf = aufToSolve(alg);
      if (auf) { ok = true; note = ` Solved up to the AUF: add ${auf}.`; }
    }
    if (!ok) {
      const rep = stageOf(state(alg));
      $('rTitle').textContent = `${TITLE[kind]} not done yet`;
      $('rSub').textContent = rep.pairs < 4 ? `F2L is broken (${rep.pairs}/4 pairs).` : rep.eoBad ? `${rep.eoBad} edge${rep.eoBad === 1 ? ' is' : 's are'} flipped.` : !rep.ocll ? 'Some corners are still not oriented.' : 'The last layer is not permuted yet.';
      r.classList.add('show'); render(); return;
    }
    if (!recorded) { recorded = true; results.push({ t: t ?? 0, n, std: sol ? moveCount(algLine()) : n }); }
    $('rTitle').textContent = `${TITLE[kind]} done in ${n} moves${ts}`;
    $('rSub').textContent = (sol ? `Case: ${sol.case.name}. The standard alg is ${moveCount(algLine())} moves.` : '') + note + (assisted ? ' You peeked at the alg.' : '');
    if (sol) $('rAlg').innerHTML = `<div class="ll-alg">${algLine()}</div>`;
    if (kind === 'ocll' && bus.pll) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn eo-primary'; btn.style.marginTop = '8px';
      btn.textContent = 'Continue to PLL with this cube';
      btn.addEventListener('click', () => { bus.pll!.load(alg); bus.showTab('pll'); window.scrollTo({ top: 0 }); });
      $('handoff').appendChild(btn);
    }
    r.classList.add('show'); render();
  }

  // wiring
  $('next').onclick = newCase;
  $('timerBtn').onclick = toggleTimer;
  $('timerReset').onclick = resetTimer;
  $('check').onclick = check;
  $('clear').onclick = () => { ($('sol') as HTMLTextAreaElement).value = ''; shown = null; $('result').classList.remove('show'); flash(''); render(); };
  $('hints').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.eo-chip'); if (!b || b.classList.contains('open')) return;
    b.classList.add('open');
    const plain = caseText().replace(/<[^>]+>/g, '');
    if (b.dataset.hint === 'name') { b.textContent = sol ? sol.case.name : plain; render(); }
    else b.textContent = sol ? sol.case.hint : plain;
  });
  $('showAlg').onclick = () => {
    const r = $('result');
    if (r.classList.contains('show') && $('showAlg').dataset.open) { r.classList.remove('show'); delete $('showAlg').dataset.open; $('showAlg').textContent = 'Show the alg'; return; }
    assisted = true; $('showAlg').dataset.open = '1'; $('showAlg').textContent = 'Hide the alg';
    $('handoff').innerHTML = '';
    if (!sol) { $('rTitle').textContent = 'No tabled alg'; $('rSub').textContent = caseText().replace(/<[^>]+>/g, ''); $('rAlg').innerHTML = ''; }
    else {
      $('rTitle').textContent = `${sol.case.name}: ${moveCount(algLine())} moves`;
      $('rSub').textContent = sol.case.hint;
      $('rAlg').innerHTML = `<div class="ll-alg">${algLine()}${sol.pre || sol.post ? ' <small>(with the AUF for this angle)</small>' : ''}</div>`;
    }
    r.classList.add('show');
  };
  document.addEventListener('keydown', (ev) => {
    if (!active()) return;
    const tag = (ev.target as HTMLElement).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { if (ev.target === $('sol') && ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); check(); } return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === ' ') { ev.preventDefault(); toggleTimer(); return; }
    if (ev.key === 'Escape') { resetTimer(); return; }
    if (ev.key.toLowerCase() === 'n') newCase();
  });

  newCase(); tick();
  return { load: start, render, setup: () => setup };
}

export type { LLCase };

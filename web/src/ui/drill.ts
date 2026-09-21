// The drill scaffold every timed stage (EO, OCLL, PLL) is built on: a
// header with the New button, a picture column and a work column, the
// timer, the hint chips, the moves box with Check/Clear, the result panel,
// the reveal link under it, session stats, the keyboard shortcuts, and
// tap-to-fill on anything carrying data-alg. A stage fills the left column,
// answers the callbacks, and never touches timer or box mechanics.

import { moveCount, tokens } from '../cube/alg';
import { toWca, WCA_HOLD } from '../cube/frame';
import { STICKERS } from '../cube/geometry';
import { DEFAULT_VIEW, render3d, type Cell } from '../cube/render';
import { faceHex } from '../cube/scheme';
import { state } from '../cube/state';
import { activeTab, sheetOpen, stages, trainerHold } from '../shell';
import { newId, type AttemptRecord, type AttemptStage } from '../store/types';
import { moveWhat, openFingertricks } from './fingertricks';

// where finished attempts go (the solve store); nothing is kept when no sink is set (tests)
let attemptSink: ((a: AttemptRecord) => void) | null = null;
export function setAttemptSink(fn: ((a: AttemptRecord) => void) | null): void { attemptSink = fn; }
// and where a drill reads them back (the practice view); nothing without one
let attemptReader: ((stage: AttemptStage) => Promise<AttemptRecord[]>) | null = null;
export function setAttemptReader(fn: ((stage: AttemptStage) => Promise<AttemptRecord[]>) | null): void { attemptReader = fn; }
/** The stage's attempts so far (deleted ones left out), oldest first; empty without a store. */
export function readAttempts(stage: AttemptStage): Promise<AttemptRecord[]> { return attemptReader ? attemptReader(stage) : Promise.resolve([]); }

export interface DrillSpec {
  /** element id prefix (`eo-`, `ocll-`): the ids the headless checks and the settings sheet use */
  id: string;
  /** what the store files this drill's attempts under */
  stage: AttemptStage;
  title: string;
  blurb: string;
  newLabel: string;
  hints: { key: string; label: string }[];
  movesLabel: string;
  placeholder: string;
  /** under the timer row */
  note: string;
  /** the reveal link under the result */
  showLabel: string;
  /** HTML for the picture column (the stage's own elements, with ids under the prefix) */
  left: string;
  /** HTML inserted right after the hint chips (a note area, say) */
  afterHints?: string;
}

export interface DrillHandlers {
  onNew(): void;
  /** the moves box was checked (non-empty, trimmed) */
  onCheck(text: string): void;
  /** do these moves reach the stage's target? (a source feeding the box checks itself when they do) */
  isDone?(text: string): boolean;
  /** a hint chip was opened: return its text */
  onHint(key: string): string;
  /** the reveal link toggled; `open` is the new state */
  onShow(open: boolean): void;
  /** a click on the hints row that was not a plain chip (a stage's own buttons there) */
  onHintsClick?(target: HTMLElement): boolean;
  /** extra keys while the stage is active and no field has focus; return true when handled */
  onKey?(ev: KeyboardEvent): boolean;
  onClear?(): void;
  /** the alg from solved whose state the picture shows before any moves (the scramble, the setup): the move peek starts from it */
  base?(): string;
  /** show the state after `alg` (from base) on the picture - the ▶ button on a listed line */
  onApply?(alg: string): void;
}

export interface Timer {
  running(): boolean;
  elapsed(): number | null;
  toggle(): void;
  reset(): void;
}

export interface Drill {
  $(name: string): HTMLElement;
  timer: Timer;
  flash(msg: string): void;
  result: {
    show(title: string, sub: string): void;
    hide(): void;
    visible(): boolean;
    /** free space inside the panel (a list, an alg line) */
    body: HTMLElement;
    /** the "continue to the next stage" button lives here */
    handoff: HTMLElement;
  };
  moves(): string;
  setMoves(text: string): void;
  /**
   * The moves so far from a source (a smart cube, the camera) at host time `t`: into the box, the
   * timer started at the first one, and Check fired by itself when the stage says they are done
   * (true). Empty text clears the box and the timer (the cube went back to the scramble).
   */
  feed(text: string, t: number, source?: 'cube' | 'camera'): boolean;
  /** The source's cube reached this drill's scramble at host time `t` (recognition is measured from here). */
  armed(t: number): void;
  /**
   * File the attempt just judged by attempt() with the store: the scramble it started from, the
   * moves, what the drill knew (the optimal count, the case) and whether a hint or solution was seen.
   */
  save(extra: { scramble: string; moves: string; optimal?: number; caseId?: string; assisted: boolean; start?: AttemptRecord['start']; quiz?: AttemptRecord['quiz'] }): void;
  /** put an alg in the moves box, copy it, say so */
  fill(alg: string, msg: string): void;
  /**
   * A listed line: `shown` is the text (stars, brackets, [AUF]s allowed), `alg` the plain moves. Every move
   * is a span the peek popover hangs off, and a ▶ at the end applies the line to the picture (onApply).
   * `skip` moves of `alg` come before the ones shown (a later step of a route: the line applies the whole
   * route so far, the text and the peek are its own step).
   */
  algLine(shown: string, alg: string, skip?: number): HTMLElement;
  /** back to the chips' labels */
  resetHints(): void;
  /** re-ask onHint for every open chip (something it depends on changed) */
  refreshHints(): void;
  setStats(text: string): void;
  showOpen(): boolean;
  setShowLabel(text: string): void;
  /** close the reveal without a callback */
  closeShow(): void;
  /** fresh case: timer, box, result, hints, reveal all reset */
  begin(): void;
  /** the stage is on screen and no sheet covers it */
  active(): boolean;
  /** what a result records: the moves typed as a count, the time, where the moves came from, and the source's recognition / execution split */
  attempt(text: string): { n: number; t: number | null; ts: string; source: 'typed' | 'cube' | 'camera'; recognition?: number; execution?: number };
}

export const STYLE = `
  .drill { max-width: 560px; margin: 0 auto; }
  @media (min-width: 820px) {
    .drill { max-width: 900px; display: grid; grid-template-columns: 360px 1fr; gap: 0 32px; align-items: start; }
    .drill .eo-head { grid-column: 1 / -1; }
    .drill .eo-left { position: sticky; top: 16px; }
    .drill .eo-right .eo-hints { margin-top: 2px; }
  }
  .eo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
  .eo-head h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .eo-head p { margin: 4px 0 0; color: var(--ink-2); font-size: 14px; line-height: 1.4; }
  .eo-primary { background: var(--ink) !important; color: #fff !important; border-color: var(--ink) !important; font-weight: 600; white-space: nowrap; }
  .eo-stage { position: relative; max-width: 340px; margin: 0 auto; touch-action: none; cursor: grab; }
  .eo-stage:active { cursor: grabbing; }
  .eo-stage svg { display: block; width: 100%; height: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
  .eo-stage polygon, .eo-stage rect { stroke: #2b3340; stroke-width: 1.2; stroke-linejoin: round; }
  @media (prefers-reduced-motion: no-preference) { .eo-stage svg polygon { transition: fill .15s; } }
  .eo-corner { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
  .eo-corner .btn { padding: 5px 9px; font-size: 13px; }
  .eo-hint { font-size: 13px; color: var(--ink-2); }
  .eo-status { display: flex; align-items: baseline; justify-content: space-between; padding: 12px 4px 4px; gap: 10px; }
  .eo-bad { font-size: 16px; } .eo-bad b { font-weight: 600; } .eo-bad.zero { color: var(--good); }
  .eo-timer { font-variant-numeric: tabular-nums; font-size: 30px; font-weight: 300; line-height: 1; }
  .eo-scramble { color: var(--ink-2); font-size: 14px; padding: 2px 4px 8px; word-spacing: .25em; line-height: 1.5; }
  .eo-scramble span { color: var(--ink); }
  .eo-row { display: flex; gap: 6px; margin-top: 8px; }
  .eo-hints { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
  .eo-chip { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink-2); cursor: pointer; }
  .eo-chip.open { color: var(--ink); background: #fff; cursor: default; }
  .eo-note { margin: 6px 4px 10px; font-size: 13px; color: var(--ink-2); }
  .eo-stratnote { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 0 0 10px; line-height: 1.45; }
  .eo-stratnote ul { margin: 4px 0 0; padding-left: 18px; } .eo-stratnote li { margin: 4px 0; }
  .eo-lbl { display: block; font-size: 13px; color: var(--ink-2); margin: 0 0 6px 2px; }
  .eo-moves { width: 100%; font: inherit; font-size: 16px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); resize: vertical; letter-spacing: .02em; }
  .eo-moves:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .eo-flash { margin-top: 8px; color: #B3261E; font-size: 14px; min-height: 18px; }
  .eo-result { margin-top: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: none; }
  .eo-result.show { display: block; }
  .eo-result h2 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
  .eo-result p { margin: 4px 0; color: var(--ink-2); font-size: 14px; line-height: 1.45; }
  .eo-sol { font-variant-numeric: tabular-nums; word-spacing: .3em; font-size: 16px; line-height: 1.7; }
  .eo-sol [data-alg], .eo-result .ll-alg { cursor: pointer; border-radius: 6px; padding: 0 4px; margin: 0 -4px; }
  .eo-sol [data-alg]:hover, .eo-result .ll-alg:hover { background: var(--grey-ll); }
  .eo-sol .grp { margin-top: 8px; }
  .eo-sol .grp-h { font-size: 13px; color: var(--ink-2); word-spacing: normal; line-height: 1.4; }
  .eo-sol .yours { font-size: 12px; font-style: normal; color: var(--ink-2); background: var(--grey-ll); border-radius: 4px; padding: 1px 5px; margin-left: 6px; word-spacing: normal; }
  .eo-link { font: inherit; background: none; border: none; padding: 4px 2px; color: var(--ink-2); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; font-size: 14px; }
  .eo-stats { color: var(--ink-2); font-size: 13px; padding: 10px 2px 0; }
  .eo-result .mv { border-radius: 4px; padding: 0 1px; }
  .eo-result .mv:hover, .eo-result .mv.on { background: var(--ink); color: var(--bg); }
  .eo-apply { font: inherit; font-size: 13px; line-height: 1; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px; margin-left: 8px; cursor: pointer; color: var(--ink-2); vertical-align: middle; word-spacing: normal; }
  .eo-apply:hover { border-color: var(--ink-2); color: var(--ink); }
  .zz-peek { position: fixed; z-index: 1200; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; box-shadow: 0 8px 28px rgba(0,0,0,.18); pointer-events: none; max-width: 300px; }
  .zz-peek .row { display: flex; align-items: center; gap: 6px; }
  .zz-peek svg { width: 110px; height: 110px; display: block; }
  .zz-peek svg polygon { stroke: #2b3340; stroke-width: 1.2; }
  .zz-peek .arr { font-size: 22px; color: var(--ink-2); }
  .zz-peek .cap { font-size: 13px; color: var(--ink-2); margin-top: 4px; line-height: 1.35; word-spacing: normal; }
  .zz-peek .cap b { color: var(--ink); font-size: 15px; margin-right: 6px; }
  .ll-alg { font-size: 16px; word-spacing: .3em; margin: 6px 0; }
  .ll-alg small { display: block; font-size: 13px; color: var(--ink-2); word-spacing: normal; margin-top: 2px; }
`;

export function mountDrill(root: HTMLElement, spec: DrillSpec, h: DrillHandlers): Drill {
  if (!document.getElementById('drill-style')) {
    const s = document.createElement('style'); s.id = 'drill-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  const id = (n: string) => `${spec.id}-${n}`;
  root.innerHTML = `
    <div class="drill">
      <div class="eo-head">
        <div><h1>${spec.title}</h1><p id="${id('sub')}">${spec.blurb}</p></div>
        <button id="${id('next')}" class="btn eo-primary" type="button">${spec.newLabel}</button>
      </div>
      <div class="eo-left">${spec.left}</div>
      <div class="eo-right">
        <div class="eo-hints" id="${id('hints')}">${spec.hints.map((c) => `<button type="button" class="eo-chip" data-hint="${c.key}">${c.label}</button>`).join('')}</div>
        ${spec.afterHints ?? ''}
        <div class="eo-row">
          <button id="${id('timerBtn')}" class="btn eo-primary" type="button" style="flex:1">Start timer</button>
          <button id="${id('timerReset')}" class="btn" type="button" title="Reset timer (Esc)">Reset</button>
        </div>
        <p class="eo-note">${spec.note}</p>
        <label class="eo-lbl" for="${id('sol')}">${spec.movesLabel}</label>
        <textarea id="${id('sol')}" class="eo-moves" rows="2" placeholder="${spec.placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
        <div class="eo-row">
          <button id="${id('check')}" class="btn eo-primary" type="button">Check</button>
          <button id="${id('clear')}" class="btn" type="button">Clear</button>
          <button id="${id('tricks')}" class="btn" type="button" title="Finger by finger: the moves in the box, or the scramble when the box is empty">✋ Fingertricks</button>
        </div>
        <div class="eo-flash" id="${id('flash')}"></div>
        <div class="eo-result" id="${id('result')}">
          <h2 id="${id('rTitle')}"></h2>
          <p id="${id('rSub')}"></p>
          <div id="${id('rBody')}"></div>
          <div id="${id('handoff')}"></div>
        </div>
        <div style="padding:8px 2px 0"><button class="eo-link" id="${id('showSol')}" type="button">${spec.showLabel}</button></div>
        <div class="eo-stats" id="${id('stats')}"></div>
      </div>
    </div>`;
  const $ = (n: string): HTMLElement => {
    const e = document.getElementById(id(n));
    if (!e) throw new Error(`drill ${spec.id} has no #${id(n)}`);
    return e;
  };
  const box = $('sol') as HTMLTextAreaElement;
  const labels = Object.fromEntries(spec.hints.map((c) => [c.key, c.label]));

  // timer, and where the attempt's moves came from
  let startAt: number | null = null, endAt: number | null = null;
  let armedAt: number | null = null;
  let fedBy: 'cube' | 'camera' | null = null;
  let lastAttempt: { n: number; t: number | null; source: 'typed' | 'cube' | 'camera'; recognition?: number; execution?: number } | null = null;
  const timer: Timer = {
    running: () => startAt !== null && endAt === null,
    elapsed: () => (startAt === null ? null : ((endAt ?? performance.now()) - startAt) / 1000),
    toggle() {
      if (timer.running()) { endAt = performance.now(); $('timerBtn').textContent = 'Start timer'; box.focus(); }
      else { startAt = performance.now(); endAt = null; $('timerBtn').textContent = 'Stop'; }
    },
    reset() { startAt = null; endAt = null; $('timerBtn').textContent = 'Start timer'; },
  };
  const tick = () => { const t = timer.elapsed(); const el = document.getElementById(id('timer')); if (el) el.textContent = t === null ? '0.00' : t.toFixed(2); requestAnimationFrame(tick); };

  const flash = (m: string) => { $('flash').textContent = m; };
  const active = () => !root.hidden && !sheetOpen();
  const result = {
    show(title: string, sub: string) { $('rTitle').textContent = title; $('rSub').textContent = sub; $('result').classList.add('show'); },
    hide() { $('result').classList.remove('show'); },
    visible: () => $('result').classList.contains('show'),
    body: $('rBody'),
    handoff: $('handoff'),
  };
  const showOpen = () => !!$('showSol').dataset.open;
  const closeShow = () => { delete $('showSol').dataset.open; $('showSol').textContent = spec.showLabel; };

  const check = () => {
    const txt = box.value.trim();
    if (!txt) { flash('Type the moves you did first.'); return; }
    h.onCheck(txt);
  };

  // wiring
  $('next').onclick = () => h.onNew();
  $('timerBtn').onclick = () => timer.toggle();
  $('timerReset').onclick = () => timer.reset();
  $('check').onclick = check;
  $('clear').onclick = () => { box.value = ''; result.hide(); flash(''); h.onClear?.(); };
  // the moves typed (tap a listed solution to put it there), else the scramble as it is shown - WCA hold
  $('tricks').onclick = () => {
    const typed = box.value.trim();
    if (typed) { if (!openFingertricks(typed, { title: 'Your moves', hold: trainerHold() })) flash('Could not read the moves in the box.'); return; }
    const scr = stages[activeTab()]?.scramble();
    if (!scr) { flash('Nothing to show: type some moves, or tap a solution.'); return; }
    openFingertricks(toWca(scr), { title: spec.id === 'eo' ? 'The scramble' : 'The setup', hold: WCA_HOLD });
  };
  $('hints').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (h.onHintsClick?.(t)) return;
    const b = t.closest<HTMLButtonElement>('.eo-chip[data-hint]');
    if (!b || b.classList.contains('open')) return;
    b.classList.add('open');
    b.textContent = h.onHint(b.dataset.hint!);
  });
  $('showSol').onclick = () => {
    const b = $('showSol');
    if (result.visible() && b.dataset.open) { result.hide(); closeShow(); h.onShow(false); return; }
    b.dataset.open = '1';
    result.handoff.innerHTML = '';
    h.onShow(true);
    result.show($('rTitle').textContent ?? '', $('rSub').textContent ?? '');
  };
  // tap-to-fill: anything with data-alg inside the result, and the alg line; ▶ also applies it to the picture
  $('result').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-alg]');
    if (!el) return;
    const apply = (e.target as HTMLElement).closest('.eo-apply');
    drill.fill(el.dataset.alg!, apply ? 'On the picture, and in the moves box. Press Check when you have done it on your cube.' : spec.id === 'eo' ? 'Put in the moves box. Add your cross moves, then Check.' : 'Put in the moves box. Press Check when you have done it.');
    if (apply) { hidePeek(); h.onApply?.(el.dataset.alg!); }
  });

  // ---- the move peek: hover (or tap) a move in a listed line to see the cube before and after it ----
  let peek: HTMLElement | null = null;
  const hidePeek = () => { if (peek) { peek.remove(); peek = null; } root.querySelectorAll('.mv.on').forEach((m) => m.classList.remove('on')); };
  const cellsOf = (f: string): Cell[] => STICKERS.map((s) => ({ fill: faceHex(f[s.idx]!) }));
  function showPeek(mv: HTMLElement): void {
    const line = mv.closest<HTMLElement>('[data-alg]');
    const base = h.base?.();
    if (!line || base === undefined) return;
    const toks = tokens(line.dataset.alg!);
    const k = Number(line.dataset.skip ?? 0) + Number(mv.dataset.i);
    const move = toks[k];
    if (!move) return;
    const before = state(`${base} ${toks.slice(0, k).join(' ')}`), after = state(`${base} ${toks.slice(0, k + 1).join(' ')}`);
    hidePeek();
    mv.classList.add('on');
    peek = document.createElement('div'); peek.className = 'zz-peek';
    peek.innerHTML = '<div class="row"><svg viewBox="-170 -170 340 340"></svg><span class="arr">→</span><svg viewBox="-170 -170 340 340"></svg></div><div class="cap"><b></b><span></span></div>';
    const [s1, s2] = peek.querySelectorAll('svg');
    render3d(s1 as SVGSVGElement, cellsOf(before), DEFAULT_VIEW); render3d(s2 as SVGSVGElement, cellsOf(after), DEFAULT_VIEW);
    peek.querySelector('b')!.textContent = move; peek.querySelector('.cap span')!.textContent = moveWhat(move);
    document.body.appendChild(peek);
    const r = mv.getBoundingClientRect(), w = peek.offsetWidth, hgt = peek.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = r.bottom + 8 + hgt > window.innerHeight ? r.top - hgt - 8 : r.bottom + 8;
    peek.style.left = `${x}px`; peek.style.top = `${Math.max(8, y)}px`;
  }
  $('result').addEventListener('mouseover', (e) => { const mv = (e.target as HTMLElement).closest<HTMLElement>('.mv'); if (mv) showPeek(mv); });
  $('result').addEventListener('mouseleave', hidePeek);
  $('result').addEventListener('mouseout', (e) => { if ((e.target as HTMLElement).closest('.mv') && !(e.relatedTarget as HTMLElement | null)?.closest?.('.mv')) hidePeek(); });
  window.addEventListener('scroll', hidePeek, { passive: true });
  document.addEventListener('keydown', (ev) => {
    if (!active()) return;
    const tag = (ev.target as HTMLElement).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { if (ev.target === box && ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); check(); } return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === ' ') { ev.preventDefault(); timer.toggle(); return; }
    if (ev.key === 'Escape') { timer.reset(); return; }
    if (ev.key.toLowerCase() === 'n') { h.onNew(); return; }
    h.onKey?.(ev);
  });

  const drill: Drill = {
    $, timer, flash, result, active,
    moves: () => box.value,
    setMoves: (t) => { box.value = t; },
    feed(text, t, source) {
      const txt = text.trim();
      box.value = txt;
      fedBy = source ?? fedBy ?? 'cube';
      if (!txt) { timer.reset(); result.hide(); flash(''); return false; }
      if (!timer.running()) { startAt = t; endAt = null; $('timerBtn').textContent = 'Stop'; }
      if (!h.isDone?.(txt)) return false;
      endAt = t; $('timerBtn').textContent = 'Start timer';
      h.onCheck(txt);
      return true;
    },
    armed(t) { armedAt = t; },
    save(extra) {
      if (!attemptSink || !lastAttempt) return;
      const a = lastAttempt;
      attemptSink({
        id: newId(), puzzle: '333', stage: spec.stage, when: Date.now(), scramble: extra.scramble, moves: extra.moves,
        time: a.t === null ? null : Math.round(a.t * 1000), recognition: a.recognition, execution: a.execution,
        caseId: extra.caseId, optimal: extra.optimal, assisted: extra.assisted, source: a.source, editedAt: Date.now(),
        ...(extra.start && { start: extra.start }), ...(extra.quiz && { quiz: extra.quiz }),
      });
    },
    fill(alg, msg) {
      box.value = alg; flash(msg);
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(alg).catch(() => undefined);
    },
    algLine(shown, alg, skip = 0) {
      const d = document.createElement('div'); d.dataset.alg = alg;
      if (skip) d.dataset.skip = String(skip);
      let i = 0;
      for (const word of shown.split(/\s+/).filter(Boolean)) {
        if (d.childNodes.length) d.appendChild(document.createTextNode(' '));
        const s = document.createElement('span'); s.textContent = word;
        if (word.replace(/[*()[\]]/g, '')) { s.className = 'mv'; s.dataset.i = String(i++); }
        d.appendChild(s);
      }
      if (h.onApply) { const b = document.createElement('button'); b.type = 'button'; b.className = 'eo-apply'; b.textContent = '▶'; b.title = 'Show the cube after these moves (and put them in the box)'; d.appendChild(b); }
      return d;
    },
    resetHints() { root.querySelectorAll<HTMLButtonElement>('.eo-chip[data-hint]').forEach((b) => { b.textContent = labels[b.dataset.hint!]; b.classList.remove('open'); }); },
    refreshHints() { root.querySelectorAll<HTMLButtonElement>('.eo-chip[data-hint].open').forEach((b) => { b.textContent = h.onHint(b.dataset.hint!); }); },
    setStats: (t) => { $('stats').textContent = t; },
    showOpen, closeShow,
    setShowLabel: (t) => { $('showSol').textContent = t; },
    begin() {
      timer.reset(); box.value = ''; result.hide(); result.handoff.innerHTML = ''; result.body.innerHTML = '';
      closeShow(); drill.resetHints(); flash('');
      armedAt = null; fedBy = null; lastAttempt = null;
    },
    attempt(text) {
      if (timer.running()) timer.toggle();
      const t = timer.elapsed();
      const source = fedBy ?? 'typed';
      const recognition = fedBy && armedAt !== null && startAt !== null ? Math.max(0, Math.round(startAt - armedAt)) : undefined;
      const execution = fedBy && startAt !== null && endAt !== null ? Math.max(0, Math.round(endAt - startAt)) : undefined;
      lastAttempt = { n: moveCount(text), t, source, recognition, execution };
      return { ...lastAttempt, ts: t === null ? '' : `, ${t.toFixed(2)}s` };
    },
  };
  tick();
  return drill;
}

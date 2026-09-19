// The Solve tab (docs/smart-cube-design.md 4.1): the timer that replaces
// csTimer. Random-state scrambles in WCA notation; with a smart cube the
// scramble is followed turn by turn, the timer arms itself when the
// scramble is on the cube (inspection starts), the first turn starts it
// and solved stops it, and the next scramble appears by itself: scramble,
// solve, repeat, phone out of reach. Without a cube, Space does what it
// does in every timer. Solves go to the store (local, synced when on)
// with their full move stream; sessions, averages and PBs read from it.

/// <reference path="../cubejs.d.ts" />
import Cube from 'cubejs';
import { tokens } from '../cube/alg';
import { fromWca, toWca } from '../cube/frame';
import { SOLVED, state } from '../cube/state';
import { relabelTurns, toSourceLetters, type Hold } from '../handoff';
import { shareScramble, sheetOpen, toast, type Stage } from '../shell';
import { solveState, validateState, warmSolver } from '../state';
import type { Store } from '../store/local';
import { effectiveTime, newId, type Penalty, type SessionRecord, type SolveMove, type SolveRecord } from '../store/types';
import type { ColorName, FaceId } from '../types';
import { downloadText } from '../ui/download';
import { exportCsTimer, importCsTimer } from './cstimer';
import type { Move } from '../moves/moves';
import { formatTime, sessionStats, type Time } from './stats';
import { ScrambleTracker, type TrackStatus } from './track';

// DECISION (user, 2026-09-17): no inspection countdown and no inspection penalties for now - the
// timer starts at the first turn and stops at solved; the gap from "scrambled" to the first turn is
// still recorded on the solve for later.
interface Settings { autonext: 'off' | 'on'; beep: 'off' | 'on' }
const SETTINGS_KEY = 'zz-timer-settings';
const SESSION_META = 'timer/session';

export interface TimerDeps {
  store: Promise<Store>;
  hold(): Hold;
  /** a solve just finished: its window on the host clock, for the recording rig to cut the video by */
  onSolve?(s: { id: string; when: number; t0: number; t1: number; scramble: string; time: number; moves?: unknown }): void;
}

/** ready = the scramble is on the cube (or Space was pressed once with inspection): the first turn starts the timer */
type Phase = 'idle' | 'ready' | 'solving';

const STYLE = `
  .tm { max-width: 560px; margin: 0 auto; }
  @media (min-width: 820px) { .tm { max-width: 720px; } }
  .tm-scr { font-size: 20px; line-height: 1.6; word-spacing: .35em; padding: 6px 4px; text-align: center; min-height: 40px; }
  .tm-scr .done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .tm-scr .gen { color: var(--ink-2); font-size: 15px; word-spacing: normal; }
  .tm-track { text-align: center; font-size: 13px; color: var(--ink-2); min-height: 18px; }
  .tm-track.off { color: #7A4B00; font-weight: 600; }
  /* a solution on demand: the cube's belief with a smart cube, the scramble's state without */
  .tm-sol { text-align: center; font-size: 13px; color: var(--ink-2); min-height: 22px; margin-top: 2px; }
  .tm-sol .moves { display: block; font-size: 17px; line-height: 1.5; word-spacing: .35em; color: var(--ink); padding: 2px 4px; }
  .tm-sol .btn { padding: 2px 6px; font-size: 13px; }
  /* the tap pad: most of the screen on a phone; press and release starts, a tap stops */
  .tm-pad { min-height: 36vh; display: flex; flex-direction: column; justify-content: center; margin: 6px 0; border-radius: 14px;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; cursor: pointer; transition: background .12s; }
  .tm-pad.held { background: #DDF3E4; }
  .tm-pad.held .tm-time { color: var(--good); }
  .tm-pad.solving { background: var(--panel); }
  @media (min-width: 820px) { .tm-pad { min-height: 220px; } }
  .tm-time { font-variant-numeric: tabular-nums; font-size: 72px; font-weight: 300; line-height: 1.1; text-align: center; padding: 14px 0 4px; letter-spacing: -0.02em; }
  .tm-time.insp { color: var(--good); } .tm-time.insp.warn { color: #B3261E; }
  .tm-state { text-align: center; color: var(--ink-2); font-size: 15px; min-height: 22px; }
  .tm-last { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px; margin: 10px 0 4px; font-size: 14px; }
  .tm-last .btn { padding: 5px 9px; font-size: 13px; } .tm-last .btn.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  .tm-sess { display: flex; gap: 8px; align-items: center; margin: 14px 0 6px; }
  .tm-sess select { font: inherit; font-size: 14px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); flex: 1; }
  .tm-stats { font-size: 13px; color: var(--ink-2); line-height: 1.7; padding: 2px 2px 8px; }
  .tm-stats b { color: var(--ink); font-weight: 600; }
  .tm-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .tm-list li { display: flex; gap: 10px; align-items: baseline; padding: 7px 4px; border-bottom: 1px solid var(--line); cursor: pointer; font-size: 14px; }
  .tm-list li.sel { background: var(--panel); }
  .tm-list .n { color: var(--ink-2); width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
  .tm-list .t { font-variant-numeric: tabular-nums; width: 70px; font-weight: 600; }
  .tm-list .s { flex: 1; color: var(--ink-2); font-size: 12px; word-spacing: .2em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tm-list .m { color: var(--ink-2); font-size: 12px; white-space: nowrap; }
  .tm-more { text-align: center; padding: 8px; }
`;

export function mountTimer(root: HTMLElement, deps: TimerDeps): Stage {
  if (!document.getElementById('timer-style')) {
    const s = document.createElement('style'); s.id = 'timer-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  const settings: Settings = { autonext: 'on', beep: 'on' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* no storage */ }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* no storage */ } };

  root.innerHTML = `
    <div class="tm">
      <div class="eo-head">
        <div><h1>Solve</h1><p id="tm-sub">Scramble, solve, repeat. With a smart cube the timer arms itself when the scramble is on the cube and stops when it is solved; without one, Space.</p></div>
        <button id="tm-next" class="btn eo-primary" type="button">New scramble</button>
      </div>
      <div class="tm-scr" id="tm-scr"></div>
      <div class="tm-track" id="tm-track"></div>
      <div class="tm-sol" id="tm-sol"><button class="btn eo-link" type="button" id="tm-solBtn">Show a solution</button><span id="tm-solText"></span></div>
      <div class="tm-pad" id="tm-pad" role="button" aria-label="Timer: press and release to start, tap to stop">
        <div class="tm-time" id="tm-time">0.00</div>
        <div class="tm-state" id="tm-state"></div>
      </div>
      <div class="tm-last" id="tm-last" hidden>
        <span id="tm-lastText"></span>
        <button class="btn" type="button" data-pen="0">OK</button><button class="btn" type="button" data-pen="2">+2</button><button class="btn" type="button" data-pen="-1">DNF</button><button class="btn" type="button" data-del="1">Delete</button>
      </div>
      <div class="tm-sess"><select id="tm-session" aria-label="Session"></select><button class="btn" type="button" id="tm-newsess">New session</button></div>
      <div class="tm-stats" id="tm-stats"></div>
      <ol class="tm-list" id="tm-list"></ol>
      <div class="tm-more" id="tm-more" hidden><button class="btn eo-link" type="button" id="tm-moreBtn">Show all</button></div>
    </div>`;
  const $ = (n: string): HTMLElement => {
    const e = document.getElementById(`tm-${n}`);
    if (!e) throw new Error(`timer has no #tm-${n}`);
    return e;
  };

  // ---- the scramble ----
  let scramble = '';                        // WCA notation
  let nextScramble: Promise<string> | null = null;
  let generation = 0;
  warmSolver();
  const genScramble = async (): Promise<string> => Cube.inverse(await solveState(Cube.random().asString()));
  /** Show `s` (WCA); `share` hands it to every other tab (false when it came from another tab). */
  function setScramble(s: string, share = true): void {
    scramble = s.trim();
    tracker = null; trackKey = '';
    resetAttempt();
    render();
    nextScramble = genScramble().catch(() => genScramble());
    if (share) shareScramble(fromWca(scramble), 'solve');
  }
  function newScramble(): void {
    const gen = ++generation;
    const p = nextScramble ?? genScramble();
    nextScramble = null;
    scramble = '';
    render();
    p.then((s) => { if (gen === generation) setScramble(s); }).catch((err) => toast(`No scramble: ${err instanceof Error ? err.message : err}`));
  }

  // ---- following the scramble on a smart cube ----
  let tracker: ScrambleTracker | null = null;
  let trackKey = '';
  let track: TrackStatus | null = null;
  let cubeFacelets: string | null = null;                       // the source's belief, its own letters
  let cubeColours: Record<FaceId, ColorName> | null = null;     // the colour of each of those letters
  function watch(facelets: string | null, colourOf: Record<FaceId, ColorName>): void {
    cubeFacelets = facelets; cubeColours = colourOf;
    if (solutionOpen) void showSolution();
    if (!scramble) { track = null; return; }
    const key = `${scramble}|${Object.values(colourOf).join(',')}|${deps.hold().front}`;
    if (key !== trackKey) {
      try { tracker = new ScrambleTracker(toSourceLetters(colourOf, fromWca(scramble), deps.hold())); trackKey = key; }
      catch { tracker = null; trackKey = ''; }
    }
    track = tracker ? tracker.status(facelets) : null;
    renderScramble();
  }

  // ---- a solution on demand (user, 2026-09-19) ----
  // Kociemba via cubejs, in WCA notation like the scramble. With a smart cube it is the solution
  // of the cube's belief and follows every turn while open; without one, of the scramble's state.
  let solutionOpen = false;
  let solutionKey = '';
  let solutionGen = 0;
  async function showSolution(): Promise<void> {
    const out = $('solText');
    // the state to solve and the map from its letters to WCA: the cube's letters through the trainer's, or the trainer's own
    let facelets: string;
    let toWcaLetters: (moves: Move[]) => string;
    if (cubeFacelets && cubeColours) {
      facelets = cubeFacelets;
      const colourOf = cubeColours;
      toWcaLetters = (moves) => toWca(relabelTurns(colourOf, moves, deps.hold()));
    } else if (scramble) {
      facelets = state(fromWca(scramble));
      toWcaLetters = (moves) => toWca(moves.join(' '));
    } else { out.textContent = ''; return; }
    if (facelets === solutionKey) return;
    solutionKey = facelets;
    const gen = ++solutionGen;
    if (facelets === SOLVED) { out.innerHTML = '<span class="moves">Solved</span>'; return; }
    const v = validateState(facelets);
    if (!v.ok) { out.textContent = `Cannot solve this state: ${v.error}`; return; }
    try {
      const sol = await solveState(facelets);
      if (gen !== solutionGen) return;
      const moves = tokens(sol) as Move[];
      out.innerHTML = `<span class="moves">${toWcaLetters(moves)}</span>${moves.length} turns · ${cubeFacelets ? 'the cube as the app believes it' : 'the scramble as shown'} · hold white on top, green facing you`;
    } catch (err) {
      if (gen === solutionGen) out.textContent = `No solution: ${err instanceof Error ? err.message : err}`;
    }
  }
  function renderSolution(): void {
    $('solBtn').textContent = solutionOpen ? 'Hide the solution' : 'Show a solution';
    if (!solutionOpen) { $('solText').textContent = ''; solutionKey = ''; }
  }
  $('solBtn').addEventListener('click', () => { solutionOpen = !solutionOpen; renderSolution(); if (solutionOpen) void showSolution(); });

  // ---- the attempt ----
  let phase: Phase = 'idle';
  let armedAt: number | null = null;   // inspection start, host ms
  let startAt: number | null = null;   // first turn / Space, host ms
  let moves: SolveMove[] = [];         // WCA letters, t relative to startAt
  let lastLine = '';
  function resetAttempt(): void { phase = 'idle'; armedAt = null; startAt = null; moves = []; }

  function armed(t: number): void {
    if (phase === 'solving') return;
    phase = 'ready'; armedAt = t; startAt = null; moves = [];
    beep(880, 70);
    render();
  }

  /** The turns since the scramble, in the trainer's letters, from the cube; true when solved. */
  function feed(text: string, t: number): boolean {
    const txt = text.trim();
    if (!txt) { // back at the scramble: the attempt starts over
      phase = 'ready'; armedAt ??= t; startAt = null; moves = [];
      render(); return false;
    }
    let toks: string[];
    try { toks = tokens(txt); } catch { return false; }
    if (startAt === null) { startAt = t; phase = 'solving'; moves = []; }
    for (let i = moves.length; i < toks.length; i++) moves.push({ m: toWca(toks[i]!), t: Math.max(0, Math.round(t - startAt)) });
    render();
    let solved: boolean;
    try { solved = state(`${fromWca(scramble)} ${txt}`) === SOLVED; } catch { solved = false; }
    if (!solved) return false;
    finish(t);
    return true;
  }

  function finish(tEnd: number): void {
    if (startAt === null) return;
    const time = Math.max(0, Math.round(tEnd - startAt));
    const inspection = armedAt !== null ? Math.max(0, Math.round(startAt - armedAt)) : undefined;
    const penalty: Penalty = 0; // +2 / DNF are the buttons under the time, never automatic
    const rec: SolveRecord = {
      id: newId(), puzzle: '333', session: session?.id ?? 'main', when: Math.min(Date.now(), Date.now() - (performance.now() - startAt)), scramble, time, penalty,
      moves: moves.length ? moves.slice() : undefined, source: moves.length ? 'cube' : 'keyboard', inspection, editedAt: Date.now(),
    };
    const tps = rec.moves && time > 0 ? ` · ${rec.moves.length} turns · ${(rec.moves.length / (time / 1000)).toFixed(1)} TPS` : '';
    lastLine = `${formatTime(effectiveTime(rec))}${tps}`;
    deps.onSolve?.({ id: rec.id, when: rec.when, t0: startAt, t1: tEnd, scramble, time, moves: rec.moves });
    resetAttempt();
    beep(1320, 120);
    void deps.store.then((st) => st.putSolve(rec)).then(() => { selected = rec.id; });
    render();
    if (settings.autonext === 'on') newScramble();
  }

  // ---- the tap pad and Space: press arms (the digits go green), RELEASE starts, a tap stops ----
  // DECISION (user, 2026-09-17): the timer starts on release, never on the press, so a thumb resting
  // on the phone does not start it; a solve stops on the press itself, as every timer does.
  let held = false;       // pressed, waiting for the release that starts
  let swallowUp = false;  // the press that stopped a solve: its release must not start another
  function press(): void {
    if (phase === 'solving') { finish(performance.now()); swallowUp = true; return; }
    if (!scramble || held) return;
    held = true;
    render();
  }
  function release(): void {
    if (swallowUp) { swallowUp = false; return; }
    if (!held) return;
    held = false;
    if (phase === 'solving' || !scramble) { render(); return; }
    phase = 'solving'; startAt = performance.now(); moves = [];
    render();
  }
  const pad = $('pad');
  pad.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    try { pad.setPointerCapture(ev.pointerId); } catch { /* a synthetic event */ }
    press();
  });
  pad.addEventListener('pointerup', (ev) => { ev.preventDefault(); release(); });
  pad.addEventListener('pointercancel', () => { held = false; swallowUp = false; render(); });
  pad.addEventListener('contextmenu', (ev) => ev.preventDefault());

  const active = () => !root.hidden && !sheetOpen();
  const keyable = (ev: KeyboardEvent) => active() && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((ev.target as HTMLElement).tagName);
  document.addEventListener('keydown', (ev) => {
    if (!keyable(ev)) return;
    if (ev.key === ' ') { ev.preventDefault(); if (!ev.repeat) press(); }
    else if (ev.key === 'Escape') { held = false; resetAttempt(); render(); }
    else if (ev.key.toLowerCase() === 'n') newScramble();
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.key !== ' ' || !keyable(ev)) return;
    ev.preventDefault();
    release();
  });
  $('next').onclick = newScramble;

  // ---- sessions, solves, stats ----
  let session: SessionRecord | null = null;
  let sessions: SessionRecord[] = [];
  let solves: SolveRecord[] = [];
  let selected: string | null = null;
  let showAll = false;
  async function loadSessions(): Promise<void> {
    const st = await deps.store;
    sessions = await st.listSessions();
    if (!sessions.length) {
      const s: SessionRecord = { id: newId(), puzzle: '333', name: 'main', createdAt: Date.now(), editedAt: Date.now() };
      await st.putSession(s); sessions = [s];
    }
    const want = await st.getMeta<string>(SESSION_META);
    session = sessions.find((s) => s.id === want) ?? sessions[sessions.length - 1]!;
    await loadSolves();
  }
  async function loadSolves(): Promise<void> {
    if (!session) return;
    solves = await (await deps.store).listSolves(session.id);
    render();
  }
  async function pickSession(id: string): Promise<void> {
    const st = await deps.store;
    session = sessions.find((s) => s.id === id) ?? session;
    await st.setMeta(SESSION_META, session?.id);
    selected = null; showAll = false;
    await loadSolves();
  }
  $('session').addEventListener('change', () => { void pickSession(($('session') as HTMLSelectElement).value); });
  $('newsess').onclick = () => {
    const name = window.prompt('Name for the new session:', `session ${sessions.length + 1}`);
    if (!name) return;
    void deps.store.then(async (st) => {
      const s: SessionRecord = { id: newId(), puzzle: '333', name: name.trim(), createdAt: Date.now(), editedAt: Date.now() };
      await st.putSession(s); sessions.push(s); await pickSession(s.id);
    });
  };
  $('last').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    const rec = solves.find((s) => s.id === (selected ?? solves[solves.length - 1]?.id));
    if (!rec) return;
    if (b.dataset.del) { if (!window.confirm(`Delete the ${formatTime(effectiveTime(rec))} solve?`)) return; rec.deleted = true; }
    else rec.penalty = Number(b.dataset.pen) as Penalty;
    rec.editedAt = Date.now();
    void deps.store.then((st) => st.putSolve(rec));
  });
  $('list').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
    if (!li) return;
    selected = selected === li.dataset.id ? null : li.dataset.id!;
    render();
  });
  $('moreBtn').onclick = () => { showAll = true; render(); };

  // history in and out (the controls live in the settings sheet)
  const hist = (id: string) => document.getElementById(id);
  hist('hist-import')?.addEventListener('click', () => (hist('hist-file') as HTMLInputElement | null)?.click());
  hist('hist-file')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { sessions: ss, solves: vs } = importCsTimer(await file.text());
      const st = await deps.store;
      for (const s of ss) await st.putSession(s);
      for (const v of vs) await st.putSolve(v);
      toast(`Imported ${vs.length} solves in ${ss.length} session${ss.length === 1 ? '' : 's'}`);
      await loadSessions();
    } catch (err) { toast(`Import failed: ${err instanceof Error ? err.message : err}`); }
  });
  hist('hist-export')?.addEventListener('click', async () => {
    const st = await deps.store;
    downloadText(`cube-coach-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, sessions: await st.allSessions(), solves: await st.allSolves() }));
  });
  hist('hist-export-cs')?.addEventListener('click', async () => {
    const st = await deps.store;
    downloadText(`cstimer-${new Date().toISOString().slice(0, 10)}.txt`, exportCsTimer(await st.allSessions(), await st.allSolves()), 'text/plain');
  });

  // settings segments in the sheet
  const seg = document.getElementById('timer-settings');
  seg?.querySelectorAll<HTMLElement>('.eo-seg[data-set]').forEach((s) => {
    const key = s.dataset.set as keyof Settings;
    const paint = () => s.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[key]));
    paint();
    s.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
      if (!b) return;
      (settings as unknown as Record<string, string>)[key] = b.dataset.v!;
      saveSettings(); paint(); render();
    });
  });

  // ---- sound ----
  let audio: AudioContext | null = null;
  function beep(freq: number, ms: number): void {
    if (settings.beep !== 'on') return;
    try {
      audio ??= new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; g.gain.value = 0.12;
      o.connect(g).connect(audio.destination);
      o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch { /* no audio */ }
  }

  // ---- drawing ----
  function renderScramble(): void {
    const el = $('scr');
    if (!scramble) { el.innerHTML = '<span class="gen">generating a scramble…</span>'; $('track').textContent = ''; return; }
    const toks = scramble.split(' ');
    const applied = track && !track.off ? track.applied : track ? track.applied : 0;
    el.innerHTML = toks.map((t, i) => `<span class="${track && i < applied ? 'done' : ''}">${t}</span>`).join(' ');
    const tr = $('track');
    if (!track) { tr.textContent = ''; tr.className = 'tm-track'; return; }
    if (track.off) { tr.textContent = `Off the scramble: undo back to turn ${track.applied} (underlined)`; tr.className = 'tm-track off'; }
    else if (track.matched) { tr.textContent = 'Scrambled ✓'; tr.className = 'tm-track'; }
    else if (track.half) { tr.textContent = `${track.applied} of ${track.total} applied · halfway through ${toks[track.applied]}`; tr.className = 'tm-track'; }
    else { tr.textContent = `${track.applied} of ${track.total} applied`; tr.className = 'tm-track'; }
  }
  function renderTime(): void {
    const el = $('time');
    el.className = 'tm-time';
    $('pad').className = `tm-pad${held ? ' held' : ''}${phase === 'solving' ? ' solving' : ''}`;
    if (held) {
      el.textContent = '0.00';
    } else if (phase === 'ready') {
      el.classList.add('insp');
      el.textContent = 'ready';
    } else if (phase === 'solving' && startAt !== null) {
      el.textContent = formatTime(performance.now() - startAt, 1);
    } else {
      const last = solves.find((s) => s.id === (selected ?? solves[solves.length - 1]?.id));
      el.textContent = last ? formatTime(effectiveTime(last)) : '0.00';
    }
  }
  function render(): void {
    renderScramble();
    renderSolution();
    if (solutionOpen) void showSolution();
    renderTime();
    const st = $('state');
    if (held) st.textContent = 'Release to start';
    else if (phase === 'ready') st.textContent = 'Scrambled · the first turn starts the timer';
    else if (phase === 'solving') st.textContent = 'Solving… tap to stop';
    else st.textContent = lastLine || (track ? 'Scramble the cube · or press here and release to start' : 'Press here (or Space) and release to start · tap to stop');
    // the last (or selected) solve's controls
    const cur = solves.find((s) => s.id === (selected ?? solves[solves.length - 1]?.id));
    $('last').hidden = !cur || phase !== 'idle';
    if (cur) {
      $('lastText').textContent = `${selected ? `#${solves.indexOf(cur) + 1}` : 'Last'}: ${formatTime(effectiveTime(cur))}${cur.moves ? ` · ${cur.moves.length} turns` : ''}`;
      $('last').querySelectorAll<HTMLButtonElement>('button[data-pen]').forEach((b) => b.classList.toggle('on', Number(b.dataset.pen) === cur.penalty));
    }
    // sessions
    const sel = $('session') as HTMLSelectElement;
    sel.innerHTML = sessions.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    if (session) sel.value = session.id;
    // stats
    const times: Time[] = solves.map(effectiveTime);
    const s = sessionStats(times);
    const f = (t: Time | undefined) => formatTime(t);
    $('stats').innerHTML = s.n === 0 ? 'No solves in this session yet.' :
      `<b>${s.n}</b> solves · best <b>${f(s.best)}</b> · mean ${f(s.mean)} · mo3 ${f(s.mo3)} · ao5 <b>${f(s.ao5)}</b> · ao12 <b>${f(s.ao12)}</b> · ao50 ${f(s.ao50)} · ao100 ${f(s.ao100)}<br>` +
      `best ao5 ${f(s.bestAo5)} · best ao12 ${f(s.bestAo12)}`;
    // the list, newest first
    const rows = showAll ? solves : solves.slice(-30);
    $('list').innerHTML = rows.map((v) => {
      const i = solves.indexOf(v) + 1;
      const t = v.penalty === -1 ? 'DNF' : `${formatTime(effectiveTime(v))}${v.penalty === 2 ? '+' : ''}`;
      const m = v.moves ? `${v.moves.length} · ${(v.moves.length / Math.max(0.001, v.time / 1000)).toFixed(1)} tps` : v.source === 'import' ? 'csTimer' : '';
      return `<li data-id="${v.id}" class="${v.id === selected ? 'sel' : ''}"><span class="n">${i}</span><span class="t">${t}</span><span class="s" title="${v.scramble}">${v.scramble}</span><span class="m">${m}</span></li>`;
    }).reverse().join('');
    $('more').hidden = showAll || solves.length <= 30;
  }
  const tick = () => { if (phase !== 'idle') renderTime(); requestAnimationFrame(tick); };
  tick();

  void deps.store.then((st) => { st.onChange(() => { void loadSolves(); }); return loadSessions(); }).then(() => newScramble());

  return {
    load: (trainerScramble) => setScramble(toWca(trainerScramble), false),
    render,
    scramble: () => (scramble ? fromWca(scramble) : null),
    newScramble,
    feed, armed, watch,
  };
}

// What you are practising (docs/ui-redesign.md 6.1-6.3): a MODE is a stretch of
// the solve - where the scramble leaves the cube, where the attempt stops, and
// which stage it is about - and the page is the cube rail (ui/rail.ts) beside
// the stage that mode is about. The tabs of old are still the stages under the
// hood (shell.ts showTab / activeTab: the panel in the focus pane, the stage
// the cube's turns go to); a mode picks the one it starts on, the strip its
// range, and which stages the cube's follow may open as the cube crosses into
// them. A cube picked up elsewhere (a hand scramble, a scan) shows its stage
// with a banner back to the mode, and the mode stays what you picked.
//
// Also here: the mode chip and its picker, each mode's settings sheet (the
// stages' own option rows moved into it, ids and listeners and all), the ?
// that shows the prose the focus pane hides, the phone's bottom nav, and the
// two places that are not practice: Cases and Progress.

import { state } from '../cube/state';
import { activeTab, carriedSolve, closeSheet, onTabChange, openAlgs, openSheet, ownerTab, sheetOpen, showTab, stages, toast, type Tab } from '../shell';
import { stageOf } from '../stage';
import type { SplitStage } from '../timer/splits';
import { eoToCross, PHASES, phaseRank, setStop, stopOf, type StopStart } from './stops';
import { mountRail, type CubeView, type Rail } from '../ui/rail';
import { readStored, readStoredJson, writeStored } from '../ui/settings';
import { setFollowRules } from './cubefollow';
import { mountTrend } from '../analysis/trendui';
import { mountDrillHistory } from './drillhist';
import { mountCoach, type CoachAction } from '../analysis/coachui';
import { setPicks } from '../f2l/pool';
import { hold, store } from './context';
import { canUseCube, useMyCube } from './fromcube';
import { activeSource, onSourceChange } from './sources';

type ModeId = 'solve' | 'eo' | 'f2l' | 'll' | 'find';
type LLSet = 'ocll' | 'pll';
/** The picker's rows: the Solve, one per stage a stretch can start at, and the finder. */
type RowId = 'solve' | 'eo' | 'f2l' | 'ocll' | 'pll' | 'find';

interface ModeDef {
  id: ModeId;
  name(): string;
  /** the focus pane's line under the title: what it is about */
  what(): string;
  /** the stages the mode covers (the strip), and the one it is about */
  range(): readonly SplitStage[];
  focus(): SplitStage | null;
  /** the stage panel it starts on */
  home(): Tab;
  /** the rail's cube view until you pick another: the Solve mode has no picture of its own */
  view: CubeView;
}

const MODE_KEY = 'zz-mode', SET_KEY = 'zz-ll-set', F2L_KIND = 'zzf2l-kind';
const llSet = (): LLSet => (readStored(SET_KEY) === 'ocll' ? 'ocll' : 'pll');
const llFrom = (): string => {
  const st = readStoredJson(`zz-${llSet()}-settings`) as { from?: string } | null;
  return st?.from ?? llSet();
};
/** The EO row's name: EO alone, or EOCross (EO, then the cross) and on. */
const eoName = (): string => (eoToCross() ? 'EOCross' : 'EO');
const f2lKind = (): 'all' | 'picked' => (readStored(F2L_KIND) === 'picked' ? 'picked' : 'all');

const ALL = PHASES;
const STAGE_NAME: Record<SplitStage, string> = { eo: 'EO', cross: 'Cross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };
const rank = phaseRank;
/** The stages from `start` through `stop`. */
const stretch = (start: SplitStage, stop: SplitStage): SplitStage[] => ALL.filter((s) => rank(s) >= rank(start) && rank(s) <= rank(stop) && (s !== 'cross' || start === 'eo'));
/** "F2L", or "F2L → OCLL", or "EOCross → solved" (the EO row's own two phases are its name: EO, or EOCross). */
const ownStop = (start: SplitStage, stop: SplitStage): boolean => stop === start || (start === 'eo' && stop === 'cross');
const stretchName = (name: string, start: SplitStage, stop: SplitStage): string => (ownStop(start, stop) ? name : `${name} → ${stop === 'pll' ? 'solved' : STAGE_NAME[stop]}`);
const onTo = (start: SplitStage, stop: SplitStage): string => (ownStop(start, stop) ? '' : `, then on to ${stop === 'pll' ? 'the end' : STAGE_NAME[stop]}`);

const MODES: readonly ModeDef[] = [
  // DECISION: the Solve mode shows the cube's net on a desktop (room for it beside the timer); on a phone it starts hidden, a tap away
  { id: 'solve', name: () => 'Solve', what: () => 'timed, the stages as splits', range: () => ALL, focus: () => null, home: () => 'solve', view: 'net' },
  { id: 'eo', name: () => stretchName(eoName(), 'eo', stopOf('eo')), what: () => `plan it, then do it${onTo('eo', stopOf('eo'))}`, range: () => stretch('eo', stopOf('eo')), focus: () => 'eo', home: () => 'eo', view: 'off' },
  { id: 'f2l', name: () => stretchName('F2L', 'f2l', stopOf('f2l')), what: () => `the pairs, with their cases${onTo('f2l', stopOf('f2l'))}`, range: () => stretch('f2l', stopOf('f2l')), focus: () => 'f2l', home: () => 'f2l', view: 'off' },
  {
    id: 'll', name: () => (llSet() === 'pll' ? 'PLL' : stretchName('OCLL', 'ocll', stopOf('ocll'))), what: () => 'the cases you pick',
    range: () => {
      const f = llFrom();
      if (llSet() === 'pll') return f === 'pair' ? ['f2l', 'ocll', 'pll'] : f === 'ocll' ? ['ocll', 'pll'] : ['pll'];
      return stretch(f === 'pair' ? 'f2l' : 'ocll', stopOf('ocll'));
    },
    focus: () => llSet(), home: () => llSet(), view: 'off',
  },
  { id: 'find', name: () => 'Find an F2L case', what: () => 'no scramble: tap where the pieces are', range: () => [], focus: () => 'f2l', home: () => 'f2l', view: 'off' },
];
const modeDef = (id: ModeId): ModeDef => MODES.find((m) => m.id === id)!;
const TAB_NAME: Record<Tab, string> = { solve: 'Solve', eo: 'EOCross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };
const ROWS: readonly RowId[] = ['solve', 'eo', 'f2l', 'ocll', 'pll', 'find'];
const rowMode = (r: RowId): ModeId => (r === 'ocll' || r === 'pll' ? 'll' : r);
/** The picker's row the current mode is. */
const currentRow = (): RowId => (mode === 'll' ? llSet() : mode);

let mode: ModeId = 'solve';
let rail: Rail | null = null;
/** The mode you picked. */
function currentMode(): ModeId { return mode; }

/** The mode a stage panel belongs to: the current one when it is one of its panels, else the stage's own. */
function modeForTab(t: Tab): ModeId {
  if (t === 'f2l') return mode === 'find' ? mode : 'f2l';
  if (t === 'ocll' || t === 'pll') { if (llSet() !== t) writeStored(SET_KEY, t); return 'll'; }
  return t;
}
/** A stage panel inside the mode's stretch (the follow may open it, and no banner says "back"). */
function inMode(t: Tab): boolean {
  if (t === modeDef(mode).home()) return true;
  return t !== 'solve' && modeDef(mode).range().includes(t);
}

/** The stage's case is not one for this mode (another tab's scramble, a solved cube): a fresh one. */
function ensureCase(t: Tab): void {
  if (t === 'solve' || mode === 'find') return;
  const st = stages[t];
  const scr = st?.scramble() ?? null;
  let at: string | null;
  try { at = scr === null ? null : stageOf(state(scr)).stage; } catch { at = null; }
  const ok = at !== null && at !== 'solved' && (t === 'eo' ? at === 'eo' : t === 'f2l' ? at === 'f2l' : modeDef(mode).range().includes(at as SplitStage));
  if (!ok) st?.newScramble();
}

/** Pick a mode: its panel opens (with a case for it, unless `keep`), the rail and the header follow. */
function selectMode(id: ModeId, keep = false): void {
  mode = id;
  writeStored(MODE_KEY, id);
  const f2l = document.getElementById('f2l-panel');
  if (f2l) {
    const wasFind = f2l.classList.contains('find');
    f2l.classList.toggle('find', id === 'find');
    f2l.classList.toggle('picked', id !== 'find' && f2lKind() === 'picked');
    // finding a case by hand: the tracked scramble goes, the pieces are yours to place
    if (id === 'find' && !wasFind) document.getElementById('restart')?.click();
  }
  // F2L on into the last layer: the whole cube solved brings the next F2L scramble (the finder's own box, ticked)
  const rescr = document.getElementById('rescramble') as HTMLInputElement | null;
  if (id === 'f2l' && stopOf('f2l') !== 'f2l' && rescr && !rescr.checked) { rescr.checked = true; rescr.dispatchEvent(new Event('change')); }
  const home = modeDef(id).home();
  showTab(home);
  if (!keep) ensureCase(home);
  document.body.classList.toggle('bare', id === 'find');
  rail?.refresh();
  render();
}

// ---- the header: the chip, the desktop tabs, the focus pane's title, the banner ----
function chipSub(): string {
  if (mode === 'solve') return (readStored('zz-solve-follow') ?? 'follow') === 'follow' ? 'coach on' : '';
  if (mode === 'f2l') return f2lKind() === 'picked' ? 'picked cases' : 'all pairs';
  if (mode === 'll') {
    const st = readStoredJson(`zz-${llSet()}-settings`) as { cases?: string[]; from?: string } | null;
    const n = st?.cases?.length;
    const from = st?.from && st.from !== llSet() ? ` · from ${st.from === 'pair' ? 'last pair' : st.from.toUpperCase()}` : '';
    return `${n ? `${n} cases` : 'all cases'}${from}`;
  }
  return '';
}
function render(): void {
  const def = modeDef(mode);
  document.getElementById('mode-name')!.textContent = def.name();
  document.getElementById('mode-sub')!.textContent = chipSub();
  document.querySelectorAll<HTMLElement>('#mtabs [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode || (b.dataset.mode === 'f2l' && mode === 'find')));
  const t = activeTab();
  const home = def.home();
  document.getElementById('focus-title')!.textContent = def.name();
  const sub = document.getElementById('focus-sub')!;
  sub.textContent = t !== home && inMode(t) ? (carriedSolve() ? `coach: ${TAB_NAME[t]}` : `now at ${TAB_NAME[t]}`) : def.what();
  // the cube picked up somewhere else (a hand scramble, a scan): its stage is on show, the mode is still yours
  const banner = document.getElementById('focus-banner')!;
  const off = t !== home && !carriedSolve() && !inMode(t);
  banner.hidden = !off;
  // redrawn only when it says something else: this runs every second, and a redraw under a press would eat the click
  const html = off ? `<span>Following your cube: it is at <b>${TAB_NAME[t]}</b>.</span><button type="button" class="btn" data-go="here">Practice ${TAB_NAME[t]} from here</button><button type="button" class="btn" data-go="back">Back to ${def.name()}</button>` : '';
  if (banner.dataset.html !== html) { banner.dataset.html = html; banner.innerHTML = html; }
}

// ---- the picker: the Solve, the stretches (a row per stage one starts at, a cell per stage it can stop after), the finder ----
const ROW_WHAT: Record<RowId, () => string> = {
  solve: () => 'scrambled → solved, timed and kept in your session; the coach shows each stage\'s help as you get there, EOCross first',
  eo: () => 'from a scramble',
  f2l: () => (f2lKind() === 'picked' ? 'cross done, a picked case' : 'cross done'),
  ocll: () => (readStoredJson('zz-ocll-settings') as { from?: string } | null)?.from === 'pair' ? 'from the last pair' : 'an OCLL case',
  pll: () => { const f = (readStoredJson('zz-pll-settings') as { from?: string } | null)?.from; return f === 'pair' ? 'recognised from the last pair' : f === 'ocll' ? 'recognised from OCLL' : 'a PLL case'; },
  find: () => 'no scramble: tap where the pieces are',
};
const ROW_NAME: Record<RowId, () => string> = { solve: () => 'Solve', eo: eoName, f2l: () => 'F2L', ocll: () => 'OCLL', pll: () => 'PLL', find: () => 'Find an F2L case' };
function renderPicker(): void {
  const cur = currentRow();
  const key = (r: RowId) => `<kbd>${ROWS.indexOf(r) + 1}</kbd>`;
  const whole = (r: RowId) => `<button type="button" class="mp-item${r === cur ? ' on' : ''}" data-row="${r}">${key(r)}<b>${ROW_NAME[r]()}</b><span class="w">${ROW_WHAT[r]()}</span></button>`;
  // the columns: EO and the cross apart (2026-09-27); on the EO row the Cross cell is the EO page's goal run on to the cross
  const COLS = PHASES;
  const col = phaseRank;
  const rows = (['eo', 'f2l', 'ocll', 'pll'] as const).map((r) => {
    const stop: SplitStage = r === 'pll' ? 'pll' : stopOf(r);
    const cells = COLS.map((s) => {
      if (col(s) < col(r) || (s === 'cross' && r !== 'eo')) return '<i class="mp-gap"></i>';
      // (user, 2026-09-26) EOCross on to solved is a whole solve: the Solve row, whose coach helps from EOCross on
      if (r === 'eo' && s === 'pll') return '<span class="mp-cell same" title="From a scramble to solved is a whole solve: the Solve row, with the coach on for each stage\'s help">= Solve</span>';
      const title = r === 'eo' && s === 'eo' ? 'EO alone: timed until the edges are oriented'
        : r === 'eo' && s === 'cross' ? 'EO, then the cross: timed until the cross is in (each timed on the strip)'
        : s === r ? `${STAGE_NAME[r]} alone` : `${STAGE_NAME[r]}, then on through ${s === 'pll' ? 'PLL to solved' : STAGE_NAME[s]}`;
      return `<button type="button" class="mp-cell${col(s) <= col(stop) ? ' in' : ''}${s === stop ? ' end' : ''}" data-row="${r}" data-stop="${s}" title="${title}">${STAGE_NAME[s]}</button>`;
    }).join('');
    return `<button type="button" class="mp-name${r === cur ? ' on' : ''}" data-row="${r}">${key(r)}<b>${ROW_NAME[r]()}</b><span class="w">${ROW_WHAT[r]()}</span></button>${cells}`;
  }).join('');
  document.getElementById('mp-list')!.innerHTML = `${whole('solve')}
    <div class="mp-cap"><b>Practice a stretch.</b> A row is where the scramble leaves the cube; tap the stage to stop after. The help follows your cube up to there, and when the cube is solved the next scramble comes. All the way from a scramble is the Solve.</div>
    <div class="mp-grid">${rows}</div>${whole('find')}`;
}
/** A picker row (and a stop, from its cells): the mode it is, with its case. */
function pickRow(r: RowId, stop?: SplitStage): void {
  if (r === 'ocll' || r === 'pll') writeStored(SET_KEY, r);
  if (stop && (r === 'eo' || r === 'f2l' || r === 'ocll')) setStop(r, stop);
  selectMode(rowMode(r));
}

// ---- a mode's settings: the stages' own rows, moved into one sheet ----
function openSetup(): void {
  const sec = mode;
  document.querySelectorAll<HTMLElement>('#setup-sheet [data-setup]').forEach((s) => { s.hidden = s.dataset.setup !== sec; });
  document.querySelectorAll<HTMLElement>('#setup-sheet [data-llset]').forEach((s) => { s.hidden = s.dataset.llset !== llSet(); });
  document.getElementById('setup-title')!.textContent = `${modeDef(mode).name()} · settings`;
  paintSegs();
  openSheet('setup-sheet');
}
function paintSegs(): void {
  document.querySelectorAll<HTMLElement>('#ll-set button').forEach((b) => b.classList.toggle('on', b.dataset.v === llSet()));
  document.querySelectorAll<HTMLElement>('#f2l-kind button').forEach((b) => b.classList.toggle('on', b.dataset.v === f2lKind()));
}
/** Move `el` (with its ids and listeners) under `to`. */
const move = (el: Element | null, to: HTMLElement | null) => { if (el && to) to.appendChild(el); };
function assembleSetup(): void {
  // the Solve mode: the coach (the follow into the stages, app/cubefollow.ts owns it)
  const follow = document.getElementById('tm-follow');
  if (follow) {
    follow.hidden = false;
    follow.removeAttribute('title');
    follow.classList.add('eo-opt');
    const lbl = follow.querySelector('span');
    if (lbl) lbl.innerHTML = '<div class="lbl">Coach</div><span class="sub">With a smart cube: each stage\'s help (the pairs, the case) as the cube reaches it; the timer stays up.</span>';
    follow.querySelectorAll<HTMLButtonElement>('#tm-cubefollow button').forEach((b) => { b.textContent = b.dataset.v === 'follow' ? 'On' : 'Off'; });
    move(follow, document.getElementById('setup-solve-follow'));
  }
  // F2L: the when-solved box and the picture's box
  const f2l = document.getElementById('f2l-panel');
  move(f2l?.querySelector('.rescr') ?? null, document.getElementById('setup-f2l-moved'));
  move(f2l?.querySelector('.hidecube') ?? null, document.getElementById('setup-f2l-moved'));
  // the last layer: each drill's options, its voice, its pool, its picture box
  for (const k of ['ocll', 'pll'] as const) {
    const panel = document.getElementById(`${k}-panel`), to = document.getElementById(`setup-ll-${k}`);
    move(panel?.querySelector('.ll-showpic') ?? null, to);
    move(panel?.querySelector('.ll-opts') ?? null, to);
    for (const id of ['cases', 'chunks', 'say']) move(document.getElementById(`${k}-${id}`), to);
  }
  // Progress: the session picker, and the practice tables of the drills
  move(document.querySelector('#solve-panel .tm-sess'), document.getElementById('prog-sess'));
  const ll = document.getElementById('prog-ll'), f = document.getElementById('prog-f2l');
  for (const k of ['pll', 'ocll'] as const) {
    const d = document.getElementById(`${k}-practice`);
    if (d && ll) { const h = document.createElement('h3'); h.textContent = k.toUpperCase(); h.className = 'prog-h'; ll.appendChild(h); ll.appendChild(d); }
  }
  move(document.getElementById('f2lpractice'), f);
}

// ---- the places that are not practice ----
let casesKind: 'f2l' | 'ocll' | 'pll' = 'pll';
function openCases(kind?: 'f2l' | 'ocll' | 'pll' | 'other'): void {
  const k = kind ?? (mode === 'll' ? llSet() : mode === 'f2l' || mode === 'find' ? 'f2l' : casesKind);
  closeSheet('stats-sheet');
  if (k === 'other') { closeSheet('ref-sheet'); openAlgs(); casesBar(document.querySelector('#algs-sheet .zz-sheet-head'), 'other'); return; }
  closeSheet('algs-sheet');
  casesKind = k;
  const sheet = document.getElementById('ref-sheet')!;
  sheet.classList.toggle('drawer', window.matchMedia('(min-width: 1300px)').matches);
  document.getElementById(k === 'f2l' ? 'allcases' : `${k}-ref`)?.click();
  casesBar(sheet.querySelector('.zz-sheet-head'), k);
}
/** The switch between the case sheets, in the sheet's head. */
function casesBar(head: Element | null, on: string): void {
  if (!head) return;
  let bar = head.querySelector<HTMLElement>('.cases-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'eo-seg cases-bar';
    bar.innerHTML = '<button type="button" data-cases="f2l">F2L</button><button type="button" data-cases="ocll">OCLL</button><button type="button" data-cases="pll">PLL</button><button type="button" data-cases="other">Other puzzles</button>';
    bar.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cases]'); if (b) openCases(b.dataset.cases as 'f2l'); });
    head.insertBefore(bar, head.querySelector('.btn'));
  }
  bar.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.cases === on));
}
type ProgSeg = 'solves' | 'll' | 'f2l' | 'phases' | 'drills';
function openProgress(seg?: ProgSeg): void {
  closeSheet('ref-sheet'); closeSheet('algs-sheet');
  const s = seg ?? (mode === 'll' ? 'll' : mode === 'f2l' ? 'f2l' : 'solves');
  // the Solve tab's Graph opens this sheet and draws the solves
  document.getElementById('tm-graph')?.click();
  progressSeg(s);
}
// Phases (analysis/trendui.ts): a phase's time over the days; mounted on first open, redrawn on every open
let drawTrend: (() => Promise<void>) | null = null;
// Drills (drillhist.ts): every drill attempt, with a delete
let drawDrills: (() => Promise<void>) | null = null;
function progressSeg(s: ProgSeg): void {
  document.querySelectorAll<HTMLElement>('#prog-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === s));
  for (const k of ['solves', 'll', 'f2l', 'phases', 'drills']) document.getElementById(`prog-${k}`)!.hidden = k !== s;
  if (s === 'drills') { drawDrills ??= mountDrillHistory(document.getElementById('prog-drills')!, { store }); void drawDrills(); }
  if (s === 'phases') { drawTrend ??= mountTrend(document.getElementById('prog-phases')!, { store }); void drawTrend(); }
  // a practice table draws when its fold opens
  const open = (id: string) => { const d = document.getElementById(id) as HTMLDetailsElement | null; if (d) { d.open = false; d.open = true; } };
  if (s === 'll') { open('pll-practice'); open('ocll-practice'); }
  if (s === 'f2l') open('f2lpractice');
}
// the Coach (analysis/coachui.ts): mounted on first open, redrawn on every open
let drawCoach: (() => Promise<void>) | null = null;
function openCoach(): void {
  closeSheet('ref-sheet'); closeSheet('algs-sheet'); closeSheet('stats-sheet');
  drawCoach ??= mountCoach(document.getElementById('coach-panel')!, { store, act: coachAct });
  openSheet('coach-sheet');
  void drawCoach();
}
/** An advice's button: the cases put in the F2L practice pool, or the mode that practises it. */
function coachAct(a: CoachAction): void {
  closeSheet('coach-sheet');
  if (a.kind === 'f2l-cases') {
    setPicks(a.ids);
    writeStored(F2L_KIND, 'picked');
    paintSegs();
    selectMode('f2l');
    stages.f2l?.newScramble();
    toast(`${a.ids.length} case${a.ids.length === 1 ? '' : 's'} picked to practice`);
    return;
  }
  if (a.mode === 'll' && a.set) writeStored(SET_KEY, a.set);
  selectMode(a.mode);
}
function dest(d: string): void {
  closeSheet('coach-sheet');
  if (d === 'cases') openCases();
  else if (d === 'progress') openProgress();
  else if (d === 'coach') openCoach();
  else { closeSheet('ref-sheet'); closeSheet('algs-sheet'); closeSheet('stats-sheet'); closeSheet('modes-sheet'); }
}
/** The bottom nav and the desktop's places light up with the sheet that is open. */
function paintDests(): void {
  const on = !document.getElementById('coach-sheet')!.hidden ? 'coach' : !document.getElementById('stats-sheet')!.hidden ? 'progress' : (!document.getElementById('ref-sheet')!.hidden || !document.getElementById('algs-sheet')!.hidden) ? 'cases' : 'practice';
  document.querySelectorAll<HTMLElement>('#bnav [data-dest], .dests [data-dest]').forEach((b) => b.classList.toggle('on', b.dataset.dest === on));
}

// ---- a stretch: its end, and New anywhere in it ----
/**
 * The follow saw the cube solved, on a solve that started at `from`'s scramble (the follow's rule): a stretch of
 * the mode's (EOCross on to solved) goes back to where it starts, and the EO stage, which has no next-when-solved
 * of its own, makes the next scramble. (F2L's own box does, and the last layer's drills have their "next case
 * when solved".) A stage alone keeps its result up, as it always has.
 */
function stretchSolved(from: Tab | null): boolean {
  if (mode === 'solve' || mode === 'find' || from === null || from === 'solve' || !inMode(from) || modeDef(mode).range().filter((x) => x !== 'cross').length < 2) return false; // the cross is EOCross's own half, not a stage of its own
  const home = modeDef(mode).home();
  if (activeTab() !== home) { showTab(home); window.scrollTo({ top: 0 }); }
  if (home === 'eo') { stages.eo?.newScramble(); toast('Solved ✓ next scramble'); }
  return true;
}
/** The rail's New: the mode's own next case, from wherever in its stretch the cube is (the carried solve's own, while one is). */
function newCase(): void {
  if (carriedSolve()) { stages.solve?.newScramble(); return; }
  const home = modeDef(mode).home();
  if (activeTab() !== home && inMode(activeTab())) showTab(home);
  stages[activeTab()]?.newScramble();
}

export function initModes(): void {
  assembleSetup();
  // the follow opens only the stages inside the mode; a cube picked up and solved goes back to the mode's own
  setFollowRules({ openable: (s) => inMode(s), home: () => modeDef(mode).home(), solved: stretchSolved });
  rail = mountRail(document.getElementById('rail')!, {
    owner: () => stages[ownerTab()],
    ownerTab,
    newCase,
    source: activeSource,
    hold,
    onSource: (cb) => { onSourceChange(cb); },
    range: () => modeDef(mode).range(),
    focus: () => modeDef(mode).focus(),
    bare: () => mode === 'find',
    useCube: { can: canUseCube, go: () => { void useMyCube(); } },
    viewKey: () => mode,
    defaultView: () => (window.matchMedia('(min-width: 900px)').matches ? modeDef(mode).view : 'off'),
    bigClock: () => ownerTab() === 'solve',
    blocked: () => sheetOpen(),
  });

  const want = new URLSearchParams(location.search).get('tab');
  const tabs: readonly string[] = ['solve', 'eo', 'f2l', 'ocll', 'pll'];
  let m = readStored(MODE_KEY) as ModeId | 'f2lll' | null;
  // F2L into the last layer was its own mode until the stretches (2026-09-26): F2L, stopping after PLL
  if (m === 'f2lll') { setStop('f2l', 'pll'); m = 'f2l'; }
  // and EOCross on to solved, for an evening: the Solve
  if (m === 'eo' && (readStoredJson('zz-stop') as Partial<Record<StopStart, SplitStage>> | null)?.eo === 'pll') { setStop('eo', 'eo'); m = 'solve'; }
  if (want && tabs.includes(want)) m = modeForTab(want as Tab);
  else if (!m || !MODES.some((d) => d.id === m)) m = modeForTab((readStored('zz-tab') as Tab | null) ?? 'solve');
  // the first case is the one the stage made at mount (or the page address asked for): kept
  selectMode(m, true);

  // the chip, the tabs, the picker
  document.getElementById('mode-chip')!.addEventListener('click', () => { renderPicker(); openSheet('modes-sheet'); });
  document.getElementById('modes-close')!.addEventListener('click', () => closeSheet('modes-sheet'));
  document.getElementById('mp-list')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!b) return;
    closeSheet('modes-sheet');
    pickRow(b.dataset.row as RowId, b.dataset.stop as SplitStage | undefined);
  });
  document.getElementById('mtabs')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
    if (b) selectMode(b.dataset.mode as ModeId);
  });
  // settings, help, the banner
  document.getElementById('setup-open')!.addEventListener('click', openSetup);
  document.getElementById('setup-close')!.addEventListener('click', () => { closeSheet('setup-sheet'); render(); });
  document.getElementById('help-btn')!.addEventListener('click', () => document.getElementById('focus')!.classList.toggle('help'));
  document.getElementById('focus-banner')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
    if (!b) return;
    if (b.dataset.go === 'here') selectMode(modeForTab(activeTab()), true);
    else selectMode(mode);
  });
  document.getElementById('ll-set')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (!b) return;
    writeStored(SET_KEY, b.dataset.v!);
    paintSegs();
    document.querySelectorAll<HTMLElement>('#setup-sheet [data-llset]').forEach((s) => { s.hidden = s.dataset.llset !== llSet(); });
    if (mode === 'll') selectMode('ll');
  });
  document.getElementById('f2l-kind')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (!b) return;
    writeStored(F2L_KIND, b.dataset.v!);
    paintSegs();
    document.getElementById('f2l-panel')?.classList.toggle('picked', b.dataset.v === 'picked');
    stages.f2l?.newScramble();
    render();
  });
  // Cases and Progress
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dest]');
    if (!b || !(b.closest('#bnav') || b.closest('.dests') || b.closest('.mp-links'))) return;
    if (b.closest('.mp-links')) closeSheet('modes-sheet');
    dest(b.dataset.dest!);
  });
  document.getElementById('prog-seg')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (b) progressSeg(b.dataset.v as ProgSeg);
  });
  const obs = new MutationObserver(paintDests);
  document.getElementById('coach-close')!.onclick = () => closeSheet('coach-sheet');
  // the solve report's "Why" (timer/trainer.ts draws it)
  document.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-coach-open]')) openCoach(); });
  for (const id of ['ref-sheet', 'algs-sheet', 'stats-sheet', 'coach-sheet']) obs.observe(document.getElementById(id)!, { attributes: true, attributeFilter: ['hidden'] });
  // keys: 1-6 the picker's rows, ? the help
  document.addEventListener('keydown', (e) => {
    if (sheetOpen() || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= ROWS.length) { pickRow(ROWS[n - 1]!); return; }
    if (e.key === '?') document.getElementById('focus')!.classList.toggle('help');
  });
  // a smart cube or the camera feeding: the typed-moves box goes
  const cubeClass = () => document.body.classList.toggle('has-cube', !!activeSource());
  onSourceChange(cubeClass); cubeClass();
  onTabChange(() => render());
  setInterval(render, 1000); // the chip's summary follows settings changed inside the stages (the pool, start from)
}

// for the headless checks and the console
(window.ZZ as Record<string, unknown>).modes = { select: selectMode, pick: pickRow, current: currentMode, openSetup, openCases, openProgress, openCoach };

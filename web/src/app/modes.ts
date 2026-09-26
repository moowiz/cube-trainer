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
import { activeTab, carriedSolve, closeSheet, onTabChange, openAlgs, openSheet, ownerTab, sheetOpen, showTab, stages, type Tab } from '../shell';
import { stageOf } from '../stage';
import type { SplitStage } from '../timer/splits';
import { mountRail, type CubeView, type Rail } from '../ui/rail';
import { readStored, readStoredJson, writeStored } from '../ui/settings';
import { setFollowRules } from './cubefollow';
import { hold } from './context';
import { activeSource, onSourceChange } from './sources';

type ModeId = 'solve' | 'eo' | 'f2l' | 'f2lll' | 'll' | 'find';
type LLSet = 'ocll' | 'pll';

interface ModeDef {
  id: ModeId;
  name(): string;
  /** the picker's line: from where to where, and what it is about */
  what: string;
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
const eoGoal = (): string => ((readStoredJson('zz-eo-settings') as { goal?: string } | null)?.goal === 'cross' ? 'EOCross' : 'EO');
const f2lKind = (): 'all' | 'picked' => (readStored(F2L_KIND) === 'picked' ? 'picked' : 'all');

const ALL: readonly SplitStage[] = ['eo', 'f2l', 'ocll', 'pll'];
const MODES: readonly ModeDef[] = [
  // DECISION: the Solve mode shows the cube's net on a desktop (room for it beside the timer); on a phone it starts hidden, a tap away
  { id: 'solve', name: () => 'Solve', what: 'scrambled → solved · timed, the stages as splits', range: () => ALL, focus: () => null, home: () => 'solve', view: 'net' },
  { id: 'eo', name: () => eoGoal(), what: 'scrambled → EO or EOCross · plan it, then do it', range: () => ['eo'], focus: () => 'eo', home: () => 'eo', view: 'off' },
  { id: 'f2l', name: () => 'F2L', what: 'cross done → F2L · the pairs, with their cases', range: () => ['f2l'], focus: () => 'f2l', home: () => 'f2l', view: 'off' },
  { id: 'f2lll', name: () => 'F2L → LL', what: 'cross done → solved · then the OCLL and PLL you get', range: () => ['f2l', 'ocll', 'pll'], focus: () => 'f2l', home: () => 'f2l', view: 'off' },
  {
    id: 'll', name: () => (llSet() === 'pll' ? 'PLL' : 'OCLL'), what: 'the case → solved · the cases you pick',
    range: () => { const f = llFrom(); return f === 'pair' ? ['f2l', 'ocll', 'pll'] : f === 'ocll' ? ['ocll', 'pll'] : llSet() === 'ocll' ? ['ocll', 'pll'] : ['pll']; },
    focus: () => llSet(), home: () => llSet(), view: 'off',
  },
  { id: 'find', name: () => 'Find an F2L case', what: 'no scramble: tap where the pieces are', range: () => [], focus: () => 'f2l', home: () => 'f2l', view: 'off' },
];
const modeDef = (id: ModeId): ModeDef => MODES.find((m) => m.id === id)!;
const TAB_NAME: Record<Tab, string> = { solve: 'Solve', eo: 'EOCross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };

let mode: ModeId = 'solve';
let rail: Rail | null = null;
/** The mode you picked. */
function currentMode(): ModeId { return mode; }

/** The mode a stage panel belongs to: the current one when it is one of its panels, else the stage's own. */
function modeForTab(t: Tab): ModeId {
  if (t === 'f2l') return mode === 'f2lll' || mode === 'find' ? mode : 'f2l';
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
  if (mode === 'f2l' || mode === 'f2lll') return f2lKind() === 'picked' ? 'picked cases' : 'all pairs';
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
  document.querySelectorAll<HTMLElement>('#mtabs [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode || (b.dataset.mode === 'f2l' && (mode === 'f2lll' || mode === 'find'))));
  const t = activeTab();
  const home = def.home();
  document.getElementById('focus-title')!.textContent = def.name();
  const sub = document.getElementById('focus-sub')!;
  sub.textContent = t !== home && inMode(t) ? (carriedSolve() ? `coach: ${TAB_NAME[t]}` : `now at ${TAB_NAME[t]}`) : def.what.split(' · ')[1] ?? '';
  // the cube picked up somewhere else (a hand scramble, a scan): its stage is on show, the mode is still yours
  const banner = document.getElementById('focus-banner')!;
  const off = t !== home && !carriedSolve() && !inMode(t);
  banner.hidden = !off;
  if (off) {
    banner.innerHTML = `<span>Following your cube: it is at <b>${TAB_NAME[t]}</b>.</span><button type="button" class="btn" data-go="here">Practise ${TAB_NAME[t]} from here</button><button type="button" class="btn" data-go="back">Back to ${def.name()}</button>`;
  }
}

// ---- the picker ----
function renderPicker(): void {
  const names = ['EOCross', 'F2L', 'OCLL', 'PLL'];
  document.getElementById('mp-list')!.innerHTML = MODES.map((m, i) => {
    const r = m.range(), f = m.focus();
    const strip = m.id === 'find' ? '' : `<div class="mp-strip">${ALL.map((s, k) => `<span class="${!r.includes(s) ? 'out' : s === f || (f === null) ? 'fz' : ''}">${names[k]}</span>`).join('')}</div>`;
    return `<button type="button" class="mp-item${m.id === mode ? ' on' : ''}" data-pick="${m.id}"><kbd>${i + 1}</kbd><b>${m.name()}</b><span class="w">${m.what}</span>${strip}</button>`;
  }).join('');
}

// ---- a mode's settings: the stages' own rows, moved into one sheet ----
function openSetup(): void {
  const sec = mode === 'f2lll' ? 'f2l' : mode;
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
  const k = kind ?? (mode === 'll' ? llSet() : mode === 'f2l' || mode === 'f2lll' || mode === 'find' ? 'f2l' : casesKind);
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
function openProgress(seg?: 'solves' | 'll' | 'f2l'): void {
  closeSheet('ref-sheet'); closeSheet('algs-sheet');
  const s = seg ?? (mode === 'll' ? 'll' : mode === 'f2l' || mode === 'f2lll' ? 'f2l' : 'solves');
  // the Solve tab's Graph opens this sheet and draws the solves
  document.getElementById('tm-graph')?.click();
  progressSeg(s);
}
function progressSeg(s: 'solves' | 'll' | 'f2l'): void {
  document.querySelectorAll<HTMLElement>('#prog-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === s));
  for (const k of ['solves', 'll', 'f2l']) document.getElementById(`prog-${k}`)!.hidden = k !== s;
  // a practice table draws when its fold opens
  const open = (id: string) => { const d = document.getElementById(id) as HTMLDetailsElement | null; if (d) { d.open = false; d.open = true; } };
  if (s === 'll') { open('pll-practice'); open('ocll-practice'); }
  if (s === 'f2l') open('f2lpractice');
}
function dest(d: string): void {
  if (d === 'cases') openCases();
  else if (d === 'progress') openProgress();
  else { closeSheet('ref-sheet'); closeSheet('algs-sheet'); closeSheet('stats-sheet'); closeSheet('modes-sheet'); }
}
/** The bottom nav and the desktop's places light up with the sheet that is open. */
function paintDests(): void {
  const on = !document.getElementById('stats-sheet')!.hidden ? 'progress' : (!document.getElementById('ref-sheet')!.hidden || !document.getElementById('algs-sheet')!.hidden) ? 'cases' : 'practise';
  document.querySelectorAll<HTMLElement>('#bnav [data-dest], .dests [data-dest]').forEach((b) => b.classList.toggle('on', b.dataset.dest === on));
}

export function initModes(): void {
  assembleSetup();
  // the follow opens only the stages inside the mode; a cube picked up and solved goes back to the mode's own
  setFollowRules({ openable: (s) => inMode(s), home: () => modeDef(mode).home() });
  rail = mountRail(document.getElementById('rail')!, {
    owner: () => stages[ownerTab()],
    source: activeSource,
    hold,
    onSource: (cb) => { onSourceChange(cb); },
    range: () => modeDef(mode).range(),
    focus: () => modeDef(mode).focus(),
    bare: () => mode === 'find',
    viewKey: () => mode,
    defaultView: () => (window.matchMedia('(min-width: 900px)').matches ? modeDef(mode).view : 'off'),
    bigClock: () => ownerTab() === 'solve',
    blocked: () => sheetOpen(),
  });

  const want = new URLSearchParams(location.search).get('tab');
  const tabs: readonly string[] = ['solve', 'eo', 'f2l', 'ocll', 'pll'];
  let m = readStored(MODE_KEY) as ModeId | null;
  if (want && tabs.includes(want)) m = modeForTab(want as Tab);
  else if (!m || !MODES.some((d) => d.id === m)) m = modeForTab((readStored('zz-tab') as Tab | null) ?? 'solve');
  // the first case is the one the stage made at mount (or the page address asked for): kept
  selectMode(m, true);

  // the chip, the tabs, the picker
  document.getElementById('mode-chip')!.addEventListener('click', () => { renderPicker(); openSheet('modes-sheet'); });
  document.getElementById('modes-close')!.addEventListener('click', () => closeSheet('modes-sheet'));
  document.getElementById('mp-list')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
    if (!b) return;
    closeSheet('modes-sheet');
    selectMode(b.dataset.pick as ModeId);
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
    if (b) progressSeg(b.dataset.v as 'solves');
  });
  const obs = new MutationObserver(paintDests);
  for (const id of ['ref-sheet', 'algs-sheet', 'stats-sheet']) obs.observe(document.getElementById(id)!, { attributes: true, attributeFilter: ['hidden'] });
  // keys: 1-6 the modes, ? the help
  document.addEventListener('keydown', (e) => {
    if (sheetOpen() || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= MODES.length) { selectMode(MODES[n - 1]!.id); return; }
    if (e.key === '?') document.getElementById('focus')!.classList.toggle('help');
  });
  // a smart cube or the camera feeding: the typed-moves box goes
  const cubeClass = () => document.body.classList.toggle('has-cube', !!activeSource());
  onSourceChange(cubeClass); cubeClass();
  onTabChange(() => render());
  setInterval(render, 1000); // the chip's summary follows settings changed inside the stages (the pool, start from)
}

// for the headless checks and the console
(window.ZZ as Record<string, unknown>).modes = { select: selectMode, current: currentMode, openSetup, openCases, openProgress };

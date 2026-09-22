// Following a solve on the smart cube (the setting "Follow my solve on the
// smart cube", on by default): as the cube crosses into a further ZZ stage
// that stage's tab opens with the cube loaded, the way the camera's follow
// mode does after a lock (scanner-bridge.ts), only with no lock and no
// camera. On the Solve tab it is the tab's own choice (a segment under the
// scramble, "As I solve": stay here / follow into the stages): with
// follow, a timed solve moves the tabs too, and the timer keeps timing
// underneath - its stage stays PINNED in sources.ts so it hears every
// turn, and no tab may load a scramble into it (shell.keepScramble) until
// the cube is solved, when the Solve tab comes back with the time.
//
// The cube's turns are sure and whole, so the follow is by the solve's
// furthest stage (follow.ts SolveFollower): an alg dipping through earlier
// stages never bounces the tabs. A new solve starts when the cube reaches
// the open tab's scramble (the drill arms), or when a pause finds the cube
// behind the mark and off the tab's scramble path - scrambled by hand - in
// which case its state is loaded like a lock.
//
// The trainer-frame scramble for the cube's state is a BASE (a solved
// state's scramble, from cubejs) plus the turns since, exactly as the
// camera's follow does with the lock; the base is refreshed when the cube
// rests, so the scramble the tabs show stays short.

import { SOLVED } from '../cube/state';
import { describeStage, followReport, followScramble, SolveFollower } from '../follow';
import { type ScannedCube } from '../handoff';
import { movesOf, type MoveSource } from '../moves/source';
import { activeTab, keepScramble, onTabChange, shareScramble, showTab, stages, toast, type Tab } from '../shell';
import { type Stage } from '../stage';
import { solveState, warmSolver } from '../state';
import type { TrackStatus } from '../timer/track';
import { makeTrackWatcher } from '../timer/track-ui';
import { persistControls } from '../ui/settings';
import { hold } from './context';
import { cubeActive } from './smart';
import { activeSource, driverArmed, onSourceChange, pinStage, syncDriver } from './sources';
import { readStored, writeStored } from '../ui/settings';

// DECISION: a pause is 15 s without a turn (user, 2026-09-21: at 2 s a think mid-PLL, with the
// cross broken by the alg, flipped the tabs). A hand-scrambled cube takes that long to be picked
// up; a lull mid-solve never is.
const PAUSE_MS = 15_000;
// DECISION: the base is re-solved once the turns since it pass this many and the cube rests
const REBASE_AFTER = 40;

let box: HTMLInputElement | null = null;
let solveSeg: HTMLElement | null = null;   // the Solve tab's own choice
let solveMode: 'stay' | 'follow' = 'follow';
const SOLVE_KEY = 'zz-solve-follow';
let engaged = false;
let timing = false;          // the Solve tab's timer is on a solve this follow carries through the stages
let timingScr: string | null = null; // the Solve tab's scramble that solve is from: a new one (the timer stopped by a tap, New scramble) ends the carry
const follower = new SolveFollower();
let cursor = 0;              // items of the source consumed
let startIndex = 0;          // the item index this solve started at (for the solved toast)
let lastMoveT = 0;           // host time of the last turn consumed, or of the engagement
let base: ScannedCube | null = null;
let baseCursor = 0;          // the item index `base.facelets` is the state at
let solving: string | null = null;  // the state a base is being solved for
let failed: string | null = null;   // the state cubejs refused (a garbage report): not retried until it changes

/** The smart cube's follow is running: the tabs are its to move. */
export function cubeFollowing(): boolean { return engaged; }

// DECISION: the Solve tab follows by default, like the drills; a timer-only sitting is one tap
// away and remembered. The setting under Cube is the master: off, nothing follows anywhere.
const DRILLS: readonly Tab[] = ['eo', 'f2l', 'ocll', 'pll'];
const master = (): boolean => (box?.checked ?? false) && cubeActive();
const wanted = (): boolean => {
  if (!master()) return false;
  const tab = activeTab();
  return tab === 'solve' ? solveMode === 'follow' : DRILLS.includes(tab);
};

/** The timer's solve is being carried through the stages: its tab keeps hearing the turns and keeps its scramble. */
function setTiming(on: boolean): void {
  if (on === timing) return;
  timing = on;
  timingScr = on ? stages.solve?.scramble() ?? null : null;
  pinStage(on ? 'solve' : null);
  keepScramble(on ? 'solve' : null);
}
/** The timer moved on from the solve being carried (stopped by a tap, a new scramble): let its tab go. */
function checkTiming(): void { if (timing && (stages.solve?.scramble() ?? null) !== timingScr) setTiming(false); }

/** The cube's state as the trainer-frame scramble, from the base and the turns since; null without a base. */
function scramble(src: MoveSource): string | null {
  if (!base) return null;
  try { return followScramble(base, movesOf(src.items().slice(baseCursor)), hold()); } catch { return null; }
}

/** A base for the state the source is at now: solved is free, anything else asks cubejs (async). */
function rebase(src: MoveSource): void {
  const state = src.state();
  if (state === null || state === solving || state === failed) return;
  const at = src.items().length;
  const took = (solution: string) => {
    base = { facelets: state, colourOf: src.colourOf, solution };
    baseCursor = at;
    // the first base of a follow: the solve's furthest stage so far is where the cube stands
    if (follower.mark() === null) follower.restart(followReport(scramble(src) ?? '').stage);
  };
  if (state === SOLVED) { took(''); return; }
  solving = state;
  solveState(state).then((solution) => {
    if (solving !== state) return;
    solving = null;
    if (engaged && activeSource() === src) took(solution);
  }, () => { solving = null; failed = state; });
}

const watcher = makeTrackWatcher();
let matchedKey: string | null = null; // the tab's scramble the cube has reached: from there the turns are the solve
/**
 * Where the cube is on the open tab's scramble while it is being applied (a prefix of it, halfway
 * through a double turn, matched, or off); null when there is no scramble, or once it has been
 * matched - the solve of a short drill scramble often retraces it exactly (an alg whose scramble
 * is its own inverse), and those turns are the solve, not an undo.
 */
function pathStatus(src: MoveSource, state: string): TrackStatus | null {
  const tab = activeTab();
  const scr = stages[tab]?.scramble() ?? null;
  if (scr === null) return null;
  const key = `${tab}:${scr}`;
  const status = watcher.status(scr, state, src.colourOf, hold());
  if (key === matchedKey || !status) return null;
  // a followed scramble (base + turns) can hold cancelling turns, so its end is also an earlier prefix: the target is matched all the same
  if (state === watcher.tracker()!.target()) status.matched = true;
  if (status.matched) matchedKey = key;
  return status;
}

/** Open `stage` with the cube's state loaded (the whole tab set gets it), and arm the drill there. */
function open(src: MoveSource, stage: Exclude<Stage, 'solved'>, scr: string, why: string): void {
  console.log(`CUBE FOLLOW ${why}: stage=${stage} ${scr}`); // the trace scripts/check-smart.mjs asserts on
  shareScramble(scr, null);
  showTab(stage);
  syncDriver();
  // the cube is at this tab's scramble already: what follows is the solve
  const state = src.state();
  if (state !== null) pathStatus(src, state);
  toast(describeStage(followReport(scr)));
  window.scrollTo({ top: 0 });
}

function announceSolved(src: MoveSource): void {
  const items = src.items().slice(startIndex);
  const turns = movesOf(items);
  let t0: number | null = null, t1: number | null = null;
  for (const it of items) if (it.kind === 'move') { t0 ??= it.t; t1 = it.t; }
  const secs = t0 !== null && t1 !== null ? ((t1 - t0) / 1000).toFixed(1) : null;
  console.log(`CUBE FOLLOW solved after ${turns.length} turns`);
  toast(`Solved ✓ ${turns.length} turns${secs ? ` in ${secs} s` : ''}`);
}

/**
 * The source's new items: a crossing beyond the mark opens the stage crossed into. Heard after the
 * open stage (sources.ts), so the turn that finishes a stage is judged there before the switch.
 */
function consume(): void {
  const src = activeSource();
  if (!src || !engaged) return;
  const items = src.items();
  let moved = false;
  for (; cursor < items.length; cursor++) {
    const it = items[cursor]!;
    if (it.kind === 'move') { lastMoveT = it.t; moved = true; }
    else if (it.kind === 'resync') { base = null; solving = null; failed = null; follower.restart(null); setTiming(false); }
  }
  // (a solved cube: the timer's stop on this very turn made the new scramble; the solved branch below lets the tab go)
  if (src.state() !== SOLVED) checkTiming();
  if (!base) { rebase(src); return; }
  if (!moved) return;
  const state = src.state();
  const scr = scramble(src);
  if (state === null || scr === null) return;
  // on the open tab's scramble: being applied (not a solve), or reached - a solve starts from here (the drill arms on this same item)
  const path = pathStatus(src, state);
  if (path?.matched) {
    follower.restart(followReport(scr).stage); startIndex = cursor;
    // the Solve tab's scramble reached: the timer armed on this item, and its solve is the one followed
    if (activeTab() === 'solve') setTiming(true);
    return;
  }
  if (path && !path.off) return;
  const next = follower.turned(followReport(scr).stage);
  if (!next) return;
  if (next === 'solved') {
    base = { facelets: SOLVED, colourOf: src.colourOf, solution: '' }; baseCursor = cursor;
    // the timer stopped on this same turn (its stage heard it first): back to it for the time and the next scramble
    if (timing) { setTiming(false); console.log('CUBE FOLLOW solved: back to the Solve tab'); if (activeTab() !== 'solve') { showTab('solve'); window.scrollTo({ top: 0 }); } }
    else announceSolved(src);
    return;
  }
  // the open tab's drill is on this solve from its own scramble and crossed into its own stage (a PLL drill
  // started from OCLL, say): it judges the solve when it is done, and reloading it here would cut the solve in two
  if (next === activeTab() && driverArmed()) return;
  open(src, next, scr, `crossed into ${next}`);
}

/** Every half second: a pause with the cube behind the mark and off the scramble path is a new solve. */
function poll(): void {
  const src = activeSource();
  if (!src || !engaged) return;
  const idle = performance.now() - lastMoveT >= PAUSE_MS;
  checkTiming();
  if (!base) { rebase(src); return; }
  const state = src.state();
  if (state === null || !idle) return;
  // the base kept short while the cube rests
  if (cursor - baseCursor >= REBASE_AFTER && solving === null) rebase(src);
  const scr = scramble(src);
  if (scr === null) return;
  const path = pathStatus(src, state);
  if (path?.matched) { follower.restart(followReport(scr).stage); startIndex = cursor; if (activeTab() === 'solve') setTiming(true); return; }
  if (path && !path.off) return;
  // the Solve tab between solves: a cube off its scramble is a mis-scramble to undo, not a solve to pick up
  if (activeTab() === 'solve' && !timing) return;
  const restart = follower.paused(followReport(scr).stage);
  if (!restart) return;
  startIndex = cursor;
  if (restart === 'solved') return;
  open(src, restart, scr, 'a pause behind the mark');
}

let followed: MoveSource | null = null;
/** The follow engages when the setting is on, the cube is the active source and a drill tab is open; it starts over each time, and with each source. */
function refresh(): void {
  if (solveSeg) solveSeg.parentElement!.hidden = !master();
  const on = wanted();
  const src = on ? activeSource() : null;
  if (on === engaged && src === followed) return;
  engaged = on;
  followed = src;
  setTiming(false);
  if (!src) return;
  cursor = src.items().length;
  startIndex = cursor;
  lastMoveT = performance.now();
  base = null; solving = null; failed = null; matchedKey = null;
  follower.restart(null);
  warmSolver();
  rebase(src);
}

export function initCubeFollow(): void {
  box = document.getElementById('cubefollow') as HTMLInputElement | null;
  if (box) {
    persistControls({ cubefollow: box });
    box.addEventListener('change', refresh);
  }
  solveSeg = document.getElementById('tm-cubefollow');
  if (solveSeg) {
    if (readStored(SOLVE_KEY) === 'stay') solveMode = 'stay';
    const paint = () => solveSeg!.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === solveMode));
    paint();
    solveSeg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
      if (!b) return;
      solveMode = b.dataset.v === 'stay' ? 'stay' : 'follow';
      writeStored(SOLVE_KEY, solveMode);
      paint(); refresh();
    });
  }
  onTabChange(refresh);
  onSourceChange(() => { refresh(); consume(); });
  setInterval(poll, 500);
  refresh();
}

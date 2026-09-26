// The cube rail (docs/ui-redesign.md 6.2 and 6.4): the one column every mode
// shares - the stage strip (the mode's range, where the cube is, the splits),
// the scramble as the owning stage shows it (tracked on the cube, the next
// turn boxed, a wrong turn replaced by its undo in big type, folded to one
// line once the cube is at it), the clock (the same press rule everywhere:
// down arms, up starts, a press stops), the cube as the app believes it (a
// net, 3D, or nothing, per mode), and the tools: New, the voice's switch,
// the view, fingertricks for the scramble.
//
// It owns no logic of the stages: each stage answers `rail()` (what to draw)
// and `press()`; the rail only draws and forwards. The stage it draws is the
// OWNER - the open tab, or the Solve tab while the follow carries its timed
// solve through the stage tabs (shell.ownerTab), so the timer never leaves
// the screen.

import { toWca, WCA_HOLD } from '../cube/frame';
import { STICKERS } from '../cube/geometry';
import { DEFAULT_VIEW, orbit, render3d, renderNet, type Cell, type View } from '../cube/render';
import { faceHex, onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { beliefInTrainer, relabelTurns, type Hold } from '../handoff';
import type { MoveSource } from '../moves/source';
import type { RailView, Stage, Tab } from '../shell';
import { stageOf, type Stage as CubeStage, type StageReport } from '../stage';
import { SPLIT_STAGES, SplitClock, splitText, type SplitStage } from '../timer/splits';
import { formatTime } from '../timer/stats';
import type { TrackStatus } from '../timer/track';
import { moveHtml, shownIndex } from '../timer/track-ui';
import { ensureStyle } from './dom';
import { openFingertricks } from './fingertricks';
import { readStoredJson, writeStored } from './settings';
import { ScrambleVoice } from './voice';

export type CubeView = 'net' | '3d' | 'off';

export interface RailHost {
  /** the stage the rail draws, and its tab */
  owner(): Stage | undefined;
  ownerTab(): Tab;
  /** New: the mode's next case (from anywhere in its stretch, back to where it starts) */
  newCase(): void;
  source(): MoveSource | null;
  hold(): Hold;
  /** every item of the active source, and every change of source */
  onSource(cb: () => void): void;
  /** the stages the mode covers; the rest of the strip is dashed */
  range(): readonly SplitStage[];
  /** the stage the mode is about (underlined on the strip); null: the whole solve */
  focus(): SplitStage | null;
  /** the mode has no scramble and no clock (finding an F2L case by tapping it in) */
  bare(): boolean;
  /** the key the mode's cube view is remembered under, and the view it starts with */
  viewKey(): string;
  defaultView(): CubeView;
  /** the clock is the point of the mode (the Solve mode): drawn large */
  bigClock(): boolean;
  /** a sheet covers the page, or a field has the keys: Space is not the clock's */
  blocked(): boolean;
}

export interface Rail {
  /** redraw now (the mode changed, a new owner) */
  refresh(): void;
}

const STYLE = `
  .rl { display: flex; flex-direction: column; gap: 10px; }
  .rl-strip { display: flex; gap: 3px; }
  .rl-seg { flex: 1; min-width: 0; border-radius: 7px; background: #fff; border: 1px solid var(--line); padding: 4px 6px 3px; font-size: 12px; line-height: 1.2; }
  .rl-seg b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rl-seg span { color: var(--ink-2); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rl-seg.f2l { flex: 1.4; }
  .rl-seg.out { background: transparent; border-style: dashed; color: #8A93A0; }
  .rl-seg.done { background: #E3EFE6; border-color: #A8CFB2; }
  .rl-seg.cur { background: var(--ink); border-color: var(--ink); color: #fff; }
  .rl-seg.cur span { color: #C9D0DA; }
  .rl-seg.fz { box-shadow: inset 0 -3px 0 #E0A100; }
  .rl-pips { display: inline-flex; gap: 3px; margin-left: 5px; vertical-align: 1px; }
  .rl-pips i { width: 7px; height: 7px; border-radius: 2px; border: 1px solid currentColor; opacity: .7; }
  .rl-pips i.on { background: currentColor; opacity: 1; }
  .rl-scr { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: .05em .5em; font-weight: 700; font-size: 28px; line-height: 1.35; letter-spacing: .01em; min-height: 38px; text-align: center; }
  .rl-scr .mv .p { color: #B3261E; font-size: 1.1em; line-height: 1; } .rl-scr .mv .d { color: #1A56B8; }
  .rl-scr .done { color: #9AA3AF; font-weight: 600; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 5px; }
  .rl-scr .done .p, .rl-scr .done .d { color: inherit; }
  .rl-scr .nx { outline: 3px solid #E0A100; outline-offset: 2px; border-radius: 6px; }
  .rl-scr.folded { font-size: 14px; font-weight: 400; color: var(--ink-2); justify-content: flex-start; min-height: 0; gap: 8px; text-align: left; }
  .rl-scr.folded .ok { color: var(--good); font-weight: 600; }
  .rl-scr.folded .rest { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .rl-scr.note { font-size: 14px; font-weight: 400; color: var(--ink-2); min-height: 0; }
  .rl-off { text-align: center; color: #7A4B00; }
  .rl-off .lbl { font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  .rl-off .undo { font-size: 32px; font-weight: 700; display: flex; justify-content: center; align-items: baseline; flex-wrap: wrap; gap: .1em .5em; }
  .rl-line { text-align: center; font-size: 13px; color: var(--ink-2); min-height: 17px; margin-top: -6px; }
  .rl-clock { display: flex; flex-direction: column; align-items: center; border-radius: 14px; padding: 4px 0; cursor: pointer;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .rl-clock.held { background: #DDF3E4; } .rl-clock.held .rl-time, .rl-clock.ready .rl-time { color: var(--good); }
  .rl-time { font-variant-numeric: tabular-nums; font-weight: 300; font-size: 44px; line-height: 1.05; letter-spacing: -.02em; }
  .rl.big .rl-time { font-size: 76px; }
  .rl-hint { font-size: 13px; color: var(--ink-2); min-height: 17px; }
  .rl-cube { display: flex; gap: 10px; align-items: center; justify-content: center; }
  .rl-cube svg { display: block; }
  .rl-cube .c3 { width: 150px; height: 150px; touch-action: none; cursor: grab; }
  .rl-cube .cn { width: 190px; height: auto; }
  .rl-cube polygon, .rl-cube rect { stroke: #2b3340; stroke-width: 1.2; stroke-linejoin: round; }
  .rl-tools { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; align-items: center; }
  .rl-tools button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--ink-2); cursor: pointer; white-space: nowrap; }
  .rl-tools button.pri { background: var(--ink); color: #fff; border-color: var(--ink); font-weight: 600; }
  .rl-tools button.on { color: var(--good); border-color: #8BC34A; background: #E8F5E9; }
  .rl-tools button:hover { border-color: var(--ink-2); }
  .rl.bare .rl-scr, .rl.bare .rl-line, .rl.bare .rl-clock, .rl.bare [data-t="new"], .rl.bare [data-t="voice"], .rl.bare [data-t="tricks"] { display: none; }
  @media (max-width: 899px) {
    .rl { gap: 8px; }
    .rl-scr { font-size: 26px; }
    .rl-time { font-size: 38px; }
    .rl.big .rl-time { font-size: 64px; }
    .rl-cube .c3 { width: 120px; height: 120px; }
    .rl-cube .cn { width: 160px; }
  }
`;

const LABEL: Record<SplitStage, string> = { eo: 'EOCross', f2l: 'F2L', ocll: 'OCLL', pll: 'PLL' };
const RANK: Record<CubeStage, number> = { eo: 0, f2l: 1, ocll: 2, pll: 3, solved: 4 };
const VIEW_KEY = 'zz-rail-view';

export function mountRail(root: HTMLElement, host: RailHost): Rail {
  ensureStyle('rail-style', STYLE);
  root.innerHTML = `
    <div class="rl" id="rail-box">
      <div class="rl-strip" id="rail-strip"></div>
      <div id="rail-scr"></div>
      <div class="rl-line" id="rail-line"></div>
      <div class="rl-clock" id="rail-clock" role="button" aria-label="Timer: press and release to start, press to stop"><div class="rl-time" id="rail-time">0.00</div><div class="rl-hint" id="rail-hint"></div></div>
      <div class="rl-tools">
        <button type="button" class="pri" data-t="new" id="rail-new" title="A new scramble or case (n)">New</button>
        <button type="button" data-t="voice" id="rail-voice"></button>
        <button type="button" data-t="view" id="rail-view" title="The cube as the app believes it: a net, 3D, or hidden"></button>
        <button type="button" data-t="tricks" id="rail-tricks" title="The scramble finger by finger">✋</button>
      </div>
      <div class="rl-cube" id="rail-cube"><svg class="c3" id="rail-3d" viewBox="-170 -170 340 340" aria-label="the cube"></svg><svg class="cn" id="rail-net" aria-label="the cube as a net"></svg></div>
    </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const box = $('rail-box');

  // ---- the cube: as the source believes it, else the owner's scramble ----
  const view3d: View = { ...DEFAULT_VIEW };
  let views = (readStoredJson(VIEW_KEY) as Record<string, CubeView> | null) ?? {};
  const cubeView = (): CubeView => views[host.viewKey()] ?? host.defaultView();
  /** The cube now, in the trainer's letters, and whether it is the cube's own belief. */
  function cubeNow(): { facelets: string; live: boolean } | null {
    const src = host.source();
    const st = src?.state();
    if (src && st) { const f = beliefInTrainer(st, src.colourOf, host.hold()); if (f) return { facelets: f, live: true }; }
    const scr = host.owner()?.scramble() ?? null;
    if (scr === null) return null;
    try { return { facelets: state(scr), live: false }; } catch { return null; }
  }
  let drawnCube = '';
  function drawCube(force = false): void {
    const v = cubeView();
    const now = cubeNow();
    $('rail-cube').hidden = v === 'off' || !now;
    $('rail-view').textContent = v === 'off' ? 'cube: hidden' : v === '3d' ? 'cube: 3D' : 'cube: net';
    if (v === 'off' || !now) return;
    const sig = `${v}|${now.facelets}|${view3d.rx},${view3d.ry}`;
    if (sig === drawnCube && !force) return;
    drawnCube = sig;
    const cells: Cell[] = STICKERS.map((s) => ({ fill: faceHex(now.facelets[s.idx]!) }));
    ($('rail-3d') as HTMLElement).style.display = v === '3d' ? '' : 'none';
    ($('rail-net') as HTMLElement).style.display = v === 'net' ? '' : 'none';
    if (v === '3d') render3d($('rail-3d') as unknown as SVGSVGElement, cells, view3d);
    else renderNet($('rail-net') as unknown as SVGSVGElement, cells);
  }
  orbit($('rail-3d') as unknown as SVGSVGElement, view3d, () => drawCube(true));
  $('rail-view').addEventListener('click', () => {
    const order: CubeView[] = ['net', '3d', 'off'];
    views = { ...views, [host.viewKey()]: order[(order.indexOf(cubeView()) + 1) % order.length]! };
    writeStored(VIEW_KEY, JSON.stringify(views));
    drawCube(true);
  });

  // ---- the strip: the range, where the cube is, and the attempt's splits ----
  // `carried`: a stretch went on past one stage's clock into the next stage's, so the clock shown is the attempt's own;
  // `between`: one stage's clock has stopped and the next one's has not started yet
  let attempt: { t0: number; clock: SplitClock; done: boolean; total: number | null; carried: boolean; between: boolean } | null = null;
  let lastPhase: RailView['clock']['phase'] = 'idle';
  function reportNow(): StageReport | null {
    const now = cubeNow();
    try { return now ? stageOf(now.facelets) : null; } catch { return null; }
  }
  function drawStrip(): void {
    const range = host.range(), focus = host.focus();
    const rep = reportNow();
    const splits = attempt?.clock.splits() ?? {};
    const cur: CubeStage | null = attempt && !attempt.done ? attempt.clock.current() : rep?.stage ?? null;
    const curRank = cur ? RANK[cur] : -1;
    $('rail-strip').innerHTML = SPLIT_STAGES.map((s) => {
      const r = RANK[s];
      const split = splits[s];
      const out = !range.includes(s);
      const cls = ['rl-seg', s, out ? 'out' : '', split !== undefined ? 'done' : r === curRank ? 'cur' : r < curRank && !out ? 'done' : '', s === focus ? 'fz' : ''].filter(Boolean).join(' ');
      let sub = '';
      if (split !== undefined) sub = split === 0 ? 'skip' : splitText(split);
      else if (s === 'f2l' && rep && r === curRank) sub = `<span class="rl-pips">${[0, 1, 2, 3].map((i) => `<i class="${i < rep.pairs ? 'on' : ''}"></i>`).join('')}</span>`;
      return `<div class="${cls}"><b>${LABEL[s]}</b><span>${sub || '&nbsp;'}</span></div>`;
    }).join('');
  }
  /**
   * The attempt follows the owner's clock: it starts when the clock does (the cube's first turn, a press),
   * ends when it stops, and a new scramble clears the last one's splits. Inside a stretch (EOCross on to solved)
   * a stage's clock stopping on the turn that finished that stage carries the attempt on into the next stage's,
   * so the splits and the time run on to where the stretch stops. Checked on every item (`turnT`: its host time)
   * and every frame.
   */
  // the stage before the latest turn: an attempt starts from where the cube was when the clock was armed, not
  // after its first turn (a PLL alg's first R breaks the cross, which would read as a start at EOCross)
  let before: StageReport | null = null;
  let lastOwner: Tab | null = null;
  function syncAttempt(v: RailView, turnT?: number): boolean {
    const applying = !!v.track && v.track.applied > 0 && !v.track.matched && !v.track.off;
    // the last attempt's splits stay up (the result) until the next scramble is being applied, or the next attempt starts
    if (attempt?.done && applying) attempt = null;
    // (a stretch between two stages is not dropped on that: a stage just opened reads the first turn of its alg as
    // the start of its own scramble at times, the scramble's last double turn half undone; New and a mode drop it)
    const owner = host.ownerTab(), switched = lastOwner !== null && owner !== lastOwner;
    const live = !!attempt && !attempt.done;
    // the stage armed at its scramble before this turn started on it - and perhaps finished, or handed the cube on
    const startedOnTurn = turnT !== undefined && lastPhase === 'ready' && (v.clock.phase !== 'ready' || switched);
    if (!live && ((v.clock.phase === 'running' && (lastPhase !== 'running' || !attempt)) || startedOnTurn)) {
      const rep = before ?? reportNow();
      const t0 = startedOnTurn && turnT !== undefined ? turnT : performance.now() - (v.clock.ms ?? 0);
      attempt = { t0, clock: new SplitClock(rep && rep.stage !== 'solved' ? rep.stage : 'eo'), done: false, total: null, carried: false, between: false };
    } else if (live && attempt!.between && v.clock.phase === 'running') attempt!.between = false;
    let ended = false;
    const end = (total: number | null) => {
      const a = attempt!, rep = reportNow();
      a.done = true;
      a.total = total;
      if (rep && total !== null) a.clock.turned(rep.stage, total);
      ended = true;
    };
    const rep = reportNow();
    const range = host.range(), last = range[range.length - 1];
    if (attempt && !attempt.done && attempt.carried && turnT !== undefined && rep && (rep.stage === 'solved' || !range.includes(rep.stage))) {
      // a stretch runs on the cube: it ends on the turn that takes the cube past it, whatever the stage's own clock did
      end(turnT - attempt.t0);
    } else if (attempt && !attempt.done && !attempt.between && v.clock.phase !== 'running' && (lastPhase === 'running' || startedOnTurn)) {
      // the clock stopped. On a turn, with the cube still inside the mode's stretch: on into the next stage, if that
      // turn finished one (F2L done, on to OCLL) or the stage whose clock stopped is not the stretch's last (EO alone
      // done, the cross still to do). A press, the cube past the stretch or solved, the Solve's own clock: the end.
      const stopped = switched ? lastOwner! : owner;
      const onward = turnT !== undefined && !!host.source() && !!rep && rep.stage !== 'solved' && owner !== 'solve' && range.includes(rep.stage)
        && ((!!before && RANK[rep.stage] > RANK[before.stage]) || (!!last && stopped !== 'solve' && RANK[stopped] < RANK[last]));
      if (onward) { attempt.carried = true; attempt.between = true; }
      else end(attempt.carried ? (turnT ?? performance.now()) - attempt.t0 : v.clock.ms);
    }
    lastPhase = v.clock.phase;
    lastOwner = owner;
    return ended;
  }
  /** The clock the rail shows: the owner's, or a carried stretch's own (from its first turn, through every stage so far). */
  function shownClock(v: RailView): RailView['clock'] {
    if (!attempt?.carried) return v.clock;
    return attempt.done ? { ms: attempt.total, phase: 'idle' } : { ms: performance.now() - attempt.t0, phase: 'running' };
  }
  // a crossing is timed by the turn that made it (the source's host time), not by the next frame
  host.onSource(() => {
    const src = host.source();
    const it = src?.items().at(-1);
    const t = it?.kind === 'move' ? it.t : performance.now();
    const v = host.owner()?.rail?.();
    if (v) { syncAttempt(v, t); noteUsed(v); noteOff(v, src, it?.kind === 'move' ? it.move : undefined); }
    if (attempt && !attempt.done && src) {
      const rep = reportNow();
      if (rep) attempt.clock.turned(rep.stage, Math.max(0, t - attempt.t0));
    }
    before = reportNow();
    drawCube();
    drawStrip();
  });

  // ---- the scramble ----
  // a scramble the cube has reached is used: the turns after it are the attempt, never "off the scramble", also once
  // its clock has stopped (EOCross done, the cube left there) - until the cube is back at the scramble's start (solved:
  // the same scramble again) or the scramble changes
  let usedKey: string | null = null;
  function noteUsed(v: RailView): void {
    const key = v.toks ? `${host.ownerTab()}|${v.toks.join(' ')}` : null;
    const t = v.track;
    if (key !== null && (t?.matched || v.clock.phase === 'ready' || v.clock.phase === 'running')) usedKey = key;
    else if (key !== null && key === usedKey && t && t.applied === 0 && !t.half && !t.off) usedKey = null;
  }
  // the wrong turns since the cube left the scramble, for a stage that does not keep them itself (EO, F2L: the Solve
  // and the last layer say theirs, `offText`): the scramble voice's own list, silent, in the letters the scramble is
  // shown in - so the undo is always the turns to make, not "back to the underline" (user, 2026-09-26)
  const offVoice = new ScrambleVoice({ mode: () => 'off', shown: () => ({ toks: [] }), wca: (alg) => toWca(alg).trim() });
  let offKey: string | null = null, offWas: TrackStatus | null = null;
  function noteOff(v: RailView, src: MoveSource | null, move: Parameters<typeof relabelTurns>[1][number] | undefined): void {
    const key = v.toks ? `${host.ownerTab()}|${v.toks.join(' ')}` : null;
    if (key !== offKey) { offVoice.reset(); offKey = key; offWas = null; }
    let turn: string | undefined;
    if (move !== undefined && src) { try { turn = relabelTurns(src.colourOf, [move], host.hold()); } catch { turn = undefined; } }
    offVoice.update(offWas, v.track, turn, key !== null && key === usedKey);
    offWas = v.track;
  }
  let drawnScr = '';
  function drawScramble(v: RailView): void {
    const el = $('rail-scr'), line = $('rail-line');
    let html: string, cls = 'rl-scr', ln = '';
    const t = v.track;
    const used = !!v.toks && usedKey === `${host.ownerTab()}|${v.toks.join(' ')}`;
    if (v.note && !v.toks) { cls += ' note'; html = v.note; }
    else if (!v.toks) html = '';
    // at the scramble, or past it: the turns now are the solve, never "off the scramble" (the tracker keeps judging them)
    else if (used || t?.matched || v.clock.phase === 'ready' || v.clock.phase === 'running') {
      cls += ' folded';
      html = `<span class="ok">✓ scrambled</span><span class="rest">${v.toks.length} turns · ${v.toks.slice(0, 8).join(' ')}${v.toks.length > 8 ? ' …' : ''}</span>`;
    } else if (t?.off) {
      // the undo, big: what the voice says, read from its line ("... undo with U' R'"), or back to the underline
      const undo = /undo with (.+)$/.exec(v.offText ?? offVoice.offText() ?? '')?.[1];
      html = undo
        ? `<div class="rl-off"><div class="lbl">Off the scramble · undo</div><div class="undo">${undo.split(/\s+/).map((m) => moveHtml(m.replace('′', "'"))).join(' ')}</div></div>`
        : `<div class="rl-off"><div class="lbl">Off the scramble · undo back to the underline</div></div>`;
      html += `<div class="rl-scr" style="font-size:16px;margin-top:4px">${v.toks.map((m, j) => `<span class="${t && j < shownIndex(v.spans, t.applied) ? 'done' : ''}">${moveHtml(m)}</span>`).join(' ')}</div>`;
      cls = '';
    } else {
      const k = t ? shownIndex(v.spans, t.applied) : -1;
      html = v.toks.map((m, j) => `<span class="${t && j < k ? 'done' : ''}${t && j === k && !t.half && t.applied > 0 ? ' nx' : ''}">${moveHtml(m)}</span>`).join('');
      if (t) ln = t.half ? `${t.applied} of ${t.total} · halfway through ${v.toks[k] ?? ''}` : t.applied ? `${t.applied} of ${t.total} applied` : '';
    }
    const sig = `${cls}|${html}|${ln}`;
    if (sig === drawnScr) return;
    drawnScr = sig;
    el.className = cls;
    el.innerHTML = html;
    line.textContent = ln;
  }

  // ---- the clock ----
  function drawClock(v: RailView): void {
    const c = v.clock;
    const el = $('rail-clock');
    el.className = `rl-clock${c.phase === 'held' ? ' held' : c.phase === 'ready' ? ' ready' : ''}`;
    $('rail-time').textContent = c.phase === 'held' ? '0.00' : c.phase === 'ready' ? 'ready' : c.phase === 'running' ? formatTime(c.ms ?? 0, 1) : c.ms === null ? '0.00' : formatTime(c.ms);
    const cube = !!host.source();
    $('rail-hint').textContent = c.phase === 'held' ? 'release to start'
      : c.phase === 'ready' ? 'the first turn starts it'
      : c.phase === 'running' ? (cube ? '' : 'press to stop')
      : cube ? '' : 'press (or Space) and release to start';
  }
  const pad = $('rail-clock');
  pad.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    try { pad.setPointerCapture(ev.pointerId); } catch { /* a synthetic event */ }
    host.owner()?.press?.(true);
  });
  pad.addEventListener('pointerup', (ev) => { ev.preventDefault(); host.owner()?.press?.(false); });
  pad.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Space: the same rule on every stage (docs/ui-redesign.md 10.3) - down arms or stops, up starts
  const keyable = (ev: KeyboardEvent) => !host.blocked() && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((ev.target as HTMLElement).tagName) && !host.bare();
  document.addEventListener('keydown', (ev) => { if (ev.key !== ' ' || !keyable(ev)) return; ev.preventDefault(); if (!ev.repeat) host.owner()?.press?.(true); });
  document.addEventListener('keyup', (ev) => { if (ev.key !== ' ' || !keyable(ev)) return; ev.preventDefault(); host.owner()?.press?.(false); });

  // ---- tools ----
  $('rail-new').addEventListener('click', () => { if (attempt && !attempt.done) attempt = null; host.newCase(); });
  $('rail-voice').addEventListener('click', () => { host.owner()?.voice?.()?.toggle(); tick(true); });
  $('rail-tricks').addEventListener('click', () => {
    const v = host.owner()?.rail?.();
    if (v?.toks?.length) openFingertricks(v.toks.join(' ').replace(/′/g, "'"), { title: 'The scramble', hold: WCA_HOLD });
  });

  // ---- the loop: the clock every frame while it runs, the rest a few times a second ----
  let lastSlow = 0;
  function tick(force = false): void {
    const owner = host.owner();
    const v: RailView = owner?.rail?.() ?? { toks: null, track: null, clock: { ms: null, phase: 'idle' } };
    const now = performance.now();
    if (syncAttempt(v)) force = true;
    noteUsed(v);
    drawClock({ ...v, clock: shownClock(v) });
    if (force || now - lastSlow > 150) {
      lastSlow = now;
      box.classList.toggle('big', host.bigClock());
      box.classList.toggle('bare', host.bare());
      drawScramble(v);
      const vo = owner?.voice?.();
      $('rail-voice').hidden = !vo;
      if (vo) { $('rail-voice').textContent = vo.on ? '🔊 voice on' : '🔈 voice off'; $('rail-voice').title = vo.label; $('rail-voice').classList.toggle('on', vo.on); }
      $('rail-tricks').hidden = !v.toks?.length;
      drawStrip();
      drawCube();
    }
  }
  const loop = () => { tick(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  onSchemeChange(() => drawCube(true));
  return { refresh: () => { drawnScr = ''; if (attempt?.done || attempt?.carried) attempt = null; tick(true); drawCube(true); } };
}

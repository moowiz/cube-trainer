// The last-layer drill, mounted twice: once as the OCLL tab, once as PLL.
// A case (random, or a cube handed over by a scan or the previous stage),
// the top-down last-layer diagram in the trainer's colour scheme, and the
// standard alg with its AUFs in brackets. The drill scaffold owns timer, box,
// result, keys - quiet here (2026-09-21: no hint chips, no moves box, no
// timer buttons, the timer small): the moves come from the smart cube, the
// case is named by the result or the voice, and the alg is a tap away.
//
// Five settings, inline under the case list button, kept per drill: where the drill
// starts (its own stage, or the step before - the corners to orient, the
// last pair to insert - so the case has to be recognised after solving that
// your own way, as in a solve), whether the alg shows as soon as the case
// does (learning the alg rather than the recognition), whether a solved
// case brings the next one by itself (back to back on a smart cube: solve,
// scramble along the underline, solve), a voice (speech synthesis) that
// either says each move as the cube makes it or reads the next move of the
// alg on show - eyes on the cube, not the screen, while an alg is learnt -
// (each named chunk by its name or move by move, a list of ticks),
// and which cases New case draws from (the ones being learnt; with an
// earlier start the case that comes up is still whatever the step before
// leaves). And a tick under the picture that hides it (2026-09-23): the
// case by the cube in hand alone.
//
// The picture is the cube in 3D, seen from above (the last layer is what
// matters, the sides show the case's bars and headlights), turned to the open
// slot when a pair is out; with F2L solved the top-down diagram sits under
// it, arrows and all. The scramble is a short face-turn sequence for the
// state (not an alg backwards, which would give the case away) and is
// followed on a smart cube like the Solve tab's: turns done are underlined.

import { faceMoves, inverse, mergeMoves, moveCount, movesStr, tokens } from '../cube/alg';
import { fromWca, toWca } from '../cube/frame';
import { STICKERS } from '../cube/geometry';
import { DEFAULT_VIEW, orbit, render3d, type View } from '../cube/render';
import { faceHex, onSchemeChange } from '../cube/scheme';
import { CENTRE, faceTurns, rawFacelets, state } from '../cube/state';
import { hold } from '../app/context';
import { activeSource, onSourceChange, syncDriver } from '../app/sources';
import { SLOTS, slotSolved } from '../f2l/model';
import { trainerScramble } from '../handoff';
import { stageOf } from '../stage';
import { onTabChange, shareScramble, showTab, type Stage, stages } from '../shell';
import type { TrackStatus } from '../timer/track';
import { makeTrackWatcher, moveHtml, scrambleHtml, trackText } from '../timer/track-ui';
import type { ColorName } from '../types';
import { frameMap, relabel, type FaceId } from '../cube/frame';
import { mountDrill, readAttempts } from '../ui/drill';
import { chunkList, triggers } from '../ui/fingertricks';
import { CASES, families, type LLCase, type LLKind } from './cases';
import { aufToSolve, done, drawCase, fitAlg, type LLStart, PLL_SCRAMBLE, randomSetup, type RouteStep, route, scrambleFor, solution, splitAt, START_LABEL, STARTS, stepMoves, stepPlain, stepShown, trimAuf } from './model';
import { algAngle } from './features';
import { onFavsChange } from './favs';
import { noteFor, onNotesChange } from './notes';
import { GIVE_UP_WORDS, heardCase, wordsFor } from './hear';
import { ensurePicStyle, picSvg } from './pic';
import { solveAny } from './scramble';
import { caseStats, DEFAULT_DIR, RECENT, secs, SORT_KEYS, sortStats, type SortKey, trendText, workOn } from './practice';
import { AVG_N, caseLines, MIN_N, mountCaseGraph } from './practicegraph';
import { dayOf } from '../timer/when';
import { chainSummary, openLLReference } from './reference';
import { ensureStyle } from '../ui/dom';
import { persisted } from '../ui/settings';

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };
const BLURB: Record<LLKind, string> = {
  ocll: 'Orient the last layer’s corners. After EO the edges are already oriented, so there are 7 cases.',
  pll: 'Permute the last layer: 21 cases. Finish with the AUF so the cube is solved.',
};

const STYLE = `
  .ll-3d { max-width: 250px; }
  .ll-pic { max-width: 180px; margin: 6px auto 0; }
  .ll-3d[hidden] + .ll-pic { margin-top: 0; }
  .ll-showpic { display: block; text-align: center; margin: 4px auto 0; font-size: 12px; color: var(--ink-2); }
  .ll-showpic input { vertical-align: -2px; margin-right: 3px; }
  .ll-scr .done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .ll-scr .mv .p { color: #B3261E; font-weight: 600; } .ll-scr .mv .d { color: #1A56B8; font-weight: 600; }
  .ll-scr .done .p, .ll-scr .done .d { color: inherit; font-weight: 400; }
  .ll-track { font-size: 13px; color: var(--ink-2); padding: 0 4px 6px; min-height: 18px; }
  .ll-track.off, .ll-off { color: #7A4B00; font-weight: 600; }
  .ll-off { font-size: 14px; margin: 4px 0 8px; } .ll-off .mv { padding: 0 2px; }
  .ll-case { font-size: 16px; min-height: 22px; }
  .ll-trig { display: inline-block; position: relative; padding: 0 2px 13px; margin: 0 2px; border-bottom: 2px solid var(--ink-2); line-height: 1.3; }
  .ll-trig i { position: absolute; left: 0; right: 0; bottom: -1px; font-size: 11px; font-style: normal; line-height: 1; text-align: center; white-space: nowrap; color: var(--ink-2); word-spacing: normal; letter-spacing: .02em; }
  .ll-case b { font-weight: 600; }
  .ll-opts { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; margin: 0 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-opts label { display: inline-flex; align-items: center; gap: 6px; }
  .ll-voice { display: inline-flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
  .ll-opts select { font: inherit; font-size: 13px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
  .ll-step { font-size: 13px; color: var(--ink-2); margin-top: 10px; } .ll-step b { color: var(--ink); font-weight: 600; }
  .eo-result .ll-alg { margin: 4px 0 8px; line-height: 1.9; }
  .eo-result .ll-alg .eo-apply { float: right; margin: 4px 0 0 8px; }
  .eo-result .ll-alg small { clear: both; }
  .ll-note { margin: 4px 0 0; padding: 6px 9px; background: #FFFDF2; border: 1px solid #E4D9A8; border-radius: 8px; font-size: 13px; color: var(--ink); line-height: 1.45; word-spacing: normal; white-space: pre-wrap; }
  .ll-alts { margin-top: 10px; font-size: 13px; color: var(--ink-2); }
  .ll-alts summary { cursor: pointer; }
  .ll-alts .ll-step { margin-top: 8px; }
  .eo-result .ll-alg .mv.done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .eo-result .ll-alg .mv.half { text-decoration: underline dotted; text-underline-offset: 4px; }
  .ll-chunks { margin: -4px 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-chunks summary { cursor: pointer; }
  .ll-chunks p { margin: 6px 0 4px; }
  .ll-chunks label { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; }
  .ll-chunks label b { color: var(--ink); font-weight: 600; white-space: nowrap; }
  .ll-chunks label span { word-spacing: .2em; }
  .ll-chunks .row { display: flex; gap: 10px; margin-top: 6px; }
  .ll-say { margin: -4px 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-say summary { cursor: pointer; }
  .ll-say div { margin-top: 6px; line-height: 1.5; } .ll-say p { margin: 4px 0; }
  .ll-say table { border-collapse: collapse; margin: 4px 0 8px; }
  .ll-say th { text-align: left; color: var(--ink); font-weight: 600; padding: 1px 12px 1px 2px; vertical-align: top; }
  .ll-say td { padding: 1px 2px; }
  .ll-cases { margin: 0 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-cases summary { cursor: pointer; }
  .ll-caselist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .ll-caselist .eo-chip { padding: 4px 9px; }
  .ll-caselist .eo-chip.on { color: var(--bg); background: var(--ink); border-color: var(--ink); }
  .ll-caselist .eo-link { padding: 2px 4px; font-size: 13px; }
  .ll-fams { flex-basis: 100%; margin-top: 2px; } .ll-fams .eo-link { padding: 2px 5px; }
  .ll-pairs, .ll-solo { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .ll-pairs { flex-basis: 100%; }
  .ll-pair { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border: 1px dashed var(--line); border-radius: 999px; }
  .ll-pair i { font-style: normal; font-size: 12px; color: var(--ink-2); }
  .ll-caselist .eo-chip.mate { border-color: #C8930A; color: #7A4B00; background: #FFF6DE; }
  .ll-practice { margin: 0 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-practice summary { cursor: pointer; }
  .ll-practice table { border-collapse: collapse; margin-top: 8px; font-variant-numeric: tabular-nums; width: 100%; }
  .ll-practice th, .ll-practice td { text-align: right; padding: 3px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .ll-practice th:first-child, .ll-practice td:first-child { text-align: left; }
  .ll-practice th { font-weight: 500; }
  .ll-practice td.name { color: var(--ink); font-weight: 600; }
  .ll-practice tr.dim td { color: var(--ink-2); opacity: .7; }
  .ll-practice .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .ll-practice .note { margin-top: 6px; }
  .ll-practice .ll-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .ll-practice th button { font: inherit; background: none; border: none; padding: 0; color: inherit; cursor: pointer; white-space: nowrap; }
  .ll-practice th button.on { color: var(--ink); font-weight: 600; }
  .ll-practice td.name button { font: inherit; font-weight: 600; background: none; border: none; padding: 0; color: var(--ink); cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
  .ll-practice td.faster { color: #1A7F4B; } .ll-practice td.slower { color: #B3261E; }
  .ll-graph { margin-top: 12px; }
  .ll-graph .n { color: var(--ink-2); }
`;

/** `cases`: the ids New case draws from; absent means all of them. `repeat`: the algs over and over, no scramble. */
/** `spell`: the chunk labels the voice reads move by move instead of naming (the rest are named). */
interface Settings {
  from: LLStart; auto: boolean; next: boolean;
  /** what the voice does with the scramble and with the alg */
  say: { scramble: Mode; alg: Mode };
  /** ask the case before the alg (the recognition quiz) */
  ask: boolean;
  spell: string[]; alts: boolean; repeat: boolean; cases?: string[];
  /** the cube picture (the diagram or the 3D cube) on show; off, the case is only what the cube in hand says */
  pic: boolean;
  /** the one dropdown this replaced (2026-09-23), read once and dropped */
  voice?: string;
}
/**
 * What the voice does with a set of moves - the scramble, or the alg (user, 2026-09-23: the two are the
 * same job, so they take the same modes and are set separately). Every mode but 'off' calls a wrong turn.
 */
type Mode = 'off' | 'read' | 'echo' | 'watch';
const MODE_LABEL: Record<Mode, string> = {
  off: 'nothing',
  read: 'reads me the next move',
  echo: 'says the moves I make',
  watch: 'only when I go wrong',
};
const MODES = Object.keys(MODE_LABEL) as Mode[];
/**
 * The words the quiz's ear takes (hear.ts), by letter, for the note by the voice setting: the case's
 * letter, then a/b/c/d; any word listed for a letter says it, and a surrender ends the wait.
 */
function sayNote(kind: LLKind): string {
  const letters = [...new Set(CASES[kind].map((c) => c.id[0]!))].sort();
  const row = (l: string) => `<tr><th>${l}</th><td>${wordsFor(l).join(', ')}</td></tr>`;
  return `<p>Say the letter, then a/b/c/d if it has one: “G alpha”, “J bravo”, “N a”, “T perm”. The letter as itself, or any of these:</p>
    <table><tbody>${letters.map(row).join('')}</tbody></table>
    <p>The variant:</p><table><tbody>${['A', 'B', 'C', 'D'].map(row).join('')}</tbody></table>
    <p>Or ${GIVE_UP_WORDS.map((w) => `“${w}”`).join(', ')} to hear it.</p>
    <p>Without a smart cube: scramble by hand, say “ready” to be asked, and “next” for the next case.</p>`;
}


// ---- hearing the case's name (the quiz): the browser's speech recognition, which on Android Chrome is Google's
// servers - the one thing here that leaves the phone; an opt-in by the setting (user, 2026-09-21) ----
interface Recognizer { lang: string; continuous: boolean; maxAlternatives: number; interimResults: boolean; start(): void; abort(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
const recognizerCtor = (): (new () => Recognizer) | null => { const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer }; return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null; };
// what the voice says for a move: the letter, then prime / two; a wide move and a rotation by name
const SPOKEN: Record<string, string> = { x: 'x', y: 'y', z: 'z', M: 'M', E: 'E', S: 'S' };
function spoken(m: string): string {
  const base = m[0]!, suf = m.slice(1);
  const name = SPOKEN[base] ?? (base === base.toLowerCase() ? `wide ${base.toUpperCase()}` : base);
  return `${name}${suf === "'" ? ' prime' : suf === '2' ? ' two' : ''}`;
}
/** A case name as the voice should say it: the PLL ids letter by letter ("N A", not "nah"), the OCLL names as words. */
const spokenName = (kind: LLKind, c: { id: string; name: string }): string => (kind === 'pll' ? `${c.id.split('').join(' ')} perm` : c.name);
/** Wrong turns as a list to undo: same-face turns merged (R F F' is just R), so an undo shortens it. */
function offList(turns: readonly string[]): string[] {
  const fm = faceMoves(turns.join(' '));
  return fm ? movesStr(mergeMoves(fm)).split(' ').filter(Boolean) : turns.slice();
}
/**
 * A chunk label as words: the move letters in it said as moves ("sexy R prime in F"); a commutator
 * [A, B] as "commutator A, with B" (A, B, A undone, B undone); a conjugate Y [X] Y' as "Y, then X,
 * then Y prime", so the first move is always said.
 */
function spokenLabel(label: string): string {
  const moves = (t: string) => t.trim().split(/\s+/).filter(Boolean).map((w) => (/^[URFDLBMESxyzurfdlb][2']?$/.test(w) ? spoken(w) : w)).join(', ');
  const m = /^(.*?)\[([^\]]+)\](.*)$/.exec(label);
  if (!m) return moves(label).replace(/, /g, ' ');
  const before = m[1]!.trim(), inner = m[2]!, after = m[3]!.trim();
  if (inner.includes(',')) {
    const [a, b] = inner.split(',');
    return `${before ? `${moves(before)}, then ` : ''}commutator ${moves(a!)}, with ${moves(b!)}${after ? `, then ${moves(after)}` : ''}`;
  }
  return `${before ? `${moves(before)}, then ` : ''}${moves(inner)}${after ? `, then ${moves(after)}` : ''}`;
}
/** Speak; `keep` queues it after what is being said instead of cutting that off; `then` runs once it has been said (or after `thenBy` ms if the browser never says so). */
function say(text: string, keep = false, then?: () => void, thenBy = 8000): void {
  if (typeof speechSynthesis === 'undefined') { then?.(); return; }
  if (!keep) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.2; u.lang = 'en-US';
  if (then) {
    let fired = false;
    const once = () => { if (fired) return; fired = true; then(); };
    u.onend = once; u.onerror = once;
    setTimeout(once, thenBy);
  }
  speechSynthesis.speak(u);
}
// DECISION: the result stays up this long before the next case replaces it (the time and the case's name)
const NEXT_AFTER_MS = 1500;

export function mountLL(root: HTMLElement, kind: LLKind): Stage {
  ensureStyle('ll-style', STYLE);
  ensurePicStyle();
  const id = (n: string) => `${kind}-${n}`;
  const SETTINGS_KEY = `zz-${kind}-settings`;
  let migrated = false;
  const { settings, save: saveSettings } = persisted<Settings>(SETTINGS_KEY, { from: kind, auto: false, next: false, say: { scramble: 'off', alg: 'off' }, ask: false, spell: [], alts: false, repeat: false, pic: true }, (st) => {
    if (!STARTS[kind].includes(st.from)) st.from = kind;
    if (st.cases && !Array.isArray(st.cases)) st.cases = undefined;
    if (!Array.isArray(st.spell)) st.spell = [];
    // the single voice setting this replaced: off / echo / read / watch / quiz / quizwatch
    if (st.voice) {
      const v = st.voice;
      st.say = { scramble: v === 'off' ? 'off' : 'watch', alg: v === 'echo' ? 'echo' : v === 'read' || v === 'quiz' ? 'read' : v === 'off' ? 'off' : 'watch' };
      st.ask = v === 'quiz' || v === 'quizwatch';
      delete st.voice;
      migrated = true;
    }
    if (!st.say || !MODES.includes(st.say.scramble) || !MODES.includes(st.say.alg)) st.say = { scramble: 'off', alg: 'off' };
    st.ask = !!st.ask;
    st.pic = st.pic !== false;
  });
  if (migrated) saveSettings(); // the old shape is not left behind to be read again
  /** Anything spoken at all: the tail of a case (its name, the time) belongs to whichever set is on. */
  const speaks = () => settings.say.scramble !== 'off' || settings.say.alg !== 'off';
  const drill = mountDrill(root, {
    id: kind, stage: kind, title: TITLE[kind], blurb: BLURB[kind], newLabel: 'New case',
    quiet: true, showLabel: 'Show the alg',
    afterHints: `
      <div class="ll-opts">
        <label>Start from <select id="${id('from')}">${STARTS[kind].map((f) => `<option value="${f}">${START_LABEL[f]}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="${id('auto')}"> Show the alg once I start (or answer)</label>
        <label><input type="checkbox" id="${id('chain')}"> Next case when solved</label>
        <label title="The algs of the cases in the drill, one after another, from wherever the cube is: no scramble, the alg on show, wrong turns called"><input type="checkbox" id="${id('repeat')}"> Repeat the algs (no scramble)</label>
        <span class="ll-voice">Voice ·
          <label>scramble <select id="${id('vscr')}">${MODES.map((m) => `<option value="${m}">${MODE_LABEL[m]}</option>`).join('')}</select></label>
          <label>alg <select id="${id('valg')}">${MODES.map((m) => `<option value="${m}">${MODE_LABEL[m]}</option>`).join('')}</select></label>
          <label title="The case is asked out loud before the alg; say its name, or give up"><input type="checkbox" id="${id('ask')}"> ask me the case</label>
        </span>
      </div>
      <details class="ll-chunks" id="${id('chunks')}"><summary>Chunks the voice names: <span id="${id('chunksN')}"></span></summary><div id="${id('chunklist')}"></div></details>
      <details class="ll-say" id="${id('say')}" hidden><summary>What to say when asked the case</summary><div>${sayNote(kind)}</div></details>
      <details class="ll-cases" id="${id('cases')}"><summary>Cases in the drill: <span id="${id('casesN')}"></span></summary><div class="ll-caselist" id="${id('caselist')}"></div></details>
      <details class="ll-practice" id="${id('practice')}"><summary>Practice so far: what to work on</summary><div id="${id('practiceBody')}"></div>
        <div class="ll-graph" id="${id('practiceGraphWrap')}" hidden><div class="n" id="${id('practiceN')}"></div><div id="${id('practiceGraph')}"></div></div></details>`,
    left: `
      <div class="eo-stage ll-3d" id="${id('stage')}"><svg id="${id('cube')}" viewBox="-170 -170 340 340" aria-label="cube"></svg></div>
      <div class="ll-pic"><svg id="${id('pic')}" viewBox="0 0 200 200" aria-label="last layer"></svg></div>
      <label class="ll-showpic" title="Untick to drill by the cube in hand alone: no diagram, no 3D cube"><input type="checkbox" id="${id('showpic')}"> picture</label>
      <div class="eo-status"><div class="ll-case" id="${id('case')}"></div><div class="eo-timer" id="${id('timer')}">0.00</div></div>
      <div class="eo-scramble ll-scr" id="${id('setup')}"></div>
      <div class="ll-track" id="${id('track')}"></div>`,
  }, { onNew: () => (settings.repeat ? startRep(true) : newCase()), onCheck: (txt) => (settings.repeat ? checkRep(txt) : check(txt)), onShow: onShow, onClear: () => { shown = null; render(); },
    // a cube feeding the box is done when the case is (the AUF included: it is timed too)
    isDone: (txt) => { try { return settings.repeat ? repDone(txt) : done(kind, `${setup} ${tokens(txt).join(' ')}`); } catch { return false; } },
    base: () => setup, onApply: (alg) => { shown = `${setup} ${alg}`; render(); } });

  // state: the drill is an alg from solved; the check is that alg plus the moves typed
  let setup = '';
  let scramble: string | null = null; // a short face-turn scramble for `setup` (null while it is being solved)
  let scrambleGen = 0;
  // the standard route from the setup: the steps before the drill's own stage (an earlier start), then its case
  let lead: RouteStep[] = [];
  let sol: RouteStep | null = null;
  let shown: string | null = null; // the alg whose state the picture shows (setup + moves after a Check)
  let assisted = false, recorded = false;
  let held = false; // the alg is ready (its lines in the panel, for the voice) but the panel hidden until the solve starts
  let asked = false; // the quiz voice: the case has been answered (or given up on): the pictures may show again
  let cameUp: string | null = null; // the case the moves checked actually reached (an earlier start decides it by how the step before was solved)
  const results: { t: number; n: number; std: number }[] = [];

  // the cube in 3D from above (DECISION: rx 50, the top face large and the sides still readable), turned
  // to the open slot when a pair is out; the top-down diagram under it once only the last layer is left
  const TOP_VIEW: View = { rx: 50, ry: DEFAULT_VIEW.ry };
  const view: View = { ...TOP_VIEW };
  const SLOT_RY: Record<string, number> = { FR: -35, FL: 35, BR: -125, BL: 125 };
  function drawPic(): void {
    // the quiz: the pictures give the case away (user, 2026-09-22), so they stay hidden until it has been answered
    const quiz = settings.ask && !settings.repeat && !asked && !recorded;
    if (quiz || !settings.pic) { drill.$('stage').hidden = true; drill.$('pic').parentElement!.hidden = true; return; }
    const f = state(shown ?? setup);
    const r = stageOf(f);
    const ll = r.pairs === 4 && r.eoBad === 0;
    // the diagram says everything a PLL case has to say (user, 2026-09-23), so the 3D cube is only there when
    // there is no diagram to draw - a drill started at the last pair, or a cube not at the last layer
    const cube = kind === 'ocll' || !ll;
    drill.$('stage').hidden = !cube;
    if (cube) render3d(drill.$('cube') as unknown as SVGSVGElement, STICKERS.map((st) => ({ fill: faceHex(f[st.idx]!) })), view);
    drill.$('pic').parentElement!.hidden = !ll;
    if (ll) drill.$('pic').innerHTML = picSvg(f, kind);
  }
  orbit(drill.$('cube') as unknown as SVGSVGElement, view, drawPic);

  const leadNames = () => lead.map((s) => s.name).join(', then ');
  /** What to look for, and (PLL: the hints read from any angle, the alg needs one) where to hold it for the alg. */
  const hintOf = (s: RouteStep) => (s.stage === 'pll' && s.case ? `${s.hint}. For the alg: ${algAngle(s.case)}` : s.hint);
  /** ", after Sune by the standard algs" - what the case named depends on when the drill starts earlier. */
  const afterLead = () => (lead.length ? `, after ${leadNames()} by the standard alg${lead.length > 1 ? 's' : ''}` : '');
  function caseText(): string {
    if (settings.repeat && sol) return `<b>${sol.name}</b> · rep ${repN + 1}${lastRep ? ` · last ${lastRep.name} ${lastRep.t === null ? '' : `${lastRep.t.toFixed(2)}s`}` : ''}`;
    if (recorded && cameUp) return `<b>${cameUp}</b>`;
    if (sol) return `<b>${sol.name}</b>${afterLead()}`;
    const r = stageOf(state(setup));
    if (r.stage === 'solved') return kind === 'pll' ? 'Solved already: a PLL skip.' : 'Solved already.';
    if (kind === 'ocll' && r.stage === 'pll') return 'Corners already oriented: an OCLL skip.';
    return `Not ${kind === 'ocll' ? 'an' : 'a'} ${TITLE[kind]} case: this cube is at ${r.stage === 'eo' ? 'EO' : r.stage === 'f2l' ? 'F2L' : r.stage.toUpperCase()}.`;
  }

  function render(): void {
    drawPic();
    drill.$('case').innerHTML = settings.repeat || (drill.result.visible() && recorded) || !sol ? caseText() : '';
    renderScramble();
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, ms = results.reduce((a, r) => a + r.std, 0) / results.length;
      drill.setStats(`This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (standard algs mean ${ms.toFixed(1)}).`);
    } else drill.setStats('');
  }

  // ---- the scramble, and following it on a smart cube (as the Solve tab does) ----
  function renderScramble(): void {
    const su = drill.$('setup'), tr = drill.$('track');
    if (settings.repeat) { const cs = repCases(); su.innerHTML = `Repeating ${cs.length === CASES[kind].length ? `all ${cs.length} cases` : cs.map((c) => c.name).join(', ')} from wherever the cube is: no scramble.`; tr.textContent = ''; tr.className = 'll-track'; return; }
    if (!setup) { su.innerHTML = ''; tr.textContent = ''; return; }
    if (scramble === null) { su.innerHTML = 'Scramble WCA style: <span>…</span>'; tr.textContent = ''; return; }
    const toks = toWca(scramble).split(' ').filter(Boolean);
    su.innerHTML = `Scramble WCA style: ${scrambleHtml(toks, track)}`;
    tr.className = track?.off ? 'll-track off' : 'll-track';
    // off the scramble with the turns since known: the undo of those, not "back to turn n"
    tr.textContent = trackText(track, toks, offTurns.length ? `Off the scramble after ${toWca(offTurns.join(' '))}: undo with ${toWca(inverse(offTurns.join(' ')))}` : undefined);
  }
  const watcher = makeTrackWatcher();
  let track: TrackStatus | null = null;
  let offTurns: string[] = []; // the turns made since the cube left the scramble path, trainer letters
  let armedNow = false;        // the cube is at the scramble: the voice reads the alg only then
  let quizOpen = false;        // the case was asked and not yet answered: nothing is read until it is
  let quizSaid: string | null = null; // what the quiz heard, for the result
  let quizOutcome: 'right' | 'wrong' | 'gaveUp' | 'cube' | undefined; // and for the record
  let listener: Recognizer | null = null;
  /** Ask the case's name and listen; right, wrong or given up, the alg is then read. */
  function askCase(): void {
    const c = sol?.case;
    const Ctor = recognizerCtor();
    if (!c || lead.length || !Ctor) { if (!Ctor) say('no speech recognition here'); quizOpen = false; return; }
    quizOpen = true;
    say('what case?');
    // DECISION: the mic stays open up to this long: recognising a case takes a few seconds of looking, and Chrome
    // on a phone ends a session after a short silence, so the session is restarted until an answer or the limit
    const LISTEN_MS = 30_000;
    const started = performance.now();
    const listen = () => {
      if (!quizOpen) return;
      if (performance.now() - started > LISTEN_MS) { answer('giveup'); return; }
      const r = new Ctor(); listener = r;
      r.lang = 'en-US'; r.continuous = true; r.maxAlternatives = 5; r.interimResults = false;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const alts = Array.from(e.results[i] ?? [], (x) => x.transcript);
          const heard = alts.map((a) => heardCase(a, CASES[kind].map((x) => x.id))).find((h) => h !== null) ?? null;
          quizSaid = alts[0] ?? null;
          if (heard !== null) { answer(heard); return; }
          say('say it again?');
        }
      };
      r.onerror = (e) => { if (quizOpen && (e.error === 'not-allowed' || e.error === 'audio-capture')) { say('no microphone'); answer('giveup'); } }; // a no-speech end just restarts
      r.onend = () => { if (listener === r) { listener = null; if (quizOpen) setTimeout(listen, 100); } };
      try { r.start(); } catch { answer('giveup'); }
    };
    setTimeout(listen, 700); // after "what case?" has been said
  }
  /** The quiz's answer: `heard` is a case id, a wrong name, or 'giveup'; the alg is read from here on. */
  function answer(heard: string): void {
    if (!quizOpen) return;
    quizOpen = false; listener?.abort(); listener = null;
    asked = true; drawPic();
    const c = sol?.case;
    const name = c ? spokenName(kind, c) : '';
    // the name, then how to hold it for the alg ("V perm: the bars of two at the back and on your left")
    const hold = c && kind === 'pll' ? `. ${algAngle(c)}` : '';
    // the first move is read once the name and the hold have been said - the utterance's own end, not a
    // timer (a phone's voice is slower than a desktop's and was being cut off mid-sentence), and queued
    // behind it in case a read comes sooner
    const then = handsFree ? readWhole : settings.say.alg === 'read' ? () => { lastRead = null; keepNext = true; followAlg(drill.moves()); } : undefined;
    if (heard === 'giveup') { quizSaid = `gave up (${name})`; quizOutcome = 'gaveUp'; say(`${name}${hold}`, false, then); }
    else if (c && heard === c.id) { quizSaid = `${heard}: right`; quizOutcome = 'right'; say(`right, ${name}${hold}`, false, then); }
    else { quizSaid = `${heard}: wrong (${c?.id ?? '?'})`; quizOutcome = 'wrong'; say(`no, ${name}${hold}`, false, then); }
    keepNext = true; // a turn meanwhile: its read waits its turn too
    reveal();
  }
  // ---- hands-free (user, 2026-09-22): no cube feeding the drill, so nothing arms by itself. With the quiz
  // voice on, the mic stays open for "ready" (the case is scrambled by hand and looked at): the case is
  // asked, and after the answer the whole alg is read in one go - nothing to follow move by move - and
  // "next" brings the next case. Only the open tab listens; a cube or camera taking over ends it.
  let standbyRec: Recognizer | null = null;
  let standbyOn = false;
  let handsFree = false; // this quiz came from "ready": the alg is read whole, the attempt recorded untimed
  const READY = /\b(ready|go|okay|ok|start|ask)\b/, NEXT = /\b(next|new case|another|done)\b/;
  function standby(): void {
    const Ctor = recognizerCtor();
    const want = settings.ask && !activeSource() && !quizOpen && !root.hidden;
    if (!want || !Ctor) { stopStandby(); return; }
    if (standbyOn) return;
    standbyOn = true;
    const listen = () => {
      if (!standbyOn) return;
      const r = new Ctor(); standbyRec = r;
      r.lang = 'en-US'; r.continuous = true; r.maxAlternatives = 3; r.interimResults = false;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = Array.from(e.results[i] ?? [], (x) => x.transcript).join(' ').toLowerCase();
          if (NEXT.test(t)) { newCase(); return; }
          if (READY.test(t)) { stopStandby(); handsFree = true; askCase(); return; }
        }
      };
      r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'audio-capture') stopStandby(); }; // a no-speech end just restarts
      r.onend = () => { if (standbyRec === r) { standbyRec = null; if (standbyOn) setTimeout(listen, 100); } };
      try { r.start(); } catch { stopStandby(); }
    };
    listen();
  }
  function stopStandby(): void { standbyOn = false; standbyRec?.abort(); standbyRec = null; }
  /** The alg on show read in one go (hands-free: no turns to read it by), chunks by name, then the mic is back on standby. */
  function readWhole(): void {
    handsFree = false;
    if (!sol) { standby(); return; }
    const toks = tokens(stepPlain(sol));
    const offset = sol.pre ? 1 : 0;
    const chunks = triggers(sol.alg).filter((g) => !settings.spell.includes(g.label)).map((g) => ({ ...g, at: g.at + offset }));
    const words: string[] = [];
    for (let i = 0; i < toks.length;) {
      const g = chunks.find((c) => c.at === i);
      if (g) { words.push(spokenLabel(g.label)); i += g.n; }
      else { words.push(spoken(toks[i]!)); i++; }
    }
    say(words.join(', '), true, standby, 30_000);
    // the attempt: the case named (or not), no time
    if (!recorded) { recorded = true; drill.attempt(''); drill.save({ scramble: setup, moves: '', optimal: stepMoves(sol), caseId: sol.name, assisted, start: settings.from === kind ? undefined : settings.from as 'ocll' | 'pair', quiz: quizOutcome }); }
  }
  onSourceChange(standby);
  onTabChange(standby);
  // DECISION: a wrong turn is called this long after it, not at once (user, 2026-09-23): the cube reports a
  // slice as its two outer layers, a few ms apart, and the state between them is off the route - a turn that
  // lands back on it inside this window was never wrong. A hand's two separate turns are far slower than this.
  const OFF_HOLD_MS = 300;
  let offTimer: ReturnType<typeof setTimeout> | undefined;
  /** Say it unless the cube lands back on the route first. */
  function holdOff(fn: () => void): void { clearTimeout(offTimer); offTimer = setTimeout(fn, OFF_HOLD_MS); }
  /** Back on the route (or a fresh case): nothing pending is said. */
  function clearOff(): void { clearTimeout(offTimer); offTimer = undefined; }
  let lastRead: string | null = null; // what the voice last read, so a re-render does not repeat it
  let keepNext = false;               // the next move read is queued after what is being said (a name, the hold), not over it
  let lastBad = 0;                    // how many wrong moves were listed last time (an undo shortens it)
  let fedCount = 0;                   // moves fed so far, for the echo
  /**
   * The moves done (`text`) after the last of them that left the cube on `route`: the wrong turns, in order,
   * and `at`, the route index of the state they left from.
   */
  function offRoute(route: string[], text: string): { bad: string[]; at: number } {
    let toks: string[];
    try { toks = tokens(text); } catch { return { bad: [], at: 0 }; }
    const onIt = new Map<string, number>();
    for (let i = route.length; i >= 0; i--) onIt.set(state(`${setup} ${route.slice(0, i).join(' ')}`), i); // the earliest index wins
    for (let k = toks.length; k >= 0; k--) { const i = onIt.get(state(`${setup} ${toks.slice(0, k).join(' ')}`)); if (i !== undefined) return { bad: toks.slice(k), at: i }; }
    return { bad: toks, at: 0 };
  }
  /**
   * The cube's fixed letters (what a smart cube reports) as the letters of the frame the alg's rotations
   * up to route index `at` leave the cube in: an x, and the user's "U" is the cube's F. Identity without rotations.
   */
  function inHand(route: string[], at: number, alg: string): string {
    const rots = route.slice(0, at).filter((m) => /^[xyz]/.test(m));
    if (!rots.length) return alg;
    const raw = rawFacelets(rots.join(' '));
    return relabel(alg, frameMap(raw[CENTRE.D!]! as FaceId, raw[CENTRE.F!]! as FaceId));
  }
  /** The off-the-alg line in the result panel: the wrong turns and their undo (in the hand's frame); gone when back on. */
  function showOff(bad: string[], undo: string[]): void {
    let el = drill.result.body.querySelector<HTMLElement>('.ll-off');
    if (!bad.length) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'll-off'; drill.result.body.prepend(el); }
    el.innerHTML = `Off the alg after ${bad.map(moveHtml).join(' ')} — undo with ${undo.map(moveHtml).join(' ')}`;
  }
  // a middle-slice turn reaches the cube as its two outer layers the other way (M = L' R, the core turning with the
  // slice), each as quarter turns: the echo gathers L and R turns that arrive close together, merges them, and says
  // the slice when that is what they make; anything else is said move by move, in order
  const SLICE_OF_PAIR: Record<string, string> = {
    "L' R": 'M', "R L'": 'M', "L R'": "M'", "R' L": "M'", 'L2 R2': 'M2', 'R2 L2': 'M2',
    "F' B": 'S', "B F'": 'S', "F B'": "S'", "B' F": "S'", 'F2 B2': 'S2', 'B2 F2': 'S2',
    "D' U": 'E', "U D'": 'E', "D U'": "E'", "U' D": "E'", 'D2 U2': 'E2', 'U2 D2': 'E2',
  };
  /** Adjacent outer-layer pairs that are a slice (L' R -> M), the rest as they are. */
  function foldSlices(moves: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < moves.length; i++) {
      const pair = i + 1 < moves.length ? SLICE_OF_PAIR[`${moves[i]} ${moves[i + 1]}`] : undefined;
      if (pair) { out.push(pair); i++; } else out.push(moves[i]!);
    }
    return out;
  }
  const ECHO_HOLD_MS = 250; // DECISION: a slice's layers arrive within a few ms; a hand's separate L then R rarely inside this
  let pending: string[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  function flushEcho(): void {
    clearTimeout(pendingTimer); pendingTimer = undefined;
    if (!pending.length) return;
    const merged = tokens(faceTurns(pending.join(' ')));
    pending = [];
    const slice = merged.length === 2 ? SLICE_OF_PAIR[merged.join(' ')] : undefined;
    say(slice ? spoken(slice) : merged.map(spoken).join(', '));
  }
  function echo(moves: string[]): void {
    for (const m of moves) {
      // an L/R or F/B turn waits for its other half (an M or S slice); U and D are said at once (no E slice in any alg here)
      if (/^[LRFB]/.test(m)) {
        if (pending.length && /^[LR]/.test(pending[0]!) !== /^[LR]/.test(m)) flushEcho();
        pending.push(m); clearTimeout(pendingTimer); pendingTimer = setTimeout(flushEcho, ECHO_HOLD_MS); continue;
      }
      flushEcho();
      say(spoken(m));
    }
  }
  /** The cube's moves came in: echo the newest, or read the alg's next; a turn during the quiz is the answer. */
  function heard(text: string): void {
    let toks: string[];
    try { toks = tokens(text); } catch { return; }
    if (quizOpen && toks.length) { quizOpen = false; listener?.abort(); listener = null; quizSaid = 'answered with the cube'; quizOutcome = 'cube'; asked = true; drawPic(); }
    if (armedNow && toks.length) reveal();
    if (settings.say.alg === 'echo' && toks.length > fedCount) echo(toks.slice(fedCount));
    fedCount = toks.length;
  }
  let belief: { facelets: string; colourOf: Record<FaceId, ColorName> } | null = null; // the cube's last known state, for a rep's start
  function watch(facelets: string | null, colourOf: Record<FaceId, ColorName>, turn?: string): void {
    if (facelets) belief = { facelets, colourOf };
    if (!scramble || settings.repeat) { track = null; return; }
    const was = track;
    track = watcher.status(scramble, facelets, colourOf, hold());
    // off the scramble: keep the turns since (a turn back onto it clears them) and say so once per turn
    if (track?.off && !armedNow) {
      if (turn) {
        const before = offTurns.length;
        offTurns = offList([...offTurns, turn]);
        // the scramble is read in WCA letters, so is its undo; an undoing turn gets the rest to undo, not "wrong"
        const words = `${offTurns.length < before ? 'undo' : 'wrong. undo'} ${tokens(toWca(inverse(offTurns.join(' ')))).map(spoken).join(', ')}`;
        if (settings.say.scramble !== 'off') holdOff(() => say(words));
      }
    } else if (was?.off && !track?.off) { clearOff(); offTurns = []; if (settings.say.scramble !== 'off' && track && !track.matched) say('back on'); }
    else { clearOff(); offTurns = []; }
    sayScramble(turn);
    renderScramble();
  }

  let scrRead: string | null = null; // the last thing said about the scramble, so a repeat is not said twice
  /**
   * The scramble out loud while it is being applied: its next move, or the moves made, in the WCA letters
   * it is shown in (user, 2026-09-23). Nothing once it is on: from there the alg's own mode has the voice.
   */
  function sayScramble(turn?: string): void {
    const mode = settings.say.scramble;
    if (mode === 'off' || mode === 'watch' || !track || armedNow) { scrRead = null; return; }
    if (mode === 'echo') { if (turn && !track.off) say(spoken(tokens(toWca(turn))[0] ?? turn)); return; }
    if (track.matched) { if (scrRead !== 'done') { scrRead = 'done'; say('scrambled'); } return; }
    if (track.off || track.half) return; // off it, or mid-double-turn: the rest of that turn is under way
    const next = toWca(scramble ?? '').split(' ').filter(Boolean)[track.applied];
    if (!next || next === scrRead) return;
    scrRead = next;
    say(spoken(next));
  }

  /**
   * Show the state after `alg`: worked from as face turns only, so the moves after it read in one
   * frame (a V perm's y). A random case (`freeAuf`) is defined up to its AUF, so the scramble drops
   * its trailing top-layer turns and the setup moves to where the shorter scramble lands; a cube
   * handed over from another tab is where it is, and keeps its AUF.
   */
  function load(alg: string, freeAuf = false): void {
    if (settings.repeat) { setup = faceTurns(alg); startRep(false, true); return; }
    setup = faceTurns(alg);
    const derive = () => { const steps = route(kind, setup); sol = steps?.[steps.length - 1] ?? null; lead = steps?.slice(0, -1) ?? []; };
    derive();
    shown = null; assisted = false; recorded = false; cameUp = null; held = false; asked = false;
    const open = SLOTS.find((sl) => !slotSolved(state(setup), sl));
    view.rx = TOP_VIEW.rx; view.ry = open ? SLOT_RY[open]! : TOP_VIEW.ry;
    // the setup is an alg backwards (an N perm, then the OCLL case): the drill shows a short
    // face-turn scramble for the same state instead. DECISION: solved on a timeout, not here:
    // the first solve builds the pruning tables (~500 ms), which would otherwise sit in the page's mount.
    scramble = null; track = null; lastRead = null; scrRead = null; lastBad = 0; fedCount = 0; offTurns = []; armedNow = false;
    quizOpen = false; quizSaid = null; quizOutcome = undefined; listener?.abort(); listener = null;
    const gen = ++scrambleGen;
    setTimeout(() => {
      if (gen !== scrambleGen) return;
      // a PLL case from the PLL: the U D R2 L2 fixed-length scramble; an earlier start or a handed-over
      // cube is off G1 and takes the plain shortest answer
      const opts = kind === 'pll' && settings.from === 'pll' && !lead.length ? { ...PLL_SCRAMBLE, faces: scrambleFaces(), noLeadingU: freeAuf } : {};
      const t = trimAuf(scrambleFor(setup, Math.random, opts));
      if (freeAuf && t.auf) {
        setup = faceTurns(`${setup} ${inverse(t.auf)}`);
        derive(); shareScramble(setup, kind);
        // the alg on show is for the setup as it was; one held for the first turn stays hidden
        if (drill.showOpen() && sol) { onShow(true); if (held) { drill.result.hide(); drill.setShowLabel('Show the alg'); } }
      }
      scramble = freeAuf ? t.scramble : `${t.scramble} ${t.auf}`.trim();
      render();
    });
    drill.begin();
    render();
    // the setting: the alg comes up by itself, but not while the case is being looked at (user, 2026-09-21:
    // the scramble done, the screen is where the recognition happens): its lines are made now, hidden, and
    // shown at the first turn after the scramble, or the quiz's answer
    if (settings.auto && sol) { drill.$('showSol').click(); drill.result.hide(); drill.setShowLabel('Show the alg'); held = true; }
  }
  /** The held alg shown: the solve has started, or the case was answered. */
  function reveal(): void {
    if (!held) return;
    held = false;
    drill.setShowLabel('Hide the alg');
    drill.result.show(drill.$('rTitle').textContent ?? '', drill.$('rSub').textContent ?? '');
  }
  // ---- repeat mode: the algs over and over on the cube in hand, no scramble (user, 2026-09-21) ----
  // The cases in the drill in the table's order (Ra, Rb, Ra, Rb...), each rep from wherever the cube is:
  // the setup is the cube's own state, the alg is on show and followed like a solve's (wrong turns
  // called with their undo), and the rep is done when the cube reaches the alg's end state - the next
  // alg starts there at once, so the reps run back to back.
  let repAt = 0;   // the cycle's next case
  let repN = 0;    // reps done since the mode came on
  let lastRep: { name: string; t: number | null } | null = null;
  // DECISION: the setup (the record's scramble, the state per turn) is re-solved to a short alg past this many moves
  const REBASE_AT = 60;
  /** The rep's alg is done: the cube is at the end of the case's alg (or one of its other algs) from the setup. */
  function repDone(txt: string): boolean {
    const c = sol?.case;
    if (!c) return false;
    const cur = state(`${setup} ${tokens(txt).join(' ')}`);
    return [c.alg, ...(c.alts ?? []).map((a) => a.alg)].some((alg) => state(`${setup} ${alg}`) === cur);
  }
  /**
   * The next rep: the cycle's next case (`advance`), or the same one again. The setup is where the cube is - the
   * moves fed so far from the last setup, else the cube's own belief (the mode just switched on, the cube
   * anywhere) - unless `placed` says the setup was just loaded with the cube's state.
   */
  function startRep(advance: boolean, placed = false, lined = false): void {
    const cs = repCases();
    if (advance) repAt++;
    const c = cs[repAt % cs.length]!;
    if (!placed) {
      if (armedNow) setup = faceTurns(`${setup} ${tokens(drill.moves()).join(' ')}`);
      else if (belief) { try { setup = trainerScramble({ ...belief, solution: solveAny(belief.facelets) }, hold()); } catch { /* a cube the trainer cannot hold: the setup stays */ } }
    }
    if (tokens(setup).length > REBASE_AT) setup = scrambleFor(setup, Math.random, kind === 'pll' ? { faces: scrambleFaces() } : {});
    sol = { stage: kind, name: c.name, hint: c.hint, pre: '', alg: c.alg, post: '', case: c }; lead = [];
    shown = null; assisted = false; recorded = false; cameUp = null; held = false;
    view.rx = TOP_VIEW.rx; view.ry = TOP_VIEW.ry;
    scramble = setup; track = null; lastBad = 0; fedCount = 0; offTurns = []; armedNow = false;
    if (!lined) lastRead = null; // lined up: the first move was read already, and is the same
    quizOpen = false; quizSaid = null; quizOutcome = undefined; listener?.abort(); listener = null;
    scrambleGen++;
    drill.begin(); render();
    drill.$('next').textContent = 'Next alg';
    drill.$('showSol').click(); // the alg is what is practised: always on show
    if (speaks() && !lined) { say(spokenName(kind, c), true); keepNext = true; } // the same rep lined up: the name was said
    shareScramble(setup, kind);
    syncDriver(); // the cube is at the setup already: the driver arms now, and the first turn counts
  }
  /**
   * Repeat mode: the turns so far are top-layer turns only (the case being lined up for the alg, or solved
   * after it, as in a solve) and the alg does not begin with one: the setup moves by them and the rep
   * restarts there, so they are neither "wrong" nor timed. True when that happened.
   */
  function absorbAuf(text: string): boolean {
    let toks: string[];
    try { toks = tokens(text); } catch { return false; }
    if (!toks.length || !toks.every((m) => /^U/.test(m)) || !sol || /^U/.test(tokens(sol.alg)[0] ?? '')) return false;
    setup = faceTurns(`${setup} ${toks.join(' ')}`);
    startRep(false, true, true);
    return true;
  }
  /** The faces a PLL scramble may turn, in the trainer's letters: every face but the ones shown as F and B (green and blue, held WCA style). */
  const scrambleFaces = (): string => 'UDRLFB'.replace(fromWca('F').trim()[0]!, '').replace(fromWca('B').trim()[0]!, '');
  /** A rep's alg done: recorded (its time is first turn to last), and the next rep starts from here. */
  function checkRep(txt: string): void {
    let toks: string[];
    try { toks = tokens(txt); } catch { return; }
    const { t } = drill.attempt(txt);
    if (sol && !recorded) {
      recorded = true;
      repN++; lastRep = { name: sol.name, t };
      results.push({ t: t ?? 0, n: toks.length, std: stepMoves(sol) });
      drill.save({ scramble: setup, moves: toks.join(' '), optimal: stepMoves(sol), caseId: sol.name, assisted: true, start: 'repeat' });
      if (drill.$('practice').hasAttribute('open')) void renderPractice();
      if (speaks() && t !== null) say(t.toFixed(1));
    }
    startRep(true);
  }

  /** Bring the next case after a solve (the setting): after a pause, unless a case was loaded meanwhile. */
  function queueNext(): void {
    if (!settings.next) return;
    const gen = scrambleGen;
    setTimeout(() => { if (gen === scrambleGen) newCase(); }, NEXT_AFTER_MS);
  }
  // how often each case has been drawn this sitting, and the last one: the draw is weighted by them
  const drawn: Record<string, number> = {};
  let lastDrawn: string | null = null;
  function newCase(): void {
    drill.$('next').textContent = 'New case';
    const c = drawCase(pool(), drawn, lastDrawn);
    drawn[c.id] = (drawn[c.id] ?? 0) + 1;
    lastDrawn = c.id;
    const r = randomSetup(kind, Math.random, settings.from, [c]);
    load(r.setup, true); shareScramble(setup, kind);
    if (speaks()) say('scramble', true);
    standby();
  }

  // ---- the practice so far: per-case numbers from the store, sorted any way (worst first by default), buttons that
  // set the pool from them, and a graph with a line per case: its running ao5 over every try of the stage ----
  const SORT_KEY = `zz-${kind}-practice-sort`;
  const { settings: sortBy, save: saveSort } = persisted<{ key: SortKey; dir: 'asc' | 'desc' }>(SORT_KEY, { key: 'work', dir: 'asc' }, (st) => {
    if (!SORT_KEYS.includes(st.key)) st.key = 'work';
    if (st.dir !== 'asc' && st.dir !== 'desc') st.dir = DEFAULT_DIR[st.key];
  });
  let graph: ReturnType<typeof mountCaseGraph> | null = null;
  const COLS: { key: SortKey; label: string; title: string }[] = [
    { key: 'name', label: 'case', title: 'the case list\'s order' }, { key: 'n', label: 'tries', title: 'solved attempts' }, { key: 'best', label: 'best', title: 'the fastest timed try' },
    { key: 'recent', label: 'recent', title: `the mean of the last ${RECENT} timed tries` }, { key: 'trend', label: 'trend', title: `recent against the ${RECENT} tries before those: minus is faster` },
    { key: 'recognition', label: 'recog.', title: 'scramble on the cube to the first turn, recent cube-fed tries' }, { key: 'execution', label: 'exec.', title: 'first turn to last, recent cube-fed tries' },
    { key: 'quiz', label: 'named', title: 'the quiz: named right, of those asked' }, { key: 'last', label: 'last', title: 'when the case last came up' },
  ];
  async function renderPractice(): Promise<void> {
    const body = drill.$('practiceBody'), wrap = drill.$('practiceGraphWrap');
    const attempts = await readAttempts(kind);
    const all = caseStats(attempts, CASES[kind]);
    const stats = sortStats(all, sortBy.key, sortBy.dir);
    const done = all.filter((s) => s.n > 0);
    if (!done.length) { body.innerHTML = '<p class="note">Nothing recorded yet: solve a case and it goes in the store (and the cloud, when sync is on).</p>'; wrap.hidden = true; return; }
    const anyQuiz = all.some((s) => s.quizAsked), anyFed = all.some((s) => s.recognition !== null);
    const ago = (t: number | null) => { if (t === null) return '–'; const d = (Date.now() - t) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)}d ago`; };
    const cols = COLS.filter((c) => (anyFed || (c.key !== 'recognition' && c.key !== 'execution')) && (anyQuiz || c.key !== 'quiz'));
    const th = (c: { key: SortKey; label: string; title: string }) => {
      const on = sortBy.key === c.key;
      return `<th><button type="button" class="${on ? 'on' : ''}" data-sort="${c.key}" title="${c.title}">${c.label}${on ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
    };
    const cell = (s: (typeof stats)[number], key: SortKey): string => {
      switch (key) {
        case 'name': return `<td class="name"><button type="button" data-graph="${s.id}" title="Graph this case on its own">${s.name}</button></td>`;
        case 'n': return `<td>${s.n}${s.assisted ? `<small> (${s.assisted} peeked)</small>` : ''}</td>`;
        case 'best': return `<td>${secs(s.best)}</td>`;
        case 'recent': return `<td>${secs(s.recent)}</td>`;
        case 'trend': return `<td class="${s.trend === null || Math.abs(s.trend) < 50 ? '' : s.trend < 0 ? 'faster' : 'slower'}">${trendText(s.trend)}</td>`;
        case 'recognition': return `<td>${secs(s.recognition)}</td>`;
        case 'execution': return `<td>${secs(s.execution)}</td>`;
        case 'quiz': return `<td>${s.quizAsked ? `${s.quizRight}/${s.quizAsked}` : '–'}</td>`;
        case 'last': return `<td>${ago(s.last)}</td>`;
        default: return '<td></td>';
      }
    };
    body.innerHTML = `<div class="ll-scroll"><table><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>${stats.map((s) => `
      <tr class="${s.n < 3 ? 'dim' : ''}">${cols.map((c) => cell(s, c.key)).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">${sortBy.key === 'work' ? `Worst first: the least practised (under three tries, greyed), then the slowest recently${anyQuiz ? ', slower still when misnamed' : ''}.` : 'Tap a heading to sort by it, again to flip it.'} Recent = the last ${RECENT} timed tries; trend = those against the ${RECENT} before, minus is faster. Tap a case to graph it on its own.</p>
      <div class="row"><button type="button" class="eo-link" data-work="5">Drill the five to work on</button><button type="button" class="eo-link" data-work="8">the eight</button><button type="button" class="eo-link" data-work="new">the unpractised</button>${sortBy.key === 'work' ? '' : '<button type="button" class="eo-link" data-sort="work">sort worst first</button>'}</div>`;
    // the graph: a line per case, over every timed try of the stage
    const { lines, whens } = caseLines(attempts, CASES[kind]);
    wrap.hidden = !whens.length;
    if (!whens.length) return;
    graph ??= mountCaseGraph(drill.$('practiceGraph'), `zz-${kind}-graph-hidden`);
    drill.$('practiceN').textContent = `Each case's ao${AVG_N} (ao${MIN_N} until there are five), over ${whens.length} timed ${whens.length === 1 ? 'try' : 'tries'}: a line that comes down is a case being learnt.`;
    graph.draw({ lines, whens, dayOf: (w) => dayOf(w) });
  }
  drill.$('practice').addEventListener('toggle', () => { if (drill.$('practice').hasAttribute('open')) void renderPractice(); });
  drill.$('practiceBody').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>('[data-sort]');
    if (sort) {
      const key = sort.dataset.sort as SortKey;
      sortBy.dir = key === sortBy.key ? (sortBy.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[key];
      sortBy.key = key;
      saveSort(); void renderPractice();
      return;
    }
    const one = t.closest<HTMLElement>('[data-graph]');
    if (one) { graph?.only(one.dataset.graph!); drill.$('practiceGraphWrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const b = t.closest<HTMLElement>('[data-work]');
    if (!b) return;
    void (async () => {
      const stats = workOn(caseStats(await readAttempts(kind), CASES[kind]));
      const pick = b.dataset.work === 'new' ? stats.filter((s) => s.n < 3) : stats.slice(0, Number(b.dataset.work));
      settings.cases = pick.length && pick.length < CASES[kind].length ? pick.map((s) => s.id) : undefined;
      saveSettings(); renderCases();
      drill.flash(pick.length ? `Drilling ${pick.map((s) => s.name).join(', ')}.` : 'Every case has three tries or more: drilling them all.');
    })();
  });

  // ---- which cases New case draws from: a chip per case, tap to toggle; none on counts as all ----
  const inPool = (c: LLCase) => !settings.cases || settings.cases.includes(c.id);
  const pool = (): LLCase[] => CASES[kind].filter(inPool);
  /** The cases a rep cycles through: the pool, or every case when none is picked (as New case draws) */
  const repCases = (): LLCase[] => (pool().length ? pool() : CASES[kind]);
  function renderCases(): void {
    const n = pool().length, all = CASES[kind].length;
    drill.$('casesN').textContent = n === all ? `all ${all}` : n ? `${n} of ${all}` : `none picked, so all ${all}`;
    // a family link (G for Ga-Gd) puts just that family in; a second tap adds the next one
    const fams = families(kind).filter((f) => CASES[kind].filter((c) => c.id[0] === f).length > 1);
    // the chain pairs first (a case and the one its alg sets up, drilled back to back), the rest after; a
    // picked case's partner is tinted (user, 2026-09-21: what to add for the pair)
    const { pairs } = chainSummary(kind);
    const chip = (c: LLCase, mate?: LLCase) => `<button type="button" class="eo-chip${inPool(c) ? ' on' : mate && inPool(mate) && settings.cases ? ' mate' : ''}" data-case="${c.id}">${c.name}</button>`;
    const paired = new Set(pairs.flat().map((c) => c.id));
    const rest = CASES[kind].filter((c) => !paired.has(c.id));
    drill.$('caselist').innerHTML = `<span class="ll-pairs">${pairs.map(([a, b]) => `<span class="ll-pair">${chip(a, b)}<i>↔</i>${chip(b, a)}</span>`).join('')}</span>`
      + `<span class="ll-solo">${rest.map((c) => chip(c)).join('')}</span>`
      + '<button type="button" class="eo-link" data-cases="all">all</button><button type="button" class="eo-link" data-cases="none">none</button>'
      + (fams.length ? `<span class="ll-fams">Family: ${fams.map((f) => `<button type="button" class="eo-link" data-family="${f}">${f}</button>`).join('')}</span>` : '');
  }
  drill.$('caselist').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-case], [data-cases], [data-family]');
    if (!t) return;
    if (t.dataset.family) {
      // the family's cases: on their own when the pool is everything, added to a picked pool otherwise
      const fam = CASES[kind].filter((c) => c.id[0] === t.dataset.family).map((c) => c.id);
      const on = settings.cases ? new Set(settings.cases) : new Set<string>();
      for (const id of fam) on.add(id);
      settings.cases = on.size === CASES[kind].length ? undefined : [...on];
    } else if (t.dataset.cases) settings.cases = t.dataset.cases === 'all' ? undefined : [];
    else { const on = new Set(pool().map((c) => c.id)); if (on.has(t.dataset.case!)) on.delete(t.dataset.case!); else on.add(t.dataset.case!); settings.cases = on.size === CASES[kind].length ? undefined : [...on]; }
    saveSettings(); renderCases();
  });
  renderCases();

  const AUF_NOTE = ` <small>[U] is the AUF: turn the top layer that way first${kind === 'pll' ? '; a bracket at the end lines it up after' : ''}.</small>`;
  /** Your note on the step's alg, under its line (the case list sheet is where it is written). */
  function noteUnder(line: HTMLElement, step: RouteStep): void {
    const c = step.case;
    if (!c) return;
    const text = noteFor(step.stage === 'pll' ? 'pll' : 'ocll', c.id, step.alg); // a pair step has no case, so the stage is the kind
    if (!text) return;
    const p = document.createElement('div'); p.className = 'll-note'; p.textContent = text;
    line.insertAdjacentElement('afterend', p);
  }

  /**
   * The steps as listed lines, [AUF]s in brackets, triggers labelled, each line applying the route
   * so far (from `before`, moves already done from the setup) so ▶ and the peek show the right cube.
   * The last step's other algs (the case's alts, with their own AUFs from where the route leaves it)
   * follow as "or" lines with the note on how each is built.
   */
  function putAlgLines(steps: RouteStep[], before = ''): void {
    const body = drill.result.body; body.innerHTML = '';
    const line = (step: RouteStep, sofar: string): HTMLElement => {
      const skip = sofar ? tokens(sofar).length : 0;
      const d = drill.algLine(stepShown(step), `${sofar} ${stepPlain(step)}`.trim(), skip); d.classList.add('ll-alg');
      markTriggers(d, step.alg, step.pre ? 1 : 0);
      // the chunks by route index, for the voice: it names a chunk instead of reading its moves one by one
      d.dataset.trig = JSON.stringify(triggers(step.alg).map((g) => ({ at: skip + (step.pre ? 1 : 0) + g.at, n: g.n, label: g.label })));
      body.appendChild(d);
      return d;
    };
    let sofar = before;
    let lastLine: HTMLElement | null = null;
    for (const s of steps) {
      if (steps.length > 1) body.insertAdjacentHTML('beforeend', `<div class="ll-step"><b>${s.name}</b> · ${stepMoves(s)} moves</div>`);
      lastLine = line(s, sofar);
      noteUnder(lastLine, s);
      sofar = `${sofar} ${stepPlain(s)}`.trim();
    }
    lastLine?.setAttribute('data-main', '1'); // the route the voice reads
    const last = steps[steps.length - 1];
    if (steps.some((s) => s.pre || s.post)) lastLine?.insertAdjacentHTML('beforeend', AUF_NOTE);
    // the other algs for the case, folded (the setting remembers whether they are open)
    const alts = (last?.case?.alts ?? []).map((alt) => ({ alt, fit: fitAlg(kind, `${setup} ${sofar.slice(0, sofar.length - stepPlain(last!).length)}`, alt.alg) })).filter((x) => x.fit);
    if (last && alts.length) {
      const at = sofar.slice(0, sofar.length - stepPlain(last).length).trim(); // the route before the last step
      const box = document.createElement('details'); box.className = 'll-alts'; box.open = settings.alts;
      box.innerHTML = `<summary>Other algs for ${last.name} (${alts.length})</summary>`;
      box.addEventListener('toggle', () => { settings.alts = box.open; saveSettings(); });
      body.appendChild(box);
      let altAuf = false, altLine: HTMLElement | null = null;
      for (const { alt, fit } of alts) {
        const step: RouteStep = { ...last, alg: alt.alg, pre: fit!.pre, post: fit!.post };
        box.insertAdjacentHTML('beforeend', `<div class="ll-step">${stepMoves(step)} moves · ${alt.note}</div>`);
        const d = drill.algLine(stepShown(step), `${at} ${stepPlain(step)}`.trim(), at ? tokens(at).length : 0); d.classList.add('ll-alg');
        markTriggers(d, step.alg, step.pre ? 1 : 0);
        box.appendChild(d);
        noteUnder(d, step);
        altLine = d; altAuf ||= !!(fit!.pre || fit!.post);
      }
      if (altAuf && !steps.some((s) => s.pre || s.post)) altLine?.insertAdjacentHTML('beforeend', AUF_NOTE);
    }
    followAlg(drill.moves());
  }

  /**
   * The listed alg followed on the cube (as the Solve tab follows its solution): the moves done so far
   * from the setup reach a state; where that state sits along the listed route, the moves up to it read
   * as done, and a quarter turn into a double turn as halfway. Off the route nothing is marked.
   */
  function followAlg(text: string): void {
    const els = [...drill.result.body.querySelectorAll<HTMLElement>('.ll-alg')];
    // the alg on show: every line is its own route from the setup (an alt is another way from where the steps
    // before leave the cube). With nothing on show the standard route is still followed, unseen, so a wrong
    // turn can be called while the alg is being done from memory (user, 2026-09-23).
    const lines: { alg: string; main: boolean; trig: string; el: HTMLElement | null }[] = els.length
      ? els.map((el) => ({ alg: el.dataset.alg ?? '', main: !!el.dataset.main, trig: el.dataset.trig ?? '[]', el }))
      : sol ? [{ alg: [...lead, sol].map(stepPlain).join(' ').trim(), main: true, trig: '[]', el: null }] : [];
    if (!lines.length) return;
    let cur: string | null;
    try { cur = state(`${setup} ${tokens(text).join(' ')}`); } catch { cur = null; }
    for (const line of lines) {
      const route = tokens(line.alg);
      let done = 0, half = false, onRoute = false;
      if (cur !== null) {
        const states = [state(setup)];
        for (let i = 1; i <= route.length; i++) states.push(state(`${setup} ${route.slice(0, i).join(' ')}`));
        const k = states.indexOf(cur); // the earliest: a rotation changes nothing, so it is not "done" before it is made
        if (k >= 0) { done = k; onRoute = true; }
        else for (let i = 0; i < route.length; i++) {
          const m = route[i]!;
          if (!m.endsWith('2')) continue;
          const before = `${setup} ${route.slice(0, i).join(' ')}`;
          if (state(`${before} ${m[0]}`) === cur || state(`${before} ${m[0]}'`) === cur) { done = i; half = true; onRoute = true; break; }
        }
      }
      if (line.main) {
        // off the alg: the moves since the last state on it, and how to undo them (shown, and said once per change)
        const off = onRoute || cur === null ? { bad: [], at: 0 } : offRoute(route, text);
        // the wrong turns and their undo in the letters of the frame the alg has the cube in (after its x, the cube's F is
        // your U), a slice's two layers folded back into the slice (L' R is the M the hand made)
        const bad = foldSlices(tokens(inHand(route, off.at, offList(off.bad).join(' '))));
        const undo = bad.length ? foldSlices(tokens(inverse(bad.join(' ')))) : [];
        if (bad.length) {
          // held: the cube's two halves of a slice arrive one after the other, and the state between them is off the alg
          const words = `${bad.length < lastBad ? 'undo' : 'wrong. undo'} ${undo.map(spoken).join(', ')}`;
          holdOff(() => {
            showOff(bad, undo);
            if (settings.say.alg !== 'off' && words !== lastRead) { lastRead = words; say(words); }
          });
        } else { clearOff(); showOff([], []); }
        // the voice reads the next move of the main route (the other half of a double turn when halfway), once the cube is at
        // the scramble; a rotation is read together with the move after it (the cube cannot see it, and the move's letter assumes it);
        // a chunk (sexy, the T core) is named at its start and its moves are not read one by one
        if (!bad.length && settings.say.alg === 'read' && onRoute && armedNow && !quizOpen) {
          let d = done;
          const rots: string[] = [];
          while (route[d] && /^[xyz]/.test(route[d]!)) rots.push(route[d++]!);
          const next = route[d];
          // the setting: a chunk by its name, or every move of it read like any other
          const trig = (JSON.parse(line.trig) as { at: number; n: number; label: string }[]).find((g) => g.at <= d && d < g.at + g.n && !settings.spell.includes(g.label));
          // halfway through a double turn nothing is said: the second quarter is already under way (the dotted underline shows it)
          const move = next === undefined || half ? null : trig ? (trig.at === d ? spokenLabel(trig.label) : null) : spoken(next); // the end is announced by the check
          const words = move === null ? null : [...rots.map(spoken), move].join(', '); // the rotation with it: the move's letter assumes it
          if (words && words !== lastRead) { lastRead = words; say(words, keepNext); keepNext = false; }
        }
        lastBad = bad.length;
      }
      if (!line.el) continue;
      const skip = Number(line.el.dataset.skip ?? 0);
      for (const mv of line.el.querySelectorAll<HTMLElement>('.mv')) {
        const i = skip + Number(mv.dataset.i);
        mv.classList.toggle('done', i < done);
        mv.classList.toggle('half', half && i === done);
      }
    }
  }
  /** Label the named triggers (sexy, sledge...) on a built alg line: the case's moves start at move `offset` (after a [U] AUF). */
  function markTriggers(line: HTMLElement, alg: string, offset: number): void {
    const mvs = [...line.querySelectorAll<HTMLElement>('.mv')];
    for (const g of triggers(alg)) {
      const first = mvs[offset + g.at], last = mvs[offset + g.at + g.n - 1];
      if (!first || !last) continue;
      const wrap = document.createElement('span'); wrap.className = 'll-trig';
      first.before(wrap);
      for (let node: ChildNode | null = first; node; ) { const next: ChildNode | null = node.nextSibling; wrap.appendChild(node); if (node === last) break; node = next; }
      const lab = document.createElement('i'); lab.textContent = g.label; wrap.appendChild(lab);
    }
  }
  function check(txt: string): void {
    let toks: string[];
    try { toks = tokens(txt); } catch (err) { drill.flash(err instanceof Error ? err.message : String(err)); return; }
    drill.flash('');
    const alg = `${setup} ${toks.join(' ')}`;
    shown = alg;
    const { n, t, ts } = drill.attempt(txt);
    drill.result.handoff.innerHTML = ''; drill.result.body.innerHTML = '';
    let ok = done(kind, alg), note = '';
    if (kind === 'pll' && !ok) { const auf = aufToSolve(alg); if (auf) { ok = true; note = ` Solved up to the AUF: add ${auf}.`; } }
    if (!ok) {
      const rep = stageOf(state(alg));
      drill.result.show(`${TITLE[kind]} not done yet`, rep.pairs < 4 ? `F2L is broken (${rep.pairs}/4 pairs).` : rep.eoBad ? `${rep.eoBad} edge${rep.eoBad === 1 ? ' is' : 's are'} flipped.` : !rep.ocll ? 'Some corners are still not oriented.' : 'The last layer is not permuted yet.');
      render(); return;
    }
    // the case that actually came up: where the moves reached the drill's stage (an earlier start
    // solves the step before its own way, which decides the case), and the tabled fix from there
    const sp = splitAt(kind, setup, toks)!;
    const before = toks.slice(0, sp.k).join(' ');
    const hit = sp.case && sp.case !== 'skip' ? solution(kind, `${setup} ${before}`) : null;
    const step: RouteStep | null = hit ? { stage: kind, name: hit.case.name, hint: hit.case.hint, pre: hit.pre, alg: hit.case.alg, post: hit.post, case: hit.case } : null;
    const own = n - moveCount(before);
    cameUp = step?.name ?? (sp.case === 'skip' ? `${TITLE[kind]} skip` : null);
    if (!recorded) {
      recorded = true;
      results.push({ t: t ?? 0, n: own, std: step ? stepMoves(step) : own });
      drill.save({
        scramble: setup, moves: toks.join(' '), optimal: step ? stepMoves(step) : undefined, caseId: step?.name ?? (sp.case === 'skip' ? 'skip' : undefined), assisted,
        start: settings.from === kind ? undefined : settings.from as 'ocll' | 'pair', quiz: quizOutcome,
      });
      if (drill.$('practice').hasAttribute('open')) void renderPractice();
    }
    const came = sp.k ? ` (it came up after your first ${sp.k} moves)` : '';
    const what = step ? `Case: ${step.name}${came}. The standard alg is ${stepMoves(step)} moves.` : sp.case === 'skip' ? `A ${TITLE[kind]} skip${came}.` : '';
    drill.result.show(`${TITLE[kind]} done in ${own} moves${sp.k ? ` (${n} in all)` : ''}${ts}`, what + note + (assisted ? ' You peeked at the alg.' : '') + (quizSaid ? ` You said: ${quizSaid}.` : ''));
    if (speaks() && t !== null) say(`${step?.case ? spokenName(kind, step.case) : 'skip'}, ${t.toFixed(1)}`);
    if (step) putAlgLines([step], before); else drill.result.body.innerHTML = '';
    queueNext();
    if (kind === 'ocll' && stages.pll) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn eo-primary'; btn.style.marginTop = '8px';
      btn.textContent = 'Continue to PLL with this cube';
      btn.addEventListener('click', () => { shareScramble(alg, 'ocll'); showTab('pll'); window.scrollTo({ top: 0 }); });
      drill.result.handoff.appendChild(btn);
    }
    render();
  }

  function onShow(open: boolean): void {
    drill.setShowLabel(open ? 'Hide the alg' : 'Show the alg');
    if (!open) return;
    assisted = true;
    if (!sol) { drill.result.show('No tabled alg', caseText().replace(/<[^>]+>/g, '')); drill.result.body.innerHTML = ''; return; }
    const steps = [...lead, sol];
    const total = steps.reduce((a, s) => a + stepMoves(s), 0);
    drill.result.show(lead.length ? `${leadNames()}, then ${sol.name}: ${total} moves` : `${sol.name}: ${stepMoves(sol)} moves`, lead.length ? `${afterLead().slice(2)}: ${hintOf(sol)}` : hintOf(sol));
    putAlgLines(steps);
  }

  // the settings: where the drill starts (a new case at once), and the alg shown as soon as the case is
  const fromSel = drill.$('from') as HTMLSelectElement, autoBox = drill.$('auto') as HTMLInputElement, nextBox = drill.$('chain') as HTMLInputElement;
  fromSel.value = settings.from; autoBox.checked = settings.auto; nextBox.checked = settings.next;
  nextBox.addEventListener('change', () => { settings.next = nextBox.checked; saveSettings(); });
  const picBox = drill.$('showpic') as HTMLInputElement;
  picBox.checked = settings.pic;
  picBox.addEventListener('change', () => { settings.pic = picBox.checked; saveSettings(); drawPic(); });
  const repeatBox = drill.$('repeat') as HTMLInputElement;
  repeatBox.checked = settings.repeat;
  repeatBox.addEventListener('change', () => { settings.repeat = repeatBox.checked; saveSettings(); repN = 0; lastRep = null; if (settings.repeat) startRep(false); else newCase(); });
  const scrSel = drill.$('vscr') as HTMLSelectElement, algSel = drill.$('valg') as HTMLSelectElement, askBox = drill.$('ask') as HTMLInputElement;
  scrSel.value = settings.say.scramble; algSel.value = settings.say.alg; askBox.checked = settings.ask;
  // which chunks the voice names (a tick) and which it reads move by move; per chunk, kept with the settings
  function renderChunks(): void {
    const all = chunkList(), named = all.filter((c) => !settings.spell.includes(c.label)).length;
    drill.$('chunksN').textContent = named === all.length ? `all ${all.length}` : named ? `${named} of ${all.length}` : 'none, every move read';
    drill.$('chunklist').innerHTML = `<p>Ticked: said by its name when the alg reaches it. Unticked: its moves read one by one.</p>`
      + all.map((c) => `<label><input type="checkbox" data-chunk="${c.label.replace(/"/g, '&quot;')}"${settings.spell.includes(c.label) ? '' : ' checked'}> <b>${c.label}</b> <span>${c.moves}</span></label>`).join('')
      + '<div class="row"><button type="button" class="eo-link" data-chunks="all">name all</button><button type="button" class="eo-link" data-chunks="none">read all</button></div>';
  }
  drill.$('chunklist').addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.dataset.chunk) return;
    const off = new Set(settings.spell);
    if (box.checked) off.delete(box.dataset.chunk); else off.add(box.dataset.chunk);
    settings.spell = [...off]; saveSettings(); renderChunks();
  });
  drill.$('chunklist').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-chunks]');
    if (!b) return;
    settings.spell = b.dataset.chunks === 'all' ? [] : chunkList().map((c) => c.label);
    saveSettings(); renderChunks();
  });
  renderChunks();
  const sayBox = drill.$('say');
  const showSay = () => { sayBox.hidden = !settings.ask || kind !== 'pll'; };
  showSay();
  const voiceChanged = (spoken: string) => { saveSettings(); showSay(); drawPic(); standby(); if (spoken) say(spoken); };
  scrSel.addEventListener('change', () => { settings.say.scramble = scrSel.value as Mode; voiceChanged(settings.say.scramble === 'off' ? '' : `scramble: ${MODE_LABEL[settings.say.scramble]}`); });
  algSel.addEventListener('change', () => { settings.say.alg = algSel.value as Mode; voiceChanged(settings.say.alg === 'off' ? '' : `alg: ${MODE_LABEL[settings.say.alg]}`); });
  askBox.addEventListener('change', () => { settings.ask = askBox.checked; voiceChanged(settings.ask ? `I will ask the case${activeSource() ? '' : '. say ready when the cube is scrambled'}` : ''); });
  fromSel.addEventListener('change', () => { settings.from = fromSel.value as LLStart; saveSettings(); newCase(); });
  autoBox.addEventListener('change', () => { settings.auto = autoBox.checked; saveSettings(); if (settings.auto && sol && !drill.showOpen()) drill.$('showSol').click(); });

  // the case list, as a chip after the hints: tap a case there to drill it
  const refBtn = document.createElement('button'); refBtn.type = 'button'; refBtn.className = 'eo-chip'; refBtn.id = id('ref');
  refBtn.textContent = `All ${CASES[kind].length} cases`;
  // a case's main alg changed (starred there, or synced from another device): the case on show is re-derived (a rep restarts on its new alg)
  const favChanged = () => { if (settings.repeat) startRep(false); else load(setup); };
  refBtn.addEventListener('click', () => openLLReference(kind, (alg) => { load(alg); window.scrollTo({ top: 0 }); }, favChanged));
  onFavsChange(favChanged);
  // a note written (here or on another device) while a case is up: the panel is rebuilt with it
  onNotesChange(() => { if (drill.showOpen() && sol) onShow(true); });
  drill.$('hints').appendChild(refBtn);
  onSchemeChange(render);
  if (settings.repeat) startRep(false); else newCase();
  return {
    // a rep's scramble is the setup itself, the cube's own state, even when that is solved ('')
    load, render, scramble: () => (settings.repeat ? setup : scramble || setup || null), newScramble: () => (settings.repeat ? startRep(true) : newCase()), watch,
    feed: (text, t, source) => {
      // a rep lined up first (a U turn or two before the alg, as in a solve): the rep starts from there instead
      if (settings.repeat && absorbAuf(text)) return false;
      heard(text);
      const r = drill.feed(text, t, source);
      // a rep undone back to its start re-arms with no moves, which clears the panel: the alg stays on show here
      if (settings.repeat && !drill.result.visible()) drill.result.show(drill.$('rTitle').textContent ?? '', drill.$('rSub').textContent ?? '');
      if (!r) followAlg(text);
      return r;
    },
    // the cube is at the scramble: the voice reads the first move of the alg on show
    armed: (t) => { drill.armed(t); fedCount = 0; armedNow = true; offTurns = []; if (settings.ask && !settings.repeat) askCase(); else followAlg(''); },
  };
}

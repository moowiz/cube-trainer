// The last-layer drill, mounted twice: once as the OCLL tab, once as PLL.
// A case (random, or a cube handed over by a scan or the previous stage),
// the top-down last-layer diagram in the trainer's colour scheme, hints
// that reveal the case, Check on the moves typed, and the standard alg with
// its AUFs in brackets. The drill scaffold owns timer, box, result, keys.
//
// Two settings, inline after the hints and kept per drill: where the drill
// starts (its own stage, or the step before - the corners to orient, the
// last pair to insert - so the case has to be recognised after solving that
// your own way, as in a solve) and whether the alg shows as soon as the case
// does (learning the alg rather than the recognition).
//
// The picture is the cube in 3D, seen from above (the last layer is what
// matters, the sides show the case's bars and headlights), turned to the open
// slot when a pair is out; with F2L solved the top-down diagram sits under
// it, arrows and all. The scramble is a short face-turn sequence for the
// state (not an alg backwards, which would give the case away) and is
// followed on a smart cube like the Solve tab's: turns done are underlined.

import { moveCount, tokens } from '../cube/alg';
import { toWca, WCA_HOLD } from '../cube/frame';
import { STICKERS } from '../cube/geometry';
import { DEFAULT_VIEW, orbit, render3d, type View } from '../cube/render';
import { faceColorName, faceHex, onSchemeChange } from '../cube/scheme';
import { faceTurns, state } from '../cube/state';
import { hold } from '../app/context';
import { SLOTS, slotSolved } from '../f2l/model';
import { toSourceLetters } from '../handoff';
import { stageOf } from '../stage';
import { shareScramble, showTab, type Stage, stages } from '../shell';
import { ScrambleTracker, type TrackStatus } from '../timer/track';
import { moveHtml } from '../timer/trainer';
import type { ColorName } from '../types';
import type { FaceId } from '../cube/frame';
import { mountDrill } from '../ui/drill';
import { triggers } from '../ui/fingertricks';
import { CASES, type LLKind } from './cases';
import { aufToSolve, done, type LLStart, randomSetup, type RouteStep, route, scrambleFor, solution, splitAt, START_LABEL, STARTS, stepMoves, stepPlain, stepShown } from './model';
import { ensurePicStyle, picSvg } from './pic';
import { openLLReference } from './reference';

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };
const BLURB: Record<LLKind, string> = {
  ocll: 'Orient the last layer’s corners. After EO the edges are already oriented, so there are 7 cases.',
  pll: 'Permute the last layer: 21 cases. Finish with the AUF so the cube is solved.',
};

const STYLE = `
  .ll-3d { max-width: 250px; }
  .ll-pic { max-width: 180px; margin: 6px auto 0; }
  .ll-scr .done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .ll-scr .mv .p { color: #B3261E; font-weight: 600; } .ll-scr .mv .d { color: #1A56B8; font-weight: 600; }
  .ll-scr .done .p, .ll-scr .done .d { color: inherit; font-weight: 400; }
  .ll-track { font-size: 13px; color: var(--ink-2); padding: 0 4px 6px; min-height: 18px; }
  .ll-track.off { color: #7A4B00; font-weight: 600; }
  .ll-case { font-size: 16px; min-height: 22px; }
  .ll-trig { display: inline-block; position: relative; padding: 0 2px 13px; margin: 0 2px; border-bottom: 2px solid var(--ink-2); line-height: 1.3; }
  .ll-trig i { position: absolute; left: 0; right: 0; bottom: -1px; font-size: 11px; font-style: normal; line-height: 1; text-align: center; white-space: nowrap; color: var(--ink-2); word-spacing: normal; letter-spacing: .02em; }
  .ll-case b { font-weight: 600; }
  .ll-opts { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; margin: 0 2px 10px; font-size: 13px; color: var(--ink-2); }
  .ll-opts label { display: inline-flex; align-items: center; gap: 6px; }
  .ll-opts select { font: inherit; font-size: 13px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
  .ll-step { font-size: 13px; color: var(--ink-2); margin-top: 8px; } .ll-step b { color: var(--ink); font-weight: 600; }
`;

interface Settings { from: LLStart; auto: boolean }

export function mountLL(root: HTMLElement, kind: LLKind): Stage {
  if (!document.getElementById('ll-style')) {
    const s = document.createElement('style'); s.id = 'll-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  ensurePicStyle();
  const id = (n: string) => `${kind}-${n}`;
  const SETTINGS_KEY = `zz-${kind}-settings`;
  const settings: Settings = { from: kind, auto: false };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* no storage */ }
  if (!STARTS[kind].includes(settings.from)) settings.from = kind;
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* no storage */ } };
  const drill = mountDrill(root, {
    id: kind, stage: kind, title: TITLE[kind], blurb: BLURB[kind], newLabel: 'New case',
    hints: [{ key: 'name', label: 'Hint: case name' }, { key: 'look', label: 'Hint: what to look for' }],
    movesLabel: 'Moves you did', placeholder: kind === 'pll' ? "e.g. U R U R' U' R' F R2 U' R' U' R U R' F' U2" : "e.g. U2 R U R' U R U2 R'",
    note: 'Solve it on your cube. Space starts and stops the timer, N is a new case.',
    showLabel: 'Show the alg',
    afterHints: `
      <div class="ll-opts">
        <label>Start from <select id="${id('from')}">${STARTS[kind].map((f) => `<option value="${f}">${START_LABEL[f]}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="${id('auto')}"> Show the alg right away</label>
      </div>`,
    left: `
      <div class="eo-stage ll-3d" id="${id('stage')}"><svg id="${id('cube')}" viewBox="-170 -170 340 340" aria-label="cube"></svg></div>
      <div class="ll-pic"><svg id="${id('pic')}" viewBox="0 0 200 200" aria-label="last layer"></svg></div>
      <div class="eo-status"><div class="ll-case" id="${id('case')}"></div><div class="eo-timer" id="${id('timer')}">0.00</div></div>
      <div class="eo-scramble ll-scr" id="${id('setup')}"></div>
      <div class="ll-track" id="${id('track')}"></div>
      <p class="eo-note" id="${id('orient')}"></p>`,
  }, { onNew: newCase, onCheck: check, onHint: hintText, onShow: onShow, onClear: () => { shown = null; render(); },
    // a cube feeding the box is done when the case is (the AUF included: it is timed too)
    isDone: (txt) => { try { return done(kind, `${setup} ${tokens(txt).join(' ')}`); } catch { return false; } },
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
  let cameUp: string | null = null; // the case the moves checked actually reached (an earlier start decides it by how the step before was solved)
  const results: { t: number; n: number; std: number }[] = [];

  // the cube in 3D from above (DECISION: rx 50, the top face large and the sides still readable), turned
  // to the open slot when a pair is out; the top-down diagram under it once only the last layer is left
  const TOP_VIEW: View = { rx: 50, ry: DEFAULT_VIEW.ry };
  const view: View = { ...TOP_VIEW };
  const SLOT_RY: Record<string, number> = { FR: -35, FL: 35, BR: -125, BL: 125 };
  function drawPic(): void {
    const f = state(shown ?? setup);
    const r = stageOf(f);
    render3d(drill.$('cube') as unknown as SVGSVGElement, STICKERS.map((st) => ({ fill: faceHex(f[st.idx]!) })), view);
    const ll = r.pairs === 4 && r.eoBad === 0;
    drill.$('pic').parentElement!.hidden = !ll;
    if (ll) drill.$('pic').innerHTML = picSvg(f, kind);
  }
  orbit(drill.$('cube') as unknown as SVGSVGElement, view, drawPic);

  const leadNames = () => lead.map((s) => s.name).join(', then ');
  /** ", after Sune by the standard algs" - what the case named depends on when the drill starts earlier. */
  const afterLead = () => (lead.length ? `, after ${leadNames()} by the standard alg${lead.length > 1 ? 's' : ''}` : '');
  function caseText(): string {
    if (recorded && cameUp) return `<b>${cameUp}</b>`;
    if (sol) return `<b>${sol.name}</b>${afterLead()}`;
    const r = stageOf(state(setup));
    if (r.stage === 'solved') return kind === 'pll' ? 'Solved already: a PLL skip.' : 'Solved already.';
    if (kind === 'ocll' && r.stage === 'pll') return 'Corners already oriented: an OCLL skip.';
    return `Not ${kind === 'ocll' ? 'an' : 'a'} ${TITLE[kind]} case: this cube is at ${r.stage === 'eo' ? 'EO' : r.stage === 'f2l' ? 'F2L' : r.stage.toUpperCase()}.`;
  }

  function render(): void {
    drawPic();
    const named = root.querySelector('.eo-chip[data-hint="name"].open');
    drill.$('case').innerHTML = named || (drill.result.visible() && recorded) || !sol ? caseText() : '';
    renderScramble();
    drill.$('orient').textContent = `Apply the scramble to a solved cube held ${WCA_HOLD}, then turn it white down with ${faceColorName('F')} facing you (${faceColorName('R')} on the right). Or just make the ${lead.some((s) => s.stage === 'pair') ? 'cube' : 'top layer'} match the picture.`;
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, ms = results.reduce((a, r) => a + r.std, 0) / results.length;
      drill.setStats(`This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (standard algs mean ${ms.toFixed(1)}).`);
    } else drill.setStats('');
  }

  // ---- the scramble, and following it on a smart cube (as the Solve tab does) ----
  function renderScramble(): void {
    const su = drill.$('setup'), tr = drill.$('track');
    if (!setup) { su.innerHTML = ''; tr.textContent = ''; return; }
    if (scramble === null) { su.innerHTML = 'Scramble: <span>…</span>'; tr.textContent = ''; return; }
    const toks = toWca(scramble).split(' ').filter(Boolean);
    const applied = track ? track.applied : 0;
    su.innerHTML = `Scramble: ${toks.map((t, i) => `<span class="${track && i < applied ? 'done' : ''}">${moveHtml(t)}</span>`).join(' ')}`;
    if (!track) { tr.textContent = ''; tr.className = 'll-track'; return; }
    tr.className = track.off ? 'll-track off' : 'll-track';
    tr.textContent = track.off ? `Off the scramble: undo back to turn ${track.applied} (underlined)` : track.matched ? 'Scrambled ✓' : track.half ? `${track.applied} of ${track.total} applied · halfway through ${toks[track.applied]}` : `${track.applied} of ${track.total} applied`;
  }
  let tracker: ScrambleTracker | null = null, trackKey = '', track: TrackStatus | null = null;
  function watch(facelets: string | null, colourOf: Record<FaceId, ColorName>): void {
    if (!scramble) { track = null; return; }
    const key = `${scramble}|${Object.values(colourOf).join(',')}|${hold().front}`;
    if (key !== trackKey) {
      try { tracker = new ScrambleTracker(toSourceLetters(colourOf, scramble, hold())); trackKey = key; }
      catch { tracker = null; trackKey = ''; }
    }
    track = tracker ? tracker.status(facelets) : null;
    renderScramble();
  }

  /** Show the state after `alg`: worked from as face turns only, so the moves after it read in one frame (a V perm's y). */
  function load(alg: string): void {
    setup = faceTurns(alg);
    const steps = route(kind, setup);
    sol = steps?.[steps.length - 1] ?? null; lead = steps?.slice(0, -1) ?? [];
    shown = null; assisted = false; recorded = false; cameUp = null;
    const open = SLOTS.find((sl) => !slotSolved(state(setup), sl));
    view.rx = TOP_VIEW.rx; view.ry = open ? SLOT_RY[open]! : TOP_VIEW.ry;
    // the setup is an alg backwards (an N perm, then the OCLL case): the drill shows a short
    // face-turn scramble for the same state instead. DECISION: solved on a timeout, not here:
    // the first solve builds the pruning tables (~500 ms), which would otherwise sit in the page's mount.
    scramble = null; track = null;
    const gen = ++scrambleGen;
    setTimeout(() => { if (gen !== scrambleGen) return; scramble = scrambleFor(setup); render(); });
    drill.begin();
    render();
    if (settings.auto && sol) drill.$('showSol').click();
  }
  function newCase(): void { const r = randomSetup(kind, Math.random, settings.from); load(r.setup); shareScramble(setup, kind); }

  const AUF_NOTE = ` <small>[U] is the AUF: turn the top layer that way first, the alg is what follows${kind === 'pll' ? '; a bracket at the end lines the layer up after it' : ''}.</small>`;
  /**
   * The steps as listed lines, [AUF]s in brackets, triggers labelled, each line applying the route
   * so far (from `before`, moves already done from the setup) so ▶ and the peek show the right cube.
   */
  function putAlgLines(steps: RouteStep[], before = ''): void {
    const body = drill.result.body; body.innerHTML = '';
    let sofar = before;
    for (const s of steps) {
      if (steps.length > 1) body.insertAdjacentHTML('beforeend', `<div class="ll-step"><b>${s.name}</b> · ${stepMoves(s)} moves</div>`);
      const d = drill.algLine(stepShown(s), `${sofar} ${stepPlain(s)}`.trim(), sofar ? tokens(sofar).length : 0); d.classList.add('ll-alg');
      markTriggers(d, s.alg, s.pre ? 1 : 0);
      body.appendChild(d);
      sofar = `${sofar} ${stepPlain(s)}`.trim();
    }
    if (steps.some((s) => s.pre || s.post)) body.lastElementChild?.insertAdjacentHTML('beforeend', AUF_NOTE);
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
    const step: RouteStep | null = hit ? { stage: kind, name: hit.case.name, hint: hit.case.hint, pre: hit.pre, alg: hit.case.alg, post: hit.post } : null;
    const own = n - moveCount(before);
    cameUp = step?.name ?? (sp.case === 'skip' ? `${TITLE[kind]} skip` : null);
    if (!recorded) {
      recorded = true;
      results.push({ t: t ?? 0, n: own, std: step ? stepMoves(step) : own });
      drill.save({ scramble: setup, moves: toks.join(' '), optimal: step ? stepMoves(step) : undefined, caseId: step?.name ?? (sp.case === 'skip' ? 'skip' : undefined), assisted });
    }
    const came = sp.k ? ` (it came up after your first ${sp.k} moves)` : '';
    const what = step ? `Case: ${step.name}${came}. The standard alg is ${stepMoves(step)} moves.` : sp.case === 'skip' ? `A ${TITLE[kind]} skip${came}.` : '';
    drill.result.show(`${TITLE[kind]} done in ${own} moves${sp.k ? ` (${n} in all)` : ''}${ts}`, what + note + (assisted ? ' You peeked at the alg.' : ''));
    if (step) putAlgLines([step], before); else drill.result.body.innerHTML = '';
    if (kind === 'ocll' && stages.pll) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn eo-primary'; btn.style.marginTop = '8px';
      btn.textContent = 'Continue to PLL with this cube';
      btn.addEventListener('click', () => { shareScramble(alg, 'ocll'); showTab('pll'); window.scrollTo({ top: 0 }); });
      drill.result.handoff.appendChild(btn);
    }
    render();
  }

  function hintText(key: string): string {
    const plain = caseText().replace(/<[^>]+>/g, '');
    if (key === 'name') { setTimeout(render); return sol ? `${sol.name}${afterLead()}` : plain; }
    return sol ? `${lead.length ? `${afterLead().slice(2)}: ` : ''}${sol.hint}` : plain;
  }

  function onShow(open: boolean): void {
    drill.setShowLabel(open ? 'Hide the alg' : 'Show the alg');
    if (!open) return;
    assisted = true;
    if (!sol) { drill.result.show('No tabled alg', caseText().replace(/<[^>]+>/g, '')); drill.result.body.innerHTML = ''; return; }
    const steps = [...lead, sol];
    const total = steps.reduce((a, s) => a + stepMoves(s), 0);
    drill.result.show(lead.length ? `${leadNames()}, then ${sol.name}: ${total} moves` : `${sol.name}: ${stepMoves(sol)} moves`, lead.length ? `${afterLead().slice(2)}: ${sol.hint}` : sol.hint);
    putAlgLines(steps);
  }

  // the settings: where the drill starts (a new case at once), and the alg shown as soon as the case is
  const fromSel = drill.$('from') as HTMLSelectElement, autoBox = drill.$('auto') as HTMLInputElement;
  fromSel.value = settings.from; autoBox.checked = settings.auto;
  fromSel.addEventListener('change', () => { settings.from = fromSel.value as LLStart; saveSettings(); newCase(); });
  autoBox.addEventListener('change', () => { settings.auto = autoBox.checked; saveSettings(); if (settings.auto && sol && !drill.showOpen()) drill.$('showSol').click(); });

  // the case list, as a chip after the hints: tap a case there to drill it
  const refBtn = document.createElement('button'); refBtn.type = 'button'; refBtn.className = 'eo-chip'; refBtn.id = id('ref');
  refBtn.textContent = `All ${CASES[kind].length} cases`;
  refBtn.addEventListener('click', () => openLLReference(kind, (alg) => { load(alg); window.scrollTo({ top: 0 }); }));
  drill.$('hints').appendChild(refBtn);
  onSchemeChange(render);
  newCase();
  return { load, render, scramble: () => scramble || setup || null, newScramble: newCase, feed: (text, t, source) => drill.feed(text, t, source), armed: (t) => drill.armed(t), watch };
}

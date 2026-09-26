// The ZZF2L case finder: tap where the pair's corner and edge are (3D or
// net) and get the sheet's alg with the AUF adjusted, or track a scrambled
// cube (from the EO trainer, a scan, or the scramble box) and have the pieces
// filled in as each pair is done. On a smart cube (or the camera reader)
// nothing is pressed: the scramble is followed as the Solve tab follows
// one, the cube's turns keep the tracked cube, each pair's case is read
// off it, and the alg being done lights up and is followed move by move
// as in the last-layer drills (cube/route.ts). The logic is model.ts; this
// file is the markup, the pictures, the result panel, and the URL /
// localStorage state.
//
// Frames: the trainer works white down with the chosen colour in front (all
// algs, the tracked cube, what the shell sees). The scramble BOX is WCA
// (white up, green front), the way scrambles are applied at a competition,
// so it is converted on the way in and out.

import { moveCount, tokens } from '../cube/alg';
import { fromWca, toWca, WCA_HOLD } from '../cube/frame';
import { offList, offRoute, routeProgress, wrongTurns } from '../cube/route';
import { pieceType, posName, STICKERS, type Sticker } from '../cube/geometry';
import { clickedFacelet, DEFAULT_VIEW, orbit, render3d, renderNet, type Cell, type View } from '../cube/render';
import { faceColorName, faceHex, onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { stageOf } from '../stage';
import { shareScramble, showTab, type Stage, stages } from '../shell';
import { openFingertricks } from '../ui/fingertricks';
import { DATA } from './data';
import {
  acnUrl, describe, explain, findCase, fullAlg, genF2L, isSlot, normalizeAlg, randomCase, slotOf, slotSolved, slotState,
  SLOT_WORD, SLOTS, trace, withAuf, type CornerState, type CornerOrient, type F2LCase, type LookupHit, type SlotName,
} from './model';
import { ensureStyle, scoped } from '../ui/dom';
import { readStored, writeStored } from '../ui/settings';
import { hold as holdOf } from '../app/context';
import { activeSource, onSourceChange } from '../app/sources';
import type { TrackStatus } from '../timer/track';
import { makeTrackWatcher, markRouteDone, moveHtml, scrambleHtml, trackText } from '../timer/track-ui';
import type { ColorName, FaceId } from '../types';

const GREY = '#DDE1E7'; // the page's --grey-ll: SVG fill attributes cannot read a CSS variable
const STORE_KEY = 'zzf2l-state';

// the page's F2L rules, scoped to the panel; the .st colour classes are gone (stickers are painted with faceHex)
const STYLE = `
  .f2l header { max-width: 900px; margin: 0 auto 18px; }
  .f2l h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .f2l header p { margin: 0; color: var(--ink-2); font-size: 15px; max-width: 60ch; line-height: 1.45; }
  .f2l main { max-width: 900px; margin: 0 auto; display: grid; grid-template-columns: 340px 1fr; gap: 28px; align-items: start; }
  @media (max-width: 760px) { .f2l main { grid-template-columns: 1fr; gap: 20px; } }
  .f2l button.btn { font: inherit; font-size: 14px; padding: 7px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
  .f2l button.btn:hover { border-color: var(--ink-2); }
  .f2l button.btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .f2l .legend { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 14px; color: var(--ink-2); }
  .f2l .legend .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }
  .f2l .controls { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .f2l .stage { width: 100%; max-width: 340px; height: 290px; touch-action: none; cursor: grab; }
  .f2l .stage:active { cursor: grabbing; }
  .f2l .stage svg { width: 100%; height: 100%; display: block; touch-action: none; -webkit-user-select: none; user-select: none; }
  .f2l .stage polygon { touch-action: none; stroke: #2b3340; stroke-width: 1.2; stroke-linejoin: round; cursor: pointer; }
  .f2l .stage polygon.center { cursor: default; }
  .f2l .stage polygon.solved { fill-opacity: .85; }
  .f2l .stage polygon.pair { stroke: var(--ink); stroke-width: 3; }
  .f2l .stage polygon.hit:hover { stroke-width: 2.5; stroke: var(--ink-2); }
  .f2l .stage polygon:focus-visible, .f2l .net rect:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .f2l .views { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .f2l .views button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; }
  .f2l .views button:hover { border-color: var(--ink-2); }
  .f2l .views span { font-size: 13px; color: var(--ink-2); align-self: center; }
  .f2l .netwrap { margin-top: 18px; }
  .f2l .netwrap summary { font-size: 14px; color: var(--ink-2); cursor: pointer; margin-bottom: 10px; }
  .f2l .net { max-width: 340px; user-select: none; }
  .f2l .net svg { width: 100%; height: auto; display: block; }
  .f2l .net rect { stroke: #2b3340; stroke-width: 1; cursor: pointer; }
  .f2l .net rect.center { cursor: default; }
  .f2l .net rect.solved { opacity: .38; cursor: default; }
  .f2l .net rect.pair { stroke: var(--ink); stroke-width: 2.5; }
  .f2l .net rect.hit:hover { stroke: var(--ink-2); stroke-width: 2; }
  .f2l .tracker { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .f2l .tracker > span { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; padding: 7px 12px 7px 8px; border-radius: 999px; border: 1.5px solid var(--line); color: var(--ink-2); background: var(--panel); cursor: pointer; }
  .f2l .tracker > span.done { opacity: .45; text-decoration: line-through; cursor: default; }
  .f2l .tracker > span.cur { color: var(--ink); border-color: var(--ink); box-shadow: 0 0 0 2px var(--ink); font-weight: 600; }
  .f2l .tracker .sw3 { display: inline-flex; gap: 2px; }
  .f2l .tracker .sw3 i { display: block; width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(0,0,0,.15); }
  .f2l .nextbtn { margin-top: 14px; font: inherit; font-size: 15px; font-weight: 600; padding: 10px 16px; border-radius: 8px; border: 0; background: var(--ink); color: #fff; cursor: pointer; }
  .f2l .nextbtn:hover { background: #2c3644; }
  .f2l .nextbtn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .f2l .pairrow { margin: 12px 0 0; display: flex; flex-direction: column; gap: 6px; max-width: 420px; }
  .f2l .pairrow label { font-size: 14px; color: var(--ink-2); }
  .f2l .bigsel { font: inherit; font-size: 18px; font-weight: 500; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); width: 100%; }
  .f2l .bigsel:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .f2l .principles { margin-top: 12px; max-width: 62ch; }
  .f2l .principles summary { font-size: 14px; color: var(--ink-2); cursor: pointer; }
  .f2l .principles ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; line-height: 1.5; color: var(--ink-2); }
  .f2l .principles li { margin-bottom: 6px; } .f2l .principles b { color: var(--ink); }
  .f2l .hintbox { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--ink); border-radius: 0 8px 8px 0; padding: 10px 12px; margin-bottom: 12px; font-size: 14px; line-height: 1.5; }
  .f2l .hintbox b { font-weight: 600; }
  .f2l .tracewrap { margin: -4px 0 12px; overflow-x: auto; }
  .f2l .trace { border-collapse: collapse; font-size: 13px; width: 100%; }
  .f2l .trace th { text-align: left; font-weight: 600; color: var(--ink-2); padding: 4px 8px; border-bottom: 1px solid var(--line); }
  .f2l .trace td { padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .f2l .trace td:first-child { font-weight: 600; white-space: nowrap; }
  .f2l .why { background: var(--panel); border-left: 3px solid var(--ink); padding: 10px 12px; margin: -4px 0 8px; font-size: 14px; line-height: 1.5; color: var(--ink); border-radius: 0 6px 6px 0; }
  .f2l .why b { font-weight: 600; }
  .f2l .scr { margin-top: 12px; max-width: 520px; display: flex; flex-direction: column; gap: 6px; }
  .f2l .scrbtns { display: flex; gap: 8px; flex-wrap: wrap; }
  .f2l .scrmsg { margin: 0; font-size: 14px; color: var(--ink-2); min-height: 1.2em; }
  .f2l .scrmsg.bad { color: #B3261E; }
  .f2l .scrfollow { margin: 0; font-size: 15px; letter-spacing: .02em; word-spacing: .12em; line-height: 1.8; }
  .f2l .scrfollow .done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .f2l .scrfollow .mv .p { color: #B3261E; font-weight: 600; } .f2l .scrfollow .mv .d { color: #1A56B8; font-weight: 600; }
  .f2l .scrfollow .done .p, .f2l .scrfollow .done .d { color: inherit; font-weight: 400; }
  .f2l .scrfollow small { display: block; font-size: 13px; color: var(--ink-2); letter-spacing: 0; word-spacing: 0; line-height: 1.4; }
  .f2l .scrfollow small.off, .f2l .offalg { color: #7A4B00; font-weight: 600; }
  .f2l .offalg { font-size: 14px; margin: 0 0 8px; } .f2l .offalg .mv { padding: 0 2px; }
  .f2l .trackbadge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--ink); color: #fff; margin-left: 8px; vertical-align: middle; }
  .f2l .result { min-height: 200px; }
  .f2l .hint { color: var(--ink-2); font-size: 15px; line-height: 1.5; max-width: 48ch; }
  .f2l .case-title { display: flex; align-items: baseline; gap: 12px; margin: 0 0 4px; }
  .f2l .case-title h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .f2l .case-title span { color: var(--ink-2); font-size: 14px; }
  .f2l .where { color: var(--ink-2); font-size: 14px; margin: 0 0 14px; }
  .f2l .alg { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  .f2l .alg .txt { font-size: 17px; font-weight: 500; letter-spacing: .02em; flex: 1; word-spacing: .12em; }
  .f2l .alg .txt .auf { color: var(--ink-2); font-weight: 400; }
  .f2l .alg .txt .mv.done { color: var(--ink-2); text-decoration: underline; text-underline-offset: 4px; }
  .f2l .alg .txt .mv.half { text-decoration: underline dotted; text-underline-offset: 4px; }
  .f2l .alg .n { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
  .f2l .alg.on { border-color: var(--ink); box-shadow: 0 0 0 1.5px var(--ink); }
  .f2l .alg.dim { opacity: .5; }
  .f2l .alg .tag { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
  .f2l .alg a, .f2l .alg button { font: inherit; font-size: 12px; color: var(--ink-2); background: none; border: 1px solid var(--line); border-radius: 5px; padding: 4px 8px; cursor: pointer; text-decoration: none; white-space: nowrap; }
  .f2l .alg a:hover, .f2l .alg button:hover { color: var(--ink); border-color: var(--ink-2); }
  .f2l .alg a:focus-visible, .f2l .alg button:focus-visible { outline: 2px solid var(--ink); }
  .f2l h3 { font-size: 14px; font-weight: 600; color: var(--ink-2); margin: 18px 0 8px; }
  .f2l .note { font-size: 14px; color: var(--ink-2); margin: 6px 0 0; }
  .f2l .sheet { font-size: 13px; margin-top: 18px; }
  .f2l .sheet a { color: var(--ink-2); }
`;

const MARKUP = `
<header>
  <h1>ZZF2L case finder</h1>
  <p>Tap the facelet where the <b>white</b> sticker of your corner is, then tap where the <span id="edgename">green-red</span> edge is. White stays on the bottom.</p>
  <p style="margin-top:8px">All four slots start open, like right after EOCross. A practice scramble keeps EO and the cross solved and is tracked from the moment it is made; on a smart cube the pieces follow your turns. Solve a pair on your cube, press <b>Solved, next pair</b>, and it's marked done.</p>
  <div class="tracker" id="tracker"></div>
  <details class="principles"><summary>The principles behind the cases</summary>
    <ol>
      <li><b>EO is done, so no F/B quarter turns.</b> Edge orientation stops being a variable: a top-layer edge always has its front/back colour facing up, and a slotted edge always has it facing front/back. You only ever need to know <i>where</i> the edge is.</li>
      <li><b>A case is corner orientation first, edge position second.</b> Three corner states: white facing front/back, white facing right/left, white facing up (the awkward one).</li>
      <li><b>There are only two inserts.</b> For the front-right pair: R U R' (white on the right, edge at the back) and R U' R' (white on the front, edge on the right). Every other alg is "get to one of these pictures, then do it". The other slots use the same two moves mirrored.</li>
      <li><b>White up needs a tilt.</b> Either split and re-pair with an R U' R' / R U2 R' style move, or use F2, which flips white from up to down while keeping EO.</li>
      <li><b>A solved corner is a closed door</b> (keyhole cases). Lift it out and re-pair, crack it with an F conjugate, or rotate a helper slot underneath with D.</li>
      <li><b>Piece in the wrong slot: pop, then insert.</b> Pop with that slot's own moves (L' U L for front-left, L U L' for back-left, R' U R for back-right, and so on), chosen so the piece lands ready for a basic insert. Both in wrong slots is two pops plus an insert.</li>
      <li><b>Every D, F2, wide or F move is a conjugate:</b> set up, do RU moves, undo. D rotates a helper slot under the R layer; wide u/r shifts the middle slice so a half-turn shuffle swaps pieces between slots.</li>
      <li><b>The four slots are mirrors of each other,</b> so learn one deeply and the rest are the same hand motions reflected. Within a slot, the 12 top-layer cases plus the three pop moves cover almost everything.</li>
    </ol>
  </details>
  <div class="scr" id="scr">
    <div class="scrbtns">
      <button class="btn" type="button" id="genF2L">F2L practice scramble</button>
      <button class="btn" type="button" id="scrtricks" title="The scramble finger by finger">✋ Fingertricks</button>
    </div>
    <p class="scrfollow" id="scrfollow" hidden></p>
    <p class="scrmsg" id="scrmsg"></p>
  </div>
  <p class="pairrow"><label for="slotsel">Pair to solve</label>
    <select id="slotsel" class="bigsel"></select></p>
</header>
<main>
  <section>
    <div class="hintbox" id="hintbox" hidden></div>
    <div class="stage" id="stage"><svg id="cube3d" viewBox="-170 -170 340 340" aria-label="cube"></svg></div>
    <div class="views">
      <span>View</span>
      <button type="button" data-v="28,-35">Front</button>
      <button type="button" data-v="28,-135">Back-right</button>
      <button type="button" data-v="28,135">Back-left</button>
      <button type="button" data-v="-40,-35">Bottom</button>
      <span>or drag to rotate</span>
    </div>
    <details class="netwrap"><summary>Show as a net</summary><div class="net"><svg id="net" aria-label="cube net"></svg></div></details>
    <div class="legend">
      <span><span class="sw" style="background:#fff;box-shadow:inset 0 0 0 2px var(--ink)"></span>your pair</span>
      <span><span class="sw" id="legend-solved" style="opacity:.6"></span>already solved</span>
      <span><span class="sw" style="background:${GREY}"></span>anything else</span>
    </div>
    <div class="controls">
      <button class="btn" type="button" id="random">Random case</button>
      <button class="btn" type="button" id="reset">Clear pieces</button>
      <button class="btn" type="button" id="restart">Start over (new EOCross)</button>
    </div>
  </section>
  <section class="result" id="result" aria-live="polite"></section>
</main>`;

/** Turns as typed, checked and canonical (U2' allowed), or a readable error. */
const clean = (s: string): string => tokens(s.replace(/2'/g, '2')).join(' ');

export function mountF2L(root: HTMLElement): Stage {
  ensureStyle('f2l-style', STYLE);
  root.classList.add('f2l');
  root.innerHTML = MARKUP;
  const $ = scoped(root, (id) => `#${id}`, 'f2l markup');
  const svg = $('cube3d') as unknown as SVGSVGElement, netSvg = $('net') as unknown as SVGSVGElement;
  let scrWca = ''; // the scramble on show, WCA letters (the hold it is applied in); '' for none
  // the two checkboxes live in the page's settings sheet, outside root; absent means the defaults
  const showHints = () => (document.getElementById('showhints') as HTMLInputElement | null)?.checked ?? true;
  const advanced = () => (document.getElementById('advanced') as HTMLInputElement | null)?.checked ?? false;

  // ---- state ----
  let slot: SlotName = 'FR';
  let solvedSlots = new Set<SlotName>();
  let corner: CornerState | null = null, edge: string | null = null;
  let currentHit: LookupHit | null = null;
  let restoring = false;
  // tracking: the cube is an alg from solved - the scramble, the EOCross moves, then every alg pressed - kept in WCA
  // letters (the physical turns) so a change of front colour re-reads the same cube in the new trainer frame
  let tracked: { scr: string; pre: string; hist: string[] } | null = null;
  const trackedAlg = () => (tracked ? [tracked.scr, tracked.pre, ...tracked.hist].map(fromWca).filter(Boolean).join(' ') : '');
  const cube = (): string | null => (tracked ? state(trackedAlg()) : null);
  /** Moves made on the tracked cube since the scramble and EOCross (the algs pressed, or the cube's own turns). */
  const movesDone = () => (tracked ? offList(tracked.hist.flatMap((h) => tokens(h))).length : 0); // a cube's R R is one R2
  // a cube feeding the tracked cube (app/sources.ts): its turns since the scramble are the whole of hist,
  // "Did this" is not offered, and the current pair's alg is followed from `pairAt` turns in
  let fedBy: 'cube' | 'camera' | null = null;
  let fed: string[] = [];          // the cube's turns since arming, trainer letters
  let pairAt: number | null = null; // how many of `fed` were done when the current pair's pieces were read
  const watcher = makeTrackWatcher();
  let track: TrackStatus | null = null; // where the cube is on the scramble (and the EOCross moves under it)
  const view: View = { ...DEFAULT_VIEW };
  const hold = () => `white down with ${faceColorName('F')} facing you (${faceColorName('R')} on the right)`;

  // ---- pictures ----
  function cells(): Cell[] {
    const D = DATA.slots[slot];
    const open = new Set<string>(SLOTS.filter((s) => !solvedSlots.has(s)));
    open.add(slot);
    if (corner && !corner.pos.startsWith('U')) open.add(corner.pos.slice(1));
    if (edge && !edge.startsWith('U')) open.add(edge);
    const pairFill = (letter: string) => (letter === 'D' ? '#ffffff' : faceHex(letter)); // white pops against the white-ish D
    return STICKERS.map((s) => {
      const t = pieceType(s.pos), name = posName(s.pos), sl = slotOf(s.pos);
      if (t === 'center') return { fill: faceHex(s.face), cls: 'center' };
      if (t === 'corner' && corner && name === corner.pos) return { fill: pairFill(D.cmap[`${corner.pos}-${corner.o}`]?.[s.face] ?? s.face), cls: 'pair' };
      if (t === 'edge' && edge && name === edge) return { fill: pairFill(D.emap[edge]?.[s.face] ?? s.face), cls: 'pair' };
      const solved = (s.pos[1] === -1 && (sl === null || !open.has(sl))) || (t === 'edge' && s.pos[1] === 0 && sl !== null && !open.has(sl));
      return solved ? { fill: faceHex(s.face), cls: 'solved' } : { fill: GREY, cls: 'hit' };
    });
  }
  /** Stickers are buttons: label them by colour and position, keep them reachable by keyboard. */
  function a11y(picture: SVGSVGElement): void {
    picture.querySelectorAll<SVGElement>('[data-idx]').forEach((el) => {
      const s = STICKERS[Number(el.dataset.idx)], t = pieceType(s.pos);
      el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', t === 'center' ? `${faceColorName(s.face)} centre` : `${t} ${posName(s.pos)}, ${faceColorName(s.face)} face`);
    });
  }
  function drawPictures(): void {
    const focused = document.activeElement instanceof Element && root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.idx : undefined;
    const c = cells();
    render3d(svg, c, view); a11y(svg);
    renderNet(netSvg, c); a11y(netSvg);
    if (focused !== undefined) svg.querySelector<SVGElement>(`[data-idx="${focused}"]`)?.focus();
    $('legend-solved').style.background = faceHex('F');
  }
  function onPick(s: Sticker): void {
    const t = pieceType(s.pos);
    if (t === 'center') return;
    if (t === 'corner') corner = { pos: posName(s.pos), o: (s.face === 'U' || s.face === 'D' ? 'ud' : s.face === 'R' || s.face === 'L' ? 'rl' : 'fb') as CornerOrient };
    else { if (s.pos[1] === -1) return; edge = posName(s.pos); } // the cross edges are not pair edges
    render();
  }
  const drag = orbit(svg, view, drawPictures);
  function pickAt(e: MouseEvent): void {
    const last = drag.lastDrag();
    if (last && performance.now() - last < 250) return; // a drag that ended on a sticker is not a tap
    let idx = clickedFacelet(e);
    if (idx === null) { // pointer capture retargets the click to the svg: look under the pointer instead
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-idx]');
      if (el) idx = Number(el.dataset.idx);
    }
    if (idx !== null) onPick(STICKERS[idx]);
  }
  for (const pic of [svg, netSvg]) {
    pic.addEventListener('click', pickAt);
    pic.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const idx = clickedFacelet(e);
      if (idx === null) return;
      e.preventDefault(); onPick(STICKERS[idx]);
    });
  }
  root.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => b.addEventListener('click', () => {
    const [rx, ry] = b.dataset.v!.split(',').map(Number); view.rx = rx; view.ry = ry; drawPictures();
  }));

  // ---- URL / localStorage: the same keys as before so old links keep working ----
  function saveUrl(): void {
    if (restoring) return;
    const q = new URLSearchParams();
    q.set('s', slot);
    if (solvedSlots.size) q.set('d', [...solvedSlots].join(','));
    if (corner) q.set('c', `${corner.pos}-${corner.o}`);
    if (edge) q.set('e', edge);
    if (!showHints()) q.set('h', '0');
    if (advanced()) q.set('a', '1');
    if (scrWca) { q.set('scr', scrWca); q.set('w', '1'); } // w: the scramble is WCA (old links stored the trainer frame)
    if (tracked) { q.set('t', '1'); if (tracked.hist.length) q.set('hist', tracked.hist.join('|')); } // hist is WCA too (under w=1)
    const s = q.toString();
    try { history.replaceState(null, '', `#${s}`); }
    catch { try { if (location.hash.slice(1) !== s) location.hash = s; } catch { /* no history */ } }
    writeStored(STORE_KEY, s);
  }
  function loadUrl(): void {
    let raw = '';
    try { raw = location.hash.slice(1); } catch { /* no location */ }
    if (!raw) raw = readStored(STORE_KEY) || '';
    const q = new URLSearchParams(raw);
    if (![...q.keys()].length) return;
    restoring = true;
    try {
      // 'f' (the colour scheme) is scheme.ts's now: not read here, not written
      const sh = document.getElementById('showhints') as HTMLInputElement | null, ad = document.getElementById('advanced') as HTMLInputElement | null;
      if (q.get('h') === '0' && sh) sh.checked = false;
      if (q.get('a') === '1' && ad) ad.checked = true;
      const s = q.get('s');
      if (s && isSlot(s)) slot = s;
      if (q.get('d')) solvedSlots = new Set(q.get('d')!.split(',').filter(isSlot));
      const scr = q.get('scr');
      const wca = q.get('w') === '1';
      // an old link's EOCross moves (typed under the scramble, trainer frame) fold into the scramble
      if (scr) scrWca = safe(() => clean(`${wca ? scr : toWca(clean(scr))} ${q.get('pre') ? toWca(clean(q.get('pre')!)) : ''}`)) ?? '';
      if (q.get('t') === '1' && scrWca) {
        const t = safe(() => ({
          scr: scrWca, pre: '',
          hist: q.get('hist') ? q.get('hist')!.split('|').map((h) => (wca ? normalizeAlg(h) : toWca(normalizeAlg(h)))) : [],
        }));
        if (t) {
          tracked = t;
          const r = stageOf(state(trackedAlg()));
          if (r.eoBad === 0 && r.cross === 4) trackMsg('Tracking restored from the page address.');
          else tracked = null;
        }
      }
      const c = q.get('c');
      if (c) { const [pos, o] = c.split('-'); if (DATA.slots[slot].cmap[`${pos}-${o}`]) corner = { pos, o: o as CornerOrient }; }
      const e = q.get('e');
      if (e && DATA.slots[slot].emap[e]) edge = e;
      fillSlotSelect(); updateEdgeName();
    } catch (err) { console.error(err); }
    restoring = false;
  }
  const safe = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };

  // ---- the header: tracker chips, slot select, scramble panel ----
  function renderTracker(): void {
    const t = $('tracker'); t.innerHTML = '';
    for (const s of SLOTS) {
      const el = document.createElement('span');
      const sw = document.createElement('span'); sw.className = 'sw3';
      for (const col of ['#fff', faceHex(s[0]), faceHex(s[1])]) { const i = document.createElement('i'); i.style.background = col; sw.appendChild(i); }
      el.appendChild(sw); el.appendChild(document.createTextNode(SLOT_WORD[s]));
      el.setAttribute('aria-label', `white-${faceColorName(s[0])}-${faceColorName(s[1])} ${SLOT_WORD[s]}`);
      if (solvedSlots.has(s)) el.classList.add('done');
      else {
        if (s === slot) el.classList.add('cur');
        el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
        const pick = () => { slot = s; corner = null; edge = null; fillSlotSelect(); updateEdgeName(); if (tracked) syncFromCube(); else render(); };
        el.addEventListener('click', pick);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      }
      t.appendChild(el);
    }
  }
  function fillSlotSelect(): void {
    const sel = $<HTMLSelectElement>('slotsel'); sel.innerHTML = '';
    for (const s of SLOTS) {
      if (solvedSlots.has(s)) continue;
      const o = document.createElement('option'); o.value = s;
      o.textContent = `white-${faceColorName(s[0])}-${faceColorName(s[1])} (${SLOT_WORD[s]})`;
      if (s === slot) o.selected = true;
      sel.appendChild(o);
    }
  }
  function updateEdgeName(): void {
    $('edgename').textContent = `${faceColorName(slot[0])}-${faceColorName(slot[1])}`;
  }
  function trackMsg(t: string, bad = false): void { const m = $('scrmsg'); m.textContent = t; m.className = `scrmsg${bad ? ' bad' : ''}`; }

  // ---- tracking ----
  /** The tracked cube is not at F2L yet (a cube followed from its scramble, EOCross still to do): what is left, or null. */
  function beforeF2L(): string | null {
    const f = cube();
    if (!f) return null;
    const r = stageOf(f);
    if (r.eoBad === 0 && r.cross === 4) return null;
    const parts = [r.eoBad > 0 ? `${r.eoBad} edge${r.eoBad === 1 ? '' : 's'} to flip` : '', r.cross < 4 ? `${4 - r.cross} cross edge${r.cross === 3 ? '' : 's'} to place` : ''].filter(Boolean);
    return `Solve EOCross on your cube first: ${parts.join(', ')}. The pairs are read off the cube once it is done.`;
  }
  function syncFromCube(): void {
    const f = cube();
    if (!f) return;
    if (beforeF2L()) { corner = null; edge = null; pairAt = null; render(); return; }
    for (const s of SLOTS) if (slotSolved(f, s)) solvedSlots.add(s); else solvedSlots.delete(s);
    if (solvedSlots.has(slot)) { const nx = SLOTS.find((s) => !solvedSlots.has(s)); if (nx) slot = nx; }
    fillSlotSelect(); updateEdgeName();
    if (!solvedSlots.has(slot)) { const s = slotState(f, slot); corner = s.corner; edge = s.edge; }
    else { corner = null; edge = null; }
    pairAt = fed.length; // the pair's alg is followed from here
    render();
  }
  /** Track the scramble on show (from solved): the pieces are read off it. A scramble not at EOCross is kept, untracked, for a cube to do. */
  function applyScramble(): void {
    if (!scrWca) { trackMsg('Make a scramble first.', true); return; }
    const t = { scr: scrWca, pre: '', hist: [] };
    const r = stageOf(state(fromWca(t.scr)));
    if (r.eoBad > 0 || r.cross < 4) {
      trackMsg(activeSource() ? 'EOCross is not solved on this scramble: do it on your cube, then solve EOCross, and the pairs are read off the cube.' : 'EOCross is not solved on this scramble. Solve it in the EO tab: finishing EO and the cross brings the cube back here.', true);
      return;
    }
    tracked = t; solvedSlots = new Set(); fed = []; fedBy = null; pairAt = null;
    trackMsg(activeSource() ? 'Tracking your cube: solve the pairs on it and the pieces follow.' : 'Tracking your cube. Pieces are filled in automatically; press "Did this" on the alg you used.');
    syncFromCube();
  }
  const boxes = () => (scrWca ? { scr: scrWca, pre: '' } : null);
  /** The cube that feeds this stage is at the scramble (and the EOCross moves under it): track it from here without a press. */
  function armed(): void {
    const b = boxes();
    if (!b || !b.scr) return;
    // the same scramble tracked already (loaded by the follow, or applied by hand): only the turns start over
    if (!tracked || tracked.scr !== b.scr || tracked.pre !== b.pre) { tracked = { ...b, hist: [] }; solvedSlots = new Set(); }
    else tracked.hist = [];
    fed = []; fedBy = 'cube'; pairAt = null; corner = null; edge = null; // the kind is set right by the first feed
    trackMsg('Your cube is at the scramble: following it.');
    syncFromCube();
  }
  // DECISION: this many wrong turns are shown with their undo, as the last-layer drills do; more than this and the
  // cube is read afresh - the finder's job is to name the case in front of you, not to insist on the alg it listed
  const OFF_LIMIT = 4;
  /**
   * The cube's turns since the scramble (the driver feeds the whole run each time): the tracked cube is those
   * turns, the pair on show is followed along its algs, a solved pair moves on to the next, and a cube off every
   * alg for long is read afresh. True once all four pairs are in.
   */
  function feed(text: string, source: 'cube' | 'camera'): boolean {
    if (!tracked) return false;
    let toks: string[];
    try { toks = tokens(text); } catch { return false; }
    fedBy = source; fed = toks;
    tracked.hist = toks.length ? [toWca(toks.join(' '))] : [];
    const f = cube();
    if (!f) return false;
    if (pairAt === null || !corner || !edge || slotSolved(f, slot)) { syncFromCube(); return solvedSlots.size === 4; }
    // mid-pair: on one of the listed algs (or a few turns off one) the case stays and the moves done light up - the
    // cross is broken halfway through most inserts, so it is not read again until the cube has strayed
    const p = pairProgress();
    if (p && (p.on || p.off.bad.length <= OFF_LIMIT)) { render(); return false; }
    syncFromCube();
    return solvedSlots.size === 4;
  }
  /**
   * Where the cube is along each alg listed for the pair, from the state the pieces were read at: the routes
   * (trainer letters, as the rows carry them), each with its progress; `on` is the one the cube is furthest
   * along (the alg being done), and `off` the wrong turns against the closest route when it is on none.
   */
  function pairProgress(): { routes: { el: HTMLElement; done: number; half: boolean; onRoute: boolean }[]; on: HTMLElement | null; off: { bad: string[]; undo: string[] } } | null {
    if (!tracked || pairAt === null) return null;
    const rows = [...$('result').querySelectorAll<HTMLElement>('.alg[data-alg]')];
    if (!rows.length) return null;
    const setup = [tracked.scr, tracked.pre].map(fromWca).concat(fed.slice(0, pairAt)).filter(Boolean).join(' ');
    const since = fed.slice(pairAt);
    let cur: string | null;
    try { cur = state(`${setup} ${since.join(' ')}`); } catch { cur = null; }
    const routes = rows.map((el) => ({ el, ...routeProgress(setup, tokens(el.dataset.alg!), cur) }));
    let on: HTMLElement | null = null, best = 0;
    for (const r of routes) { const n = r.done + (r.half ? 0.5 : 0); if (r.onRoute && n > best) { best = n; on = r.el; } }
    let off = { bad: [] as string[], undo: [] as string[] };
    if (!on && since.length && !routes.some((r) => r.onRoute)) {
      // the closest route: the one the fewest turns left
      let bestOff: { route: string[]; bad: string[]; at: number } | null = null;
      for (const r of routes) { const route = tokens(r.el.dataset.alg!); const o = offRoute(setup, route, since.join(' ')); if (!bestOff || o.bad.length < bestOff.bad.length) bestOff = { route, ...o }; }
      if (bestOff) off = wrongTurns(bestOff.route, bestOff.at, bestOff.bad);
    }
    return { routes, on, off };
  }
  /** Light the listed algs with the cube's progress (after the rows are built). */
  function markFollow(): void {
    const r = $('result');
    r.querySelector('.offalg')?.remove();
    const p = pairProgress();
    if (!p) return;
    for (const x of p.routes) {
      markRouteDone(x.el.querySelectorAll<HTMLElement>('.mv'), x.done, x.half);
      x.el.classList.toggle('on', x.el === p.on);
      x.el.classList.toggle('dim', p.on !== null && x.el !== p.on);
    }
    if (p.off.bad.length) {
      const el = document.createElement('p'); el.className = 'offalg';
      el.innerHTML = `Off the alg after ${p.off.bad.map(moveHtml).join(' ')} — undo with ${p.off.undo.map(moveHtml).join(' ')}`;
      r.querySelector('.case-title')?.insertAdjacentElement('afterend', el);
    }
  }
  /** The cube's belief moved: where it is on the scramble, shown under the boxes (the Solve tab's line). */
  function watch(facelets: string | null, colourOf: Record<FaceId, ColorName>): void {
    track = watcher.status(stageScramble(), facelets, colourOf, holdOf());
    renderFollow();
  }
  /** The scramble on show (WCA letters), the turns a cube has made of it marked, and the line under it while a cube is on. */
  function renderFollow(): void {
    const el = $('scrfollow');
    const toks = scrWca ? safe(() => tokens(scrWca)) : null;
    if (!toks) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    // once the cube's turns are the solve, the scramble stays done: the solve is not "off the scramble"
    const t: TrackStatus | null = !activeSource() ? null : fedBy && fed.length ? { applied: toks.length, total: toks.length, off: false, matched: true, half: false } : track;
    el.innerHTML = `${scrambleHtml(toks, t)}<small class="${t?.off ? 'off' : ''}">${trackText(t, toks)}</small>`;
  }
  /** The stage's scramble, trainer frame; null with none. */
  function stageScramble(): string | null {
    return scrWca ? safe(() => fromWca(scrWca)) : null;
  }
  function didThis(full: string): void {
    if (!tracked) return;
    tracked.hist.push(toWca(normalizeAlg(full)));
    syncFromCube();
  }
  /** Show `alg` (trainer frame) as the scramble, and track it. */
  function putScramble(alg: string, msg: string): void {
    scrWca = safe(() => clean(toWca(alg))) ?? ''; track = null; watcher.reset();
    trackMsg(msg); saveUrl(); renderFollow();
    if (scrWca) applyScramble();
  }
  /** A practice scramble (EO and the cross solved, the pairs and the top layer mixed), tracked, and given to the other tabs. */
  function newScramble(): void {
    const scr = genF2L();
    putScramble(scr, `Apply this to a solved cube held ${WCA_HOLD}, then hold it ${hold()}. Cross and EO stay solved; only the pairs and top layer are scrambled.${activeSource() ? ' On your cube it is followed as you go.' : ''}`);
    shareScramble(scr, 'f2l');
  }

  // ---- the result panel ----
  function algRow(a: string, auf: string, tag: string, c: F2LCase | null): HTMLElement {
    const { pre, rest } = withAuf(auf, a); const full = fullAlg(auf, a);
    const div = document.createElement('div'); div.className = 'alg'; div.dataset.alg = full;
    // every move its own numbered span (the AUF in brackets), so the cube's progress can be marked on it
    const mv = (t: string, i: number) => `<span class="mv" data-i="${i}">${t}</span>`;
    const preToks = pre ? tokens(pre) : [];
    const txt = document.createElement('span'); txt.className = 'txt';
    txt.innerHTML = (preToks.length ? `<span class="auf">(${preToks.map(mv).join(' ')})</span> ` : '') + tokens(rest).map((t, i) => mv(t, preToks.length + i)).join(' ');
    div.appendChild(txt);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `${moveCount(full)} moves`; div.appendChild(n);
    if (tag) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = tag; div.appendChild(s); }
    const ex = document.createElement('button'); ex.type = 'button'; ex.textContent = 'Explain'; div.appendChild(ex);
    const a2 = document.createElement('a'); a2.href = acnUrl(full); a2.target = '_blank'; a2.rel = 'noopener'; a2.textContent = 'Animate'; div.appendChild(a2);
    if (tracked && !fedBy) {
      const dd = document.createElement('button'); dd.type = 'button'; dd.textContent = 'Did this'; dd.style.fontWeight = '600'; dd.style.color = 'var(--ink)';
      dd.addEventListener('click', () => didThis(full)); div.appendChild(dd);
    }
    const outer = document.createElement('div'); outer.appendChild(div);
    let tr: HTMLElement | null = null;
    ex.addEventListener('click', () => {
      if (tr) { tr.remove(); tr = null; ex.textContent = 'Explain'; return; }
      tr = document.createElement('div');
      if (c) { const e = explain(slot, c, a); const w = document.createElement('div'); w.className = 'why'; w.innerHTML = `<b>${e.head}</b> ${e.body}`; tr.appendChild(w); }
      tr.appendChild(traceTable(full)); outer.appendChild(tr); ex.textContent = 'Hide';
    });
    return outer;
  }
  function traceTable(full: string): HTMLElement {
    const t = trace(slot, full);
    const tb = document.createElement('table'); tb.className = 'trace';
    tb.innerHTML = '<thead><tr><th>Move</th><th>Corner</th><th>Edge</th><th>Purpose</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const r of t.rows) { const tr = document.createElement('tr'); for (const cell of r) { const td = document.createElement('td'); td.textContent = cell; tr.appendChild(td); } body.appendChild(tr); }
    tb.appendChild(body);
    const wrap = document.createElement('div'); wrap.className = 'tracewrap';
    const cap = document.createElement('p'); cap.className = 'note'; cap.style.margin = '0 0 6px'; cap.textContent = t.caption;
    wrap.appendChild(cap); wrap.appendChild(tb);
    return wrap;
  }
  function nextButton(): HTMLElement {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'nextbtn';
    const remaining = SLOTS.filter((s) => !solvedSlots.has(s) && s !== slot).length;
    b.textContent = remaining ? 'Solved, next pair' : 'Solved, F2L done';
    b.addEventListener('click', () => {
      if (tracked && currentHit && !fedBy) { // tracking: the pair is solved by doing the alg shown
        const c = DATA.slots[slot].cases[currentHit.n];
        if (c) { didThis(fullAlg(currentHit.auf, advanced() ? c.algs[0] : c.simple)); return; }
      }
      markSolved();
    });
    return b;
  }
  function markSolved(): void {
    solvedSlots.add(slot); corner = null; edge = null;
    const next = SLOTS.find((s) => !solvedSlots.has(s));
    if (next) { slot = next; fillSlotSelect(); updateEdgeName(); }
    render();
  }
  function showResult(): void {
    const D = DATA.slots[slot];
    const r = $('result'); r.innerHTML = '';
    const hint = (t: string) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t; r.appendChild(p); };
    const hb = $('hintbox'); hb.hidden = true; hb.innerHTML = '';
    const left = corner && edge ? null : beforeF2L(); // a pair under way keeps its case through a broken cross
    if (left) { hint(left); return; }
    if (solvedSlots.size === 4) {
      hint(tracked ? `All four pairs solved on the tracked cube in ${movesDone()} moves. Generate a new scramble or press "Start over".` : 'All four pairs solved. Press "Start over" for the next solve.');
      if (tracked && stages.ocll) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.style.marginTop = '8px'; b.textContent = 'Continue to OCLL with this cube';
        b.addEventListener('click', () => { shareScramble(trackedAlg(), 'f2l'); showTab('ocll'); window.scrollTo({ top: 0 }); });
        r.appendChild(b);
      }
      return;
    }
    if (!corner || !edge) {
      hint(!corner && !edge ? 'Nothing placed yet. Start with the corner: tap any facelet where its white sticker sits — on the top face, on the sides, or down in a slot.'
        : !corner ? 'Now place the corner: tap the facelet holding its white sticker.' : 'Now tap where the edge is (top layer or one of the four slots).');
      return;
    }
    if (corner.pos === `D${slot}` && corner.o === 'ud' && edge === slot) { hint('That pair is already solved.'); r.appendChild(nextButton()); return; }
    const found = findCase(slot, corner, edge);
    currentHit = found?.hit ?? null;
    if (!found) { hint('No case in the sheet matches this position.'); return; }
    const { hit, c } = found;
    const t = document.createElement('div'); t.className = 'case-title';
    t.innerHTML = `<h2>${slot} case ${c.n}</h2><span>${c.section}</span>${tracked ? `<span class="trackbadge">tracking · ${movesDone()} moves so far</span>` : ''}`; r.appendChild(t);
    const w = document.createElement('p'); w.className = 'where'; w.textContent = describe(corner, edge); r.appendChild(w);
    const adv = advanced();
    const ex = explain(slot, c, adv ? c.algs[0] : c.simple);
    hb.innerHTML = `<b>${ex.head.replace(/\.$/, '')}</b>`;
    hb.hidden = !showHints();
    const wrap = document.createElement('div');
    const SIMPLE = /^[RLU][2']*$/; const isSimple = (a: string) => normalizeAlg(a).split(' ').every((tok) => SIMPLE.test(tok));
    if (adv) {
      for (const a of c.algs) wrap.appendChild(algRow(a, hit.auf, '', c));
      if (c.simple_src === 'search') wrap.appendChild(algRow(c.simple, hit.auf, 'R/L/U only, not in the sheet', c));
    } else wrap.appendChild(algRow(c.simple, hit.auf, c.simple_src === 'search' ? 'not in the sheet' : '', c));
    const usable = c.others.filter((o) => o.free.every((s) => !solvedSlots.has(s)) && (adv || isSimple(o.alg)));
    if (usable.length) {
      const h3 = document.createElement('h3'); h3.textContent = 'Shortcuts using slots that are still open'; wrap.appendChild(h3);
      for (const o of usable) wrap.appendChild(algRow(o.alg, hit.auf, `uses ${o.free.map((s) => SLOT_WORD[s]).join(' + ')}`, c));
    }
    wrap.appendChild(nextButton());
    r.appendChild(wrap);
    if (c.note) { const nn = document.createElement('p'); nn.className = 'note'; nn.textContent = /keyhole/i.test(c.note) ? 'Keyhole case (the sheet lists no other-slot alg).' : c.note; r.appendChild(nn); }
    if (fedBy) markFollow();
    const s = document.createElement('p'); s.className = 'sheet';
    s.innerHTML = `Row ${c.n} on the ${slot} tab of the <a href="https://docs.google.com/spreadsheets/d/13O15zHAd0rKU9V9VQHw1vLEQh7v5fpWzeajokjz8LgA/edit?gid=${D.gid}" target="_blank" rel="noopener">ZZF2L Cases sheet</a>. The AUF in parentheses is adjusted for the exact position you tapped.`;
    r.appendChild(s);
  }

  function render(): void {
    renderTracker();
    drawPictures();
    showResult();
    saveUrl();
  }

  // ---- wiring ----
  $('genF2L').onclick = newScramble;
  $('scrtricks').onclick = () => {
    const ok = scrWca ? openFingertricks(scrWca, { title: 'The scramble', hold: WCA_HOLD }) : null;
    if (ok === null) trackMsg('Make a scramble first.', true);
    else if (!ok) trackMsg('Could not read the moves.', true);
  };
  $<HTMLSelectElement>('slotsel').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (!isSlot(v)) return;
    slot = v; corner = null; edge = null; updateEdgeName();
    if (tracked) syncFromCube(); else render();
  });
  $('random').onclick = () => { const r = randomCase(slot); corner = r.corner; edge = r.edge; render(); };
  $('reset').onclick = () => { corner = null; edge = null; render(); };
  $('restart').onclick = () => { tracked = null; fed = []; fedBy = null; pairAt = null; solvedSlots = new Set(); corner = null; edge = null; slot = SLOTS[0]; fillSlotSelect(); updateEdgeName(); render(); };
  // the cube went away: its turns stay on the tracked cube, "Did this" comes back
  onSourceChange(() => { if (!activeSource()) { fedBy = null; track = null; renderFollow(); if (tracked) render(); } });
  // the settings-sheet checkboxes are outside root (and may be mounted after us): listen on the document
  document.addEventListener('change', (e) => { const id = (e.target as HTMLElement | null)?.id; if (id === 'showhints' || id === 'advanced') render(); });
  onSchemeChange(() => { fillSlotSelect(); updateEdgeName(); if (tracked) syncFromCube(); else render(); }); // the tracked cube reads differently in the new frame

  fillSlotSelect(); updateEdgeName();
  loadUrl();
  renderFollow();
  if (tracked) syncFromCube(); else render();

  return {
    load(scramble: string): void {
      scrWca = safe(() => clean(toWca(scramble))) ?? ''; track = null; watcher.reset();
      saveUrl(); renderFollow();
      applyScramble();
    },
    render,
    scramble: stageScramble,
    newScramble,
    feed: (text, _t, source) => feed(text, source ?? 'cube'),
    armed,
    watch,
  };
}

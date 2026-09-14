// scan.html - the one camera page.
//
//   Auto mode  (default) the M6/M7 pipeline per CLAUDE.md: camera -> frame
//              ring (every frame frozen on arrival) -> two-stage detector
//              (stage-1 localizer on the frame, stage-2 corners on its
//              padded box; a stage-1 miss is a tick with no detections) ->
//              corner tracker -> homography rectify at native resolution ->
//              robust 9-cell sampling -> EVIDENCE LOG (readings with quality
//              weights, letter-free shared-edge pairings) -> the colour
//              solver (src/colour/solve.ts, docs/colour-pipeline-design.md)
//              on a timer -> lock on its certificates. Nothing on this page
//              decides a colour; the page pumps frames, appends to the log,
//              and renders the Solution. The view runs one inference
//              latency behind the camera so every overlay is drawn on the
//              exact frame its corners came from (framering.ts); the debug
//              panel can switch it back to live for comparison.
//   Grid mode  the M1 grid scanner (ui/scanner.ts), the same component the
//              trainer's Scan tab mounts. It is the fallback (M8): a banner
//              offers it when detection stays weak, and it is the only path
//              when either model is missing.
//   Debug      one collapsible panel replaces the former detect.html and
//              bbox.html pages: EP switch, detection cadence, stage-1 box /
//              ROI and heatmap overlays, a localizer-only switch (stage 2 off,
//              to tell a stage-1 failure from a stage-2 one), the per-sticker
//              readout, and the raw-frame / naming-evidence exports for the
//              labeling loop. Everything it shows is the pipeline's own state;
//              nothing is recomputed differently for the panel.
import './ui/scan.css';
import { Camera } from './camera';
import { FrameRing, type RingFrame } from './framering';
import { FpsCounter } from './debug/fps';
import { labToSrgb, minFaceEdgePx, type CellPlan } from './color';
import { SolverClient } from './colour/client';
import { emptyLog, trimLog } from './colour/evidence';
import { SamplerClient } from './colour/sampler';
import type { SampleTrack } from './colour/sample.worker';
import { DEFAULT_PARAMS } from './colour/solve';
import type { EvidenceLog, Solution } from './colour/types';
import type { Ep } from './detect/facekp';
import { drawHeatmap, drawQuad, drawStage1, exemplarSwatches } from './debug/detect-overlay';
import { captureDebug, downloadBlob, renderCellReadout, saveRawFrame, summarizeTick, type TickSummary } from './debug/dump';
import { installDetectSelfTest } from './debug/selftest';
import { describeModels, loadTwoStage, type TwoStageModels } from './detect/models';
import { detectTwoStage, type TwoStageResult } from './detect/twostage';
import { QuadTracker, type QuadDetection, type TrackedQuad } from './detect/tracker';
import { OBSCURED_REASON, TOO_SMALL_REASON } from './detect/identify';
import { HintState, hintFor } from './ui/hint';
import { matchSharedEdge } from './detect/orient';
import { mapUV, squareToQuad } from './rectify';
import { randomScramble, scrambleState } from './scramble';
import { solveState } from './state';
import { mountScanner, type ScannerHandle } from './ui/scanner';
import { DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from './types';
import type { FaceId } from './types';

// Cross-origin isolation via service worker (public/coi-serviceworker.js) so
// ort-web gets SharedArrayBuffer and wasm threads on GitHub Pages. First
// visit: register, then reload once so the page loads under the worker's
// headers; a sessionStorage flag stops any reload loop.
(() => {
  if (self.crossOriginIsolated || !('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  const flag = 'coi-reloaded';
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-serviceworker.js`).then((reg) => {
    if (navigator.serviceWorker.controller || sessionStorage.getItem(flag)) return;
    sessionStorage.setItem(flag, '1');
    const sw = reg.installing ?? reg.waiting;
    if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'activated') location.reload(); });
    else if (reg.active) location.reload();
  }).catch(() => undefined);
})();

const SAMPLE_CONF = 0.55;    // min tracked conf to contribute readings
const REFINE = true;         // grid-prior corner refinement before sampling
const FALLBACK_AFTER_MS = 6000;
// The sampler runs only on frames that carry a fresh detection: between
// ticks the tracker coasts the same quads over near-identical pixels. The
// solver runs on its own timer over the whole log (it is a pure function of
// it) and the UI readouts refresh on another.
const UI_EVERY_MS = 250;
// The solver runs as often as it can without running back to back: at
// least SOLVE_MIN_MS apart, and no more often than every 1.5x its own
// recent duration (a desktop solves in 200 ms and re-solves 3x/s, a phone
// at 1.5 s settles at one every 2 s).
const SOLVE_MIN_MS = 300;
// DECISION: a frame is sampled only SAMPLE_MIN_MS after the last sampled
// one. A desktop detects every camera frame (30/s) and consecutive frames
// are the same look at the same stickers: sampling them all filled the
// 1500-quad log window in 20 s (the design assumed ~2 ticks/s and minutes)
// and took the solve to 1 s, while nEff saturated on frame-to-frame copies
// rather than independent looks. 12 samples/s is the phone's own pace.
const SAMPLE_MIN_MS = 80;
// The evidence is too dark to read when the running median of the
// brightest channel of what is being sampled sits below this (sRGB): the
// SNR weight (evidence.ts BRIGHT_FULL) has such readings at a tenth of
// their weight, and the palette fit cannot separate colours in them
// (scan-debug-1789348371807 read whole faces at RGB (40, 27, 14)).
const DARK_PEAK = 55;
// Exposure steps are at least this far apart: a manual step is immediate
// but the sampled-brightness EMA needs ~1 s to say what it did, and a
// camera handed back to auto takes ~3 s to settle (LifeCam, measured).
const EXPOSURE_HOLD_MS = 1500;
const TICK_HISTORY = 120;    // detection ticks kept for Capture debug (~1 min at 2 fps of ticks)
// Frames kept frozen behind the live camera. The view lags the camera by
// the detector's latency (measured, in frames) so a detection is applied
// on the frame it was computed for; the ring must hold at least that many.
// 16 frames is ~0.5 s at 30 fps - beyond that a detection is applied late
// (carried forward along the track's velocity) rather than waited for.
const RING_FRAMES = 16;
// The display delay follows a decaying maximum of the observed latency:
// a spike raises it at once, and it eases off by a frame every ~3 s.
const LAG_DECAY_PER_FRAME = 1 / 90;
// DECISION 2026-09-13: with the measurements time-exact the filter no longer
// has a latency to hide, so the position gain goes up (0.55 -> 0.7): what
// remains is the detector's few px of per-frame noise, and the grid-prior
// refinement in the sampler snaps the read cells regardless.
const SYNC_POS_ALPHA = 0.7;
const LIVE_POS_ALPHA = 0.55;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="wrap">
    <h1>Scan the cube
      <span id="modes"><button id="modeAuto" class="on">Auto</button><button id="modeGrid">Grid</button></span>
      <small id="status" class="auto">model loading…</small>
      <small id="build" title="git hash · build time">build ${__BUILD__.hash} · ${__BUILD__.time}</small>
    </h1>
    <div id="cols">
      <div id="main" class="auto">
        <div id="scramble" title="Apply this to a solved cube before scanning and tick the box: the capture then carries the true state and becomes a regression fixture on its own"><b>Scramble</b> <span id="scrambleAlg"></span> <label><input type="checkbox" id="applied"> I applied it (from solved)</label></div>
        <div id="solverec" title="Record the camera feed while you turn the cube: the .webm and the debug capture download together, aligned on the same clock, and become a move-tracking fixture. Type the moves you will make (or leave blank for a free solve)"><b>Moves</b> <input id="moves" placeholder="R U R' U' - what you will turn while recording" spellcheck="false" autocapitalize="characters"> <button id="rec" disabled>Record</button> <span id="recState"></span></div>
        <div id="bar">
          <button id="start">Start camera</button>
          <button id="reset">Reset scan</button>
          <button id="pause" disabled title="Freeze the frame and the overlay to inspect what was sampled">Pause</button>
          <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
        </div>
        <div id="stage"><canvas id="view" width="640" height="480"></canvas><div id="hint" hidden></div><div id="lockbadge" hidden>Locked ✓ — camera paused. <b>Resume</b> keeps watching, <b>Reset scan</b> starts over.</div></div>
        <div id="fallback">Having trouble? The <a href="#" id="toGrid">grid scanner</a> always works.</div>
      </div>
      <aside id="side" class="auto">
        <div class="ph">Face evidence</div>
        <div id="fill">${FACE_ORDER.map((f) => `<div class="f" id="fill-${f}" style="--fc:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span class="nm">${DEFAULT_SCHEME_NAMES[f]}</span><span class="pct">0%</span><div class="bar"><i></i></div></div>`).join('')}</div>
        <div id="unbound"></div>
        <p class="note">One bar per face of the cube, named by its centre (U up, R right, F front, D down, L left, B back; the colours are the standard scheme until the solver has measured the cube's own). The bar is the weakest sticker of that face: how much of the lock floor (${DEFAULT_PARAMS.nMin} weighted readings) it has collected. Turn the cube until every bar is full.</p>
        <div id="result"></div>
        <div class="ph" id="attemptHd" hidden>Decoded faces</div>
        <div id="attempt" class="grids"></div>
        <p class="note" id="legend" hidden>Each cell is painted with the colour actually measured for that sticker; the badge is the letter the decoder assigned it (<code>?</code> = too close to call, <code>·</code> = no evidence yet; the ringed cell is the centre). Header: which tracked quads fed the face and its rotation. Footer: why the solver will not lock yet — <i>changed</i> is how many stickers the cube's constraints moved off their raw best colour, <i>delta</i> how much worse the runner-up state scores, <i>min margin</i> the tightest sticker call.</p>
      </aside>
    </div>
    <div id="stats" class="auto"></div>
    <details id="debug" class="auto">
      <summary>Debug</summary>
      <div class="row">
        <select id="ep">
          <option value="auto">EP: auto</option>
          <option value="webgpu">EP: webgpu</option>
          <option value="wasm">EP: wasm</option>
        </select>
        <select id="every">
          <option value="auto">detect: as fast as the machine allows</option>
          <option value="1">detect every frame</option>
          <option value="2">detect every 2nd frame</option>
          <option value="3">detect every 3rd frame</option>
        </select>
        <select id="sync" title="Synced: the view is delayed by the detector's latency and each overlay is drawn on the frame it was computed for. Live: the view is the newest frame and detections are carried forward to it.">
          <option value="sync">view: synced to detection</option>
          <option value="live">view: live (overlay carried forward)</option>
        </select>
        <label><input type="checkbox" id="stage1"> stage-1 box + ROI</label>
        <label><input type="checkbox" id="labelsChk"> labels</label>
        <label><input type="checkbox" id="refusedChk"> refused quads</label>
        <label id="heatLbl" hidden><input type="checkbox" id="heat"> heatmap</label>
        <label><input type="checkbox" id="stage2off"> stage 2 off (localizer only)</label>
        <label id="cellsLbl" hidden><input type="checkbox" id="cellsChk"> per-sticker readout</label>
        <label><input type="checkbox" id="exChk"> solver</label>
        <label><input type="checkbox" id="samplesChk"> sample patches</label>
        <button id="capture" disabled title="Download the evidence log (every reading and pairing of this session), the solution, and the last ${TICK_HISTORY} ticks as JSON, plus the raw frame">Capture debug</button>
      </div>
      <div id="msg"></div>
      <div id="swatches" hidden></div>
      <div id="exemplars" hidden></div>
      <div id="cells" class="grids"></div>
    </details>
    <div id="grid"></div>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// A fresh scramble per session (and per Reset): scanned from a solved cube
// it gives every capture a known truth.
let scramble = '';
const appliedChk = $<HTMLInputElement>('applied');
function newScramble(): void {
  scramble = randomScramble();
  $('scrambleAlg').textContent = scramble;
  appliedChk.checked = false;
}
newScramble();
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const statusEl = $('status');
const resultEl = $('result');
const fallbackEl = $('fallback');
const statsEl = $('stats');
const hintEl = $('hint');
const msgEl = $('msg');
const swatchEl = $('swatches');
const cellsEl = $('cells');
const startBtn = $<HTMLButtonElement>('start');
const saveBtn = $<HTMLButtonElement>('save');
const captureBtn = $<HTMLButtonElement>('capture');
const epSel = $<HTMLSelectElement>('ep');
const everySel = $<HTMLSelectElement>('every');
const syncSel = $<HTMLSelectElement>('sync');
const stageChk = $<HTMLInputElement>('stage1');
const heatChk = $<HTMLInputElement>('heat');
const stage2Off = $<HTMLInputElement>('stage2off');
const cellsChk = $<HTMLInputElement>('cellsChk');
const exChk = $<HTMLInputElement>('exChk');
const samplesChk = $<HTMLInputElement>('samplesChk');
const labelsChk = $<HTMLInputElement>('labelsChk');
const refusedChk = $<HTMLInputElement>('refusedChk');
const pauseBtn = $<HTMLButtonElement>('pause');
const attemptEl = $('attempt');
const exEl = $('exemplars');

const camera = new Camera();
const fps = new FpsCounter();
const tracker = new QuadTracker({ posAlpha: SYNC_POS_ALPHA });
const ring = new FrameRing(RING_FRAMES);
syncSel.addEventListener('change', () => tracker.configure({ posAlpha: syncSel.value === 'sync' ? SYNC_POS_ALPHA : LIVE_POS_ALPHA }));

// The evidence log is the whole colour state of the page. Everything the
// solver knows is in it, so Capture debug dumps it and the replay test can
// reproduce a phone session exactly.
let log: EvidenceLog = emptyLog();
let detFrame = 0;                                  // detection-frame index (log.frames)
const lastCorners = new Map<number, { corners: [number, number][]; t: number }>();
const lastOffset = new Map<number, [number, number][]>();   // track -> last refinement offset (warm start)
const nthOf = new Map<number, number>();           // track -> detections so far
let knownTracks = new Set<number>();
let solution: Solution | null = null;
let locked: Solution | null = null;
let logVersion = 0;
let solvedVersion = -1;
let solveEma = 0;
const solver = new SolverClient();
const sampler = new SamplerClient();
// pairings of a frame wait for the sampler's quads so the log stays in frame order
const pendingPairings = new Map<number, { a: number; b: number; edgeA: number; edgeB: number; cost: number; tol: number }[]>();
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

/** A finished detection tick, waiting for the view to reach its frame. */
interface Arrival {
  frame: number;          // ring index of the frame the detector looked at
  ts: number;             // that frame's capture timestamp
  dets: QuadDetection[];  // anonymous quads for the tracker
  tick: TwoStageResult;
}

let models: TwoStageModels | null = null;
let running = false;
let loopGen = 0;           // bumps per start so a stale frame callback can't run a second loop
let frameNo = 0;
let inferBusy = false;
// Ticks land here in frame order (inference never overlaps) and are taken
// out when the view reaches their frame - or at once, carried forward, when
// the view is already past it (live mode, or a latency spike).
const arrivals: Arrival[] = [];
// The most recent APPLIED detection tick, for the debug overlay and the banner.
let lastTick: TwoStageResult | null = null;
let shown: RingFrame | null = null;   // the frame under the overlay right now
let lagMax = 0;            // decaying max of tick latency, in frames (sets the view delay)
let lagEma = 0;            // tick latency EMA, frames, for the stats line
let lateTicks = 0;         // ticks applied after the view had passed their frame
let vfcSeen = false;       // requestVideoFrameCallback has fired: trust it as the new-frame signal
let vfcFresh = false;      // a video frame arrived since the last loop pass
let lastGoodDetectionTs = 0;
const hintState = new HintState();
let cubeTooSmall = false;  // localizer found a cube whose silhouette is under the face floor
let noCube = false;        // localizer found nothing on the last tick
let solved = false;
let pipeEma = 0;           // ms spent in the colour pipeline per detection frame (EMA)
let lastUiTs = 0;
let paused = false;
/** The quads actually sampled this frame (source px, refined) and their sampling plan, for the overlay. */
let sampledQuads: { track: number; quad: [number, number][]; plan: CellPlan }[] = [];
let lastSolveTs = 0;
let lastSampleTs = -Infinity;
let peakEma = 255;         // running median-ish of the brightest channel of sampled readings
let clipEma = 0;           // running mean of the sampled readings' clipped fraction
let exposureAt = 0;        // when the camera's exposure compensation was last nudged
let exposureComp: string | null = null;   // what was applied ('ev +1', '62.5 ms', 'auto'; null: never / not supported)
let exposurePeakBefore: number | null = null;   // the cube's brightness when the last brightening step was taken
let exposureGaveUp = false;   // a brightening step made the cube no brighter: this camera's control is not the one to use
let stage1Misses = 0;
let ticks = 0;
let locateEma = 0;
let inferEma = 0;
const tickHistory: TickSummary[] = [];

// ---- models -------------------------------------------------------------

async function load(ep: Ep | 'auto') {
  const previous = models;
  models = null;
  statusEl.textContent = 'model loading…';
  const outcome = await loadTwoStage(ep, previous);
  models = outcome.models;
  if (!models) {
    statusEl.textContent = outcome.reason;
    fallbackEl.style.display = 'block';
    return outcome;
  }
  statusEl.textContent = `model ready: ${describeModels(models)}`;
  const anon = models.detector.anonymous;
  $('heatLbl').hidden = !anon;
  $('cellsLbl').hidden = !anon;
  swatchEl.hidden = !anon;
  return outcome;
}

void load('auto');
epSel.addEventListener('change', () => void load(epSel.value as Ep | 'auto'));
installDetectSelfTest({ current: () => models, load });

// ---- the auto pipeline --------------------------------------------------

/** Pixels of a frozen frame (one readback, for the sampler). */
function frameImageData(src: HTMLCanvasElement): ImageData {
  if (work.width !== src.width || work.height !== src.height) {
    work.width = src.width;
    work.height = src.height;
  }
  workCtx.drawImage(src, 0, 0);
  return workCtx.getImageData(0, 0, work.width, work.height);
}

/** One detection tick on a frozen frame: stage 1, then stage 2 on its
 *  padded box unless the debug panel has switched stage 2 off. Both stages
 *  see the same pixels (the live video moved on between them before). */
async function tick(src: HTMLCanvasElement, m: TwoStageModels): Promise<TwoStageResult> {
  if (!stage2Off.checked) return detectTwoStage(m.localizer, m.detector, src);
  const t0 = performance.now();
  const box = await m.localizer.locate(src, src.width, src.height);
  return { result: null, box, roi: null, obj: m.localizer.lastObj, locateMs: performance.now() - t0 };
}

/** The frame Save frame / Capture debug should export: the one under the overlay. */
function exportFrame(): HTMLCanvasElement | HTMLVideoElement {
  return shown?.canvas ?? camera.video;
}

// The loop runs once per CAMERA frame, not per display refresh: a 30 fps
// camera under a 60 Hz rAF would otherwise push every frame into the ring
// twice. requestVideoFrameCallback is the new-frame signal where it exists;
// until it has fired once (it may never, for a video that is not in the
// document on some browsers) every rAF counts as a frame, as before.
function armFrameSignal(v: HTMLVideoElement, gen: number): void {
  const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  if (typeof rvfc !== 'function') return;
  rvfc.call(v, () => {
    if (gen !== loopGen) return;
    vfcSeen = true;
    vfcFresh = true;
    armFrameSignal(v, gen);
  });
}

/** A track's face letter from the current solution (null while ungrouped or unlettered). */
function faceOfTrack(id: number): FaceId | null {
  const sol = locked ?? solution;
  if (!sol) return null;
  for (const g of sol.groups) if (g.letter && g.tracks.includes(id)) return g.letter;
  return null;
}

/** CSS colour to draw a letter with: the palette's measured colour once known, the default scheme before. */
function cssOfLetter(f: FaceId): string {
  const sol = locked ?? solution;
  if (sol) {
    const c = sol.colourLetter.indexOf(f);
    const lab = c >= 0 ? sol.palette.lab[c] : null;
    if (lab) { const [r, g, b] = labToSrgb(lab); return `rgb(${r},${g},${b})`; }
  }
  return DEFAULT_SCHEME_HEX[f];
}

/** Outline every patch the colour sampler reads on the quads that voted this frame. */
function drawSamplePatches(): void {
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const { track, quad, plan } of sampledQuads) {
    const m = squareToQuad(quad);
    const face = faceOfTrack(track);
    ctx.strokeStyle = face ? cssOfLetter(face) : '#cfd3dc';
    const box = (u: number, v: number, half: number) => {
      const pts = [[u - half, v - half], [u + half, v - half], [u + half, v + half], [u - half, v + half]]
        .map(([a, b]) => mapUV(m, a!, b!));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    };
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const u = (c + 0.5) / 3;
        const v = (r + 0.5) / 3;
        if (r === 1 && c === 1) {
          box(u, v, plan.centreHalf / 3);
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(u + (sx! * plan.centreOff) / 3, v + (sy! * plan.centreOff) / 3, plan.centreHalf / 3);
        } else {
          box(u, v, plan.half / 3);
        }
      }
    }
  }
  ctx.restore();
}

/**
 * The solution as six 3x3 grids: each cell painted with the aggregated
 * reading of that sticker, badged with the letter the decoder gave it (a
 * red '?' where the margin is under the lock floor, a dot where there is
 * no evidence yet). The header carries the evidence and the group behind
 * the face; the footer says why the solver will not lock yet.
 */
function renderSolution(): void {
  const sol = locked ?? solution;
  attemptEl.replaceChildren();
  if (!sol) return;
  FACE_ORDER.forEach((face, fi) => {
    const box = document.createElement('div');
    box.className = 'face';
    const hd = document.createElement('div');
    hd.className = 'hd';
    const g = sol.groups.find((x) => x.letter === face);
    const n = sol.nEff.slice(fi * 9, fi * 9 + 9);
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = cssOfLetter(face);
    const title = document.createElement('b');
    title.textContent = `${face} ${DEFAULT_SCHEME_NAMES[face]}`;
    hd.append(dot, title, document.createTextNode(
      `${g ? ` · tracks ${g.tracks.map((t) => `#${t}`).join(' ')}` : ' · not seen'}\n`
      + `evidence ${Math.min(...n).toFixed(1)}–${Math.max(...n).toFixed(1)}${g ? ` · rot ${g.absRotation ?? '?'}${g.rotationVotes.some(Boolean) ? ` (${g.rotationVotes.join('/')})` : ''}` : ''}`));
    const grid = document.createElement('div');
    grid.className = 'g';
    for (let k = 0; k < 9; k++) {
      const i = fi * 9 + k;
      const c = document.createElement('div');
      c.className = 'c' + (k === 4 ? ' mid' : '');
      const lab = sol.slotLab[i];
      if (lab) { const rgb = labToSrgb(lab); c.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; }
      else c.style.background = '#2a2f3a';
      const letter = sol.slotLetter[i];
      const tag = document.createElement('span');
      const margin = sol.decode?.margins[i] ?? 0;
      const low = !letter || margin < DEFAULT_PARAMS.marginMin || sol.nEff[i]! < DEFAULT_PARAMS.nMin;
      tag.className = 'tag' + (low ? ' low' : '');
      tag.style.background = letter ? cssOfLetter(letter) : '#fff';
      tag.textContent = !letter ? '.' : low ? '?' : letter;
      tag.title = letter ? `decided ${DEFAULT_SCHEME_NAMES[letter]}, margin ${margin.toFixed(1)}, evidence ${sol.nEff[i]!.toFixed(1)}` : 'no evidence';
      c.append(tag);
      grid.append(c);
    }
    box.append(hd, grid);
    attemptEl.append(box);
  });
  const note = document.createElement('div');
  note.className = 'hd';
  const d = sol.decode;
  note.textContent = (locked ? 'LOCKED - ' : '') + sol.reason
    + (d ? ` - changed ${d.changed}, delta ${d.delta === Infinity ? 'inf' : d.delta.toFixed(1)}, min margin ${Math.min(...d.margins).toFixed(1)}, pops ${d.pops}` : '');
  attemptEl.append(note);
  $('attemptHd').hidden = false;
  $('legend').hidden = false;
}

/** The sampler's result for one detection frame: append to the log, mirror to the solver. */
sampler.onSampled = (r) => {
  if (locked && !solveMode()) return;
  const present = new Set(r.quads.map((q) => q.track));
  const pairs = (pendingPairings.get(r.frame) ?? []).filter((p) => present.has(p.a) && present.has(p.b));
  pendingPairings.delete(r.frame);
  if (!r.quads.length) return;
  log.quads.push(...r.quads);
  for (const p of pairs) log.pairings.push({ frame: r.frame, ...p });
  sampledQuads = r.refined;
  // brightness of what was read this frame, for the dark hint and the exposure loop
  const peaks = r.quads.flatMap((q) => q.readings.map((x) => Math.max(x.rgb[0], x.rgb[1], x.rgb[2]))).sort((a, b) => a - b);
  if (peaks.length) {
    const clip = r.quads.flatMap((q) => q.readings.map((x) => x.clipFrac)).reduce((a, b) => a + b, 0) / peaks.length;
    peakEma = peakEma === 255 && peaks.length ? peaks[peaks.length >> 1]! : 0.8 * peakEma + 0.2 * peaks[peaks.length >> 1]!;
    clipEma = 0.8 * clipEma + 0.2 * clip;
  }
  for (const q of r.refined) lastOffset.set(q.track, q.offset);
  // mirror to the worker before trimming so both logs trim identically
  solver.sync(log);
  // solve mode keeps the whole log (every epoch of a solve is evidence)
  const dropped = solveMode() ? { quads: 0, pairings: 0, events: 0 } : trimLog(log);
  solver.trimmed(dropped.quads, dropped.pairings, dropped.events);
  logVersion++;
};

function drawOverlay(tracks: TrackedQuad[]): void {
  // Debug layering, back to front: stage 1's box and ROI, heatmap, then the
  // raw anonymous quads in grey (what the model actually said), then the
  // tracked quads in the colour their cluster resolved to (what the app
  // decided). Seeing them all at once is how a naming bug is told apart from
  // a detection bug, and a stage-1 miss from a stage-2 one. Dashed amber =
  // seen but deliberately skipped for size; solid grey = a quality refusal.
  if (lastTick?.result?.heat && heatChk.checked) drawHeatmap(ctx, lastTick.result.heat);
  if (lastTick && stageChk.checked) drawStage1(ctx, lastTick.box?.box ?? null, lastTick.roi, lastTick.obj);
  if (lastTick?.result && refusedChk.checked) {
    for (const u of lastTick.result.unnamed) {
      if (!isQualityRefusal(u.reason)) continue;
      const tooSmall = u.reason.startsWith(TOO_SMALL_REASON);
      drawQuad(ctx, u.quad.corners, tooSmall ? '#d98a1f' : '#8b93a3', `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5, tooSmall);
    }
  }
  for (const t of tracks) {
    const strong = t.conf >= SAMPLE_CONF;
    const face = faceOfTrack(t.id);
    ctx.globalAlpha = strong ? 1 : 0.5;
    const label = labelsChk.checked ? `#${t.id} ${face ? DEFAULT_SCHEME_NAMES[face] : '?'} ${t.conf.toFixed(2)}` : '';
    drawQuad(ctx, t.corners, face ? cssOfLetter(face) : '#cfd3dc', label, strong ? 4 : 1.5);
    ctx.globalAlpha = 1;
  }
}

/** A refusal about the sample itself (not about naming): the quad is tracked but must not vote this tick. */
function isQualityRefusal(reason: string): boolean {
  return reason.startsWith(TOO_SMALL_REASON) || reason === 'too dark' || reason.startsWith('glare') || reason.startsWith(OBSCURED_REASON);
}

/** Live solver table: the palette, the face groups, and the certificates. */
function renderSolver(): void {
  const sol = locked ?? solution;
  if (!sol) { exEl.textContent = 'no solution yet'; return; }
  const pal = sol.palette.lab.map((l, c) => `colour ${c} ${(sol.colourLetter[c] ? DEFAULT_SCHEME_NAMES[sol.colourLetter[c]!] : '?').padEnd(7)} `
    + (l ? `L ${l.L.toFixed(0).padStart(3)} a ${l.a.toFixed(0).padStart(4)} b ${l.b.toFixed(0).padStart(4)}` : 'empty') + `  sigma ${sol.palette.sigma[c]!.toFixed(1)}`);
  const groups = sol.groups.map((g) => `group ${g.id} ${(g.letter ?? '-').padEnd(2)} evidence ${g.nEff.toFixed(0).padStart(4)}  rot ${g.absRotation ?? '?'}  tracks ${g.tracks.map((t) => `#${t}${g.rotation.get(t) ? `+${g.rotation.get(t)}` : ''}`).join(' ')}`);
  const naming = sol.naming ? `names ${sol.naming.names.map((n, c) => `${c}:${n ?? '-'}`).join(' ')}${sol.naming.hinted ? ' (from decoded centres)' : ''}\n`
    + `letter maps ${sol.naming.top.map((t) => `${t.letters} pen ${t.penalty} mis ${t.mismatches}`).join(' | ')}` : '';
  exEl.textContent = [...pal, '', ...groups, '', naming, '', `${sol.reason} - ${sol.embedding} - solve ${sol.ms.toFixed(0)} ms - frames ${log.frames} quads ${log.quads.length} pairings ${log.pairings.length}`].join('\n');
}

let renderedSolution: Solution | null = null;

function updateFillUI(): void {
  const sol = locked ?? solution;
  for (const f of FACE_ORDER) {
    const fi = FACE_ORDER.indexOf(f);
    const n = sol ? Math.min(...sol.nEff.slice(fi * 9, fi * 9 + 9)) : 0;
    const frac = Math.min(1, n / DEFAULT_PARAMS.nMin);
    const chip = $(`fill-${f}`);
    chip.style.setProperty('--fc', cssOfLetter(f));
    chip.classList.toggle('done', frac >= 1);
    (chip.querySelector('.bar i') as HTMLElement).style.width = `${frac * 100}%`;
    chip.querySelector('.pct')!.textContent = `${Math.round(frac * 100)}%`;
  }
  $('unbound').textContent = sol && !locked ? `${sol.centresSeen}/6 faces - ${sol.reason}` : '';
  if (locked && !solved) {
    solved = true;
    const st = locked.facelets!;
    // the solution's moves are named by centre: U is the face whose centre
    // is the U colour, F the F colour - say so, or the moves are meaningless
    const hold = `Hold the cube with the ${DEFAULT_SCHEME_NAMES[st[4] as FaceId]} centre on top and the ${DEFAULT_SCHEME_NAMES[st[22] as FaceId]} centre facing you.`;
    const cert = `${locked.decode!.changed} sticker(s) moved by the cube's constraints; runner-up state ${locked.decode!.delta === Infinity ? 'none' : `${locked.decode!.delta.toFixed(1)} worse`}`;
    // facelets and moves are letters from the solver, never user text
    resultEl.innerHTML = `<div class="rt">Locked ✓</div><div class="st">${st}</div><div class="cert">${cert}</div><div class="hold">${hold}</div><div class="sol">solving…</div>`;
    const solEl = resultEl.querySelector('.sol')!;
    void solveState(st)
      .then((s) => { solEl.textContent = s.trim() === '' ? 'Already solved!' : s; })
      .catch((e) => { solEl.textContent = `solver failed: ${e}`; });
    // The cube is read: freeze the view on the frame that locked it (the
    // overlay stays up) rather than keep streaming a feed nothing reads any
    // more. A clip must play to its end so the autocapture hook fires.
    // (not while recording a solve: the moves come after the lock)
    if (!clipUrl && !recorder) setPaused(true);
  }
  if (sol !== renderedSolution) { renderedSolution = sol; renderSolution(); }
}

function loop(ts: number, gen: number): void {
  if (!running || gen !== loopGen) return;
  const again = () => requestAnimationFrame((t) => loop(t, gen));
  if (paused || (vfcSeen && !vfcFresh)) { again(); return; }
  vfcFresh = false;
  const v = camera.video;
  if (v.videoWidth > 0) {
    if (view.width !== v.videoWidth || view.height !== v.videoHeight) {
      view.width = v.videoWidth;
      view.height = v.videoHeight;
      // the desktop layout caps the stage by viewport height through this ratio
      $('stage').style.setProperty('--ar', (v.videoWidth / v.videoHeight).toFixed(4));
    }
    const head = ring.push(v, ts);
    frameNo++;

    // Detector on a cadence, never overlapping inferences, always on the
    // newest frame. Every tick is stage 1 on the frame then stage 2 on its
    // padded box; a stage-1 miss hands the tracker an empty detection list
    // (tracks decay exactly as they do when stage 2 finds nothing) and the
    // banner says no cube. Cadence: 'auto' runs a tick whenever the
    // inference worker and the sampler are both free - a desktop then ticks
    // every frame, a phone at whatever its inference allows - else every
    // Nth frame.
    const m = models;
    const due = everySel.value === 'auto' ? !sampler.busy : frameNo % Number(everySel.value) === 0;
    if (m && !inferBusy && due) {
      inferBusy = true;
      void (async () => {
        try {
          const t = await tick(head.canvas, m);
          ticks++;
          if (!t.box) stage1Misses++;
          locateEma = locateEma === 0 ? t.locateMs : 0.1 * t.locateMs + 0.9 * locateEma;
          if (t.result) inferEma = inferEma === 0 ? t.result.inferMs : 0.1 * t.result.inferMs + 0.9 * inferEma;
          // latency in frames: how far the camera moved on while the detector
          // looked, plus the one pass before this result can be applied
          const lag = ring.head - head.index + 1;
          lagMax = Math.max(lagMax, lag);
          lagEma = lagEma === 0 ? lag : 0.1 * lag + 0.9 * lagEma;
          // anonymous quads feed the tracker once the view reaches this frame
          arrivals.push({ frame: head.index, ts: head.ts, tick: t, dets: (t.result?.quads ?? []).map((q) => ({ corners: q.corners, conf: q.conf })) });
          tickHistory.push(summarizeTick(Date.now(), t.obj, t.result));
          if (tickHistory.length > TICK_HISTORY) tickHistory.shift();
          if (cellsChk.checked) renderCellReadout(cellsEl, t.result, m.detector.exemplars);
        } catch { /* transient failure: try again next cadence */ }
        inferBusy = false;
      })();
    }

    // Which frame to show. Synced: as many frames behind the camera as the
    // detector is slow, so a tick's frame is still ahead of (or at) the view
    // when the tick lands. Live: the newest frame. The pointer never goes
    // backwards - a delay increase repeats a frame, a decrease skips one.
    lagMax = Math.max(0, lagMax - LAG_DECAY_PER_FRAME);
    const delay = syncSel.value === 'sync' ? Math.min(RING_FRAMES - 2, Math.ceil(lagMax)) : 0;
    const wantIndex = Math.min(head.index, Math.max(shown?.index ?? -1, head.index - delay));
    const frame = ring.get(wantIndex) ?? head;
    const dt = shown && frame.index !== shown.index ? frame.ts - shown.ts : 0;
    ctx.drawImage(frame.canvas, 0, 0);

    // The newest finished tick at or before this frame is applied now;
    // older ones it supersedes are dropped; newer ones wait their turn. A
    // tick applied after its frame is carried forward by the lag.
    let applied: Arrival | null = null;
    while (arrivals.length && arrivals[0]!.frame <= frame.index) applied = arrivals.shift()!;
    const lagMs = applied ? Math.max(0, frame.ts - applied.ts) : 0;
    if (applied) {
      if (applied.frame < frame.index) lateTicks++;
      const t = applied.tick;
      lastTick = t;
      noCube = !t.box;
      // A face edge can't exceed the cube's silhouette, so a silhouette
      // under the range floor (a fraction of the SOURCE frame height) is
      // too far, full stop - whatever stage 2 then says about it.
      cubeTooSmall = !!t.box
        && Math.max(t.box.box[2] - t.box.box[0], t.box.box[3] - t.box.box[1]) < minFaceEdgePx(v.videoHeight);
    }
    const dets = applied?.dets ?? null;
    const tracks = tracker.update(dets, dt, lagMs);
    // track births and deaths, for the log (re-acquisition prior) and housekeeping
    const nowIds = new Set(tracks.map((t) => t.id));
    const centroid = (c: [number, number][]): [number, number] => [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
    for (const id of knownTracks) {
      if (nowIds.has(id)) continue;
      const last = lastCorners.get(id);
      if (last) log.events.push({ frame: detFrame, t: Date.now(), track: id, kind: 'died', at: centroid(last.corners) });
      lastCorners.delete(id);
      lastOffset.delete(id);
      nthOf.delete(id);
    }
    for (const t of tracks) {
      if (!knownTracks.has(t.id)) log.events.push({ frame: detFrame, t: Date.now(), track: t.id, kind: 'born', at: centroid(t.corners) });
    }
    knownTracks = nowIds;
    if (tracks.some((t) => t.conf >= SAMPLE_CONF)) lastGoodDetectionTs = ts;

    // Every confident track is read. The low-res namer's quality refusals
    // (too dark, glare, obscured centre) drive the hint banner only: in the
    // log they are weights, not gates (design P5) - a blown patch weighs
    // zero on its own and a dark face converges slowly, but nothing about a
    // doubtful centre stops the other eight stickers from counting.
    const confident = tracks.filter((t) => t.conf >= SAMPLE_CONF);
    const pipeStart = performance.now();
    if (dets && (!locked || solveMode())) {
      detFrame++;
      log.frames = detFrame;
      // only tracks with a detection THIS frame: a coasting track is the
      // same pixels under a stale quad, and beside its own replacement it
      // reads as a second face in the frame
      const fresh = confident.filter((t) => t.sinceDetectMs === 0);
      // the pixels the detector saw (gone from the ring only after a
      // latency spike longer than the ring - then this tick is not read)
      const src = ring.get(applied!.frame);
      if (fresh.length && src && !sampler.busy && src.ts - lastSampleTs >= SAMPLE_MIN_MS) {
        lastSampleTs = src.ts;
        const tracks: SampleTrack[] = fresh.map((t) => {
          // corners AT that frame: the filtered ones when the view is on it,
          // the raw measurement when the tick was applied late (the filtered
          // quad has been carried forward past the frame by then)
          const corners = lagMs > 0 && t.measured ? t.measured : t.corners;
          const prev = lastCorners.get(t.id);
          let speed = 0;
          if (prev && src.ts > prev.t) {
            let dd = 0;
            for (let i = 0; i < 4; i++) dd += Math.hypot(corners[i]![0] - prev.corners[i]![0], corners[i]![1] - prev.corners[i]![1]);
            speed = dd / 4 / (src.ts - prev.t);
          }
          lastCorners.set(t.id, { corners, t: src.ts });
          const nth = (nthOf.get(t.id) ?? 0) + 1;
          nthOf.set(t.id, nth);
          return { id: t.id, corners, conf: t.conf, speed, nth, warm: lastOffset.get(t.id) };
        });
        // letter-free pairings: two quads sharing an image-space edge. Which
        // cube edge it is, and hence every rotation, is the solver's job.
        const pairs: { a: number; b: number; edgeA: number; edgeB: number; cost: number; tol: number }[] = [];
        for (let i = 0; i < fresh.length; i++) {
          for (let j = i + 1; j < fresh.length; j++) {
            const mm = matchSharedEdge(fresh[i]!.corners, fresh[j]!.corners);
            if (mm) pairs.push({ a: fresh[i]!.id, b: fresh[j]!.id, edgeA: mm.i, edgeB: mm.j, cost: mm.cost, tol: mm.tol });
          }
        }
        pendingPairings.set(detFrame, pairs);
        const px = frameImageData(src.canvas);
        sampler.sample(detFrame, Date.now(), px.width, px.height, px.data.buffer, tracks, REFINE);
      }
      const pipeMs = performance.now() - pipeStart;
      pipeEma = pipeEma === 0 ? pipeMs : 0.1 * pipeMs + 0.9 * pipeEma;
    }
    if (!locked && !solver.busy && logVersion !== solvedVersion && ts - lastSolveTs >= Math.max(SOLVE_MIN_MS, 1.5 * solveEma)) {
      lastSolveTs = ts;
      solvedVersion = logVersion;
      void solver.requestSolve().then((sol) => {
        if (locked) return;
        solution = sol;
        solveEma = solveEma === 0 ? sol.ms : 0.2 * sol.ms + 0.8 * solveEma;
        if (sol.lockable) locked = sol;
      });
    }

    if (!confident.length || locked) sampledQuads = [];
    drawOverlay(tracks);
    if (samplesChk.checked) drawSamplePatches();
    // Banner for refusals the user can fix (too far, too dark, glare).
    const reasons = lastTick?.result?.unnamed.map((u) => u.reason).filter(isQualityRefusal) ?? [];
    const dark = confident.length > 0 && !locked && peakEma < DARK_PEAK;
    const hint = hintState.update(hintFor(reasons, confident.length > 0, cubeTooSmall, noCube, dark), ts);
    // Cube-metered exposure: the camera's own metering weighs the whole
    // frame; when the stickers being read are dark (or blown out) ask the
    // camera for one step more (less), where it offers exposure
    // compensation at all - a no-op elsewhere.
    if (!clipUrl && confident.length > 0 && !locked && !exposureGaveUp && ts - exposureAt >= EXPOSURE_HOLD_MS) {
      // A step must prove itself: the webcam's auto mode brightens a dark
      // room with gain that a manual exposure time resets, so the step
      // that should have helped turned the picture black (evening session,
      // 2026-09-13). No brighter after the hold-off means back to auto and
      // no more steps this session.
      if (exposurePeakBefore !== null && peakEma < exposurePeakBefore * 1.15 + 3) {
        exposurePeakBefore = null;
        exposureGaveUp = true;
        exposureAt = ts;
        void camera.resetExposure().then((v) => { if (v !== null) exposureComp = `${v} (step did not help)`; });
      } else {
        exposurePeakBefore = null;
        const dir = dark ? 1 : clipEma > 0.3 ? -1 : 0;
        if (dir) {
          exposureAt = ts;
          const before = peakEma;
          void camera.nudgeExposure(dir).then((v) => {
            if (v === null) return;
            exposureComp = v;
            if (dir > 0) exposurePeakBefore = before;
          });
        }
      }
    }
    hintEl.hidden = !hint;
    if (hint) hintEl.textContent = hint.text;
    fps.tick();
    if (ts - lastUiTs >= UI_EVERY_MS) {
      lastUiTs = ts;
      if (m?.detector.anonymous) exemplarSwatches(swatchEl, m.detector.exemplars);
      if (exChk.checked) renderSolver();
      updateFillUI();
      fallbackEl.style.display = ts - lastGoodDetectionTs > FALLBACK_AFTER_MS ? 'block' : 'none';
      statsEl.textContent =
        `fps ${fps.fps.toFixed(1)}   view ${delay ? `-${delay} frame${delay === 1 ? '' : 's'}` : 'live'} (latency ${lagEma.toFixed(1)} frames, late ${lateTicks}/${ticks})   sampling ${sampler.msEma.toFixed(0)} ms (worker, dropped ${sampler.dropped})   peak ${peakEma.toFixed(0)}${exposureComp !== null ? ` exposure ${exposureComp}` : ''}   solve ${solveEma.toFixed(0)} ms   tracks ${tracks.length}   groups ${solution?.groups.length ?? 0}   faces ${solution?.centresSeen ?? 0}/6   quads ${log.quads.length}   pairings ${log.pairings.length}\n`
        + (m ? `${v.videoWidth}x${v.videoHeight} ${m.detector.ep}${m.detector.threads > 1 ? ` x${m.detector.threads}` : ''}${m.detector.proxied ? ' (worker)' : ''}   ` : '')
        + (lastTick
          ? `stage 1 ${locateEma.toFixed(1)} ms obj ${lastTick.obj.toFixed(2)} (misses ${stage1Misses}/${ticks})   `
            + (lastTick.result
              ? `stage 2 ${inferEma.toFixed(1)} ms  quads ${lastTick.result.quads.length}`
              : stage2Off.checked ? 'stage 2 off' : 'stage 2 skipped')
          : '');
    }
    shown = frame;
  }
  again();
}

function stopAuto(): void {
  running = false;
  loopGen++;
  setPaused(false);
  camera.stop();
  startBtn.textContent = 'Start camera';
  saveBtn.disabled = true;
  captureBtn.disabled = true;
  pauseBtn.disabled = true;
  if (recorder) recorder.stop(); // the stream is about to end; keep what was recorded
  recBtn.disabled = true;
}

function setPaused(on: boolean): void {
  paused = on;
  pauseBtn.textContent = on ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('on', on);
  $('lockbadge').hidden = !(on && locked);
  const v = camera.video;
  if (on) v.pause(); else void v.play().catch(() => undefined);
}

pauseBtn.addEventListener('click', () => { if (running) setPaused(!paused); });

// Solve recording: MediaRecorder on the live camera stream, so the .webm
// holds exactly the frames the pipeline saw at app resolution. Stopping it
// downloads the video and then fires the debug capture, whose evidence log
// carries the same wall-clock t as `recording.startedAt` - video time is
// t - startedAt. The clip replay (below) then reproduces the session with no
// hands, and `movesApplied` / `endTruth` are the fixture's truth.
const recBtn = $<HTMLButtonElement>('rec');
const movesInput = $<HTMLInputElement>('moves');
const recStateEl = $('recState');
let recorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recording: { startedAt: number; stoppedAt: number | null; file: string; mime: string } | null = null;
let recTimer = 0;
const MOVES_RE = /^(\s*[URFDLBurfdlbMESxyz][2']?)*\s*$/;
function movesText(): string { return movesInput.value.trim().replace(/\s+/g, ' '); }
/** The state after scramble + moves from solved, when both are trustworthy. */
function endTruth(): string | null {
  const m = movesText();
  if (!appliedChk.checked || !MOVES_RE.test(m)) return null;
  try { return scrambleState(m ? `${scramble} ${m}` : scramble); } catch { return null; }
}
function pickMime(): string {
  // DECISION: webm first (Android Chrome, desktop); mp4 is Safari's only option
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}
function startRecording(): void {
  const stream = camera.stream;
  if (!running || !stream || typeof MediaRecorder === 'undefined') { msgEl.textContent = 'recording needs the live camera'; return; }
  const mime = pickMime();
  const startedAt = Date.now();
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  recording = { startedAt, stoppedAt: null, file: `solve-rec-${startedAt}.${ext}`, mime };
  recChunks = [];
  // DECISION: 2.5 Mbps at 640x480 - ~20 MB/min, clean enough to re-run the detector on
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) recChunks.push(e.data); });
  recorder.addEventListener('stop', () => {
    const rec = recording!;
    rec.stoppedAt = Date.now();
    downloadBlob(new Blob(recChunks, { type: recorder?.mimeType || mime || 'video/webm' }), rec.file);
    recChunks = [];
    recorder = null;
    recBtn.textContent = 'Record';
    recBtn.classList.remove('on');
    movesInput.disabled = false;
    clearInterval(recTimer);
    recStateEl.textContent = `saved ${rec.file} (${((rec.stoppedAt - rec.startedAt) / 1000).toFixed(1)} s)`;
    // the paired evidence log; a second download prompt on Android is expected
    setTimeout(() => captureBtn.click(), 800);
  });
  recorder.start(1000);
  recBtn.textContent = 'Stop recording';
  recBtn.classList.add('on');
  movesInput.disabled = true; // the moves are the truth for this take - fix them before pressing Record
  const tick = () => { recStateEl.textContent = `REC ${((Date.now() - startedAt) / 1000).toFixed(0)} s`; };
  tick();
  recTimer = window.setInterval(tick, 500);
}
recBtn.addEventListener('click', () => {
  if (recorder) recorder.stop(); else startRecording();
});

// Clip replay: scan.html?clip=/clips/x.mp4[&autostart=1][&autocapture=1]
// feeds a recording through the live pipeline (camera.ts startClip); with
// autocapture the debug capture downloads when the clip ends, so a clip
// becomes an evidence-log fixture with no hands on the cube.
const params = new URL(location.href).searchParams;
const clipUrl = params.get('clip');
// Solve mode (?solve=1, or while a recording is running): the log keeps
// growing after the start lock - sampling continues, nothing is trimmed -
// so the moves that follow the lock are in the capture. The solver still
// stops at the lock; its Solution is the start state, not a running read.
const solveMode = (): boolean => params.get('solve') === '1' || recorder !== null;
if (clipUrl) startBtn.textContent = 'Play clip';

startBtn.addEventListener('click', () => {
  void (async () => {
    if (running) { stopAuto(); return; }
    msgEl.textContent = '';
    try {
      if (clipUrl) {
        await camera.startClip(clipUrl, () => {
          if (recording) recording.stoppedAt = Date.now();
          const sol = locked ?? solution;
          msgEl.textContent = `clip ended - ${locked ? 'LOCKED' : (sol?.reason ?? 'no solution')}`;
          console.log(`CLIP ENDED locked=${!!locked} reason="${sol?.reason ?? ''}" facelets=${sol?.facelets ?? ''} frames=${log.frames} quads=${log.quads.length}`);
          if (params.get('autocapture')) setTimeout(() => captureBtn.click(), 1500);
        });
        // a replayed clip is stamped like a live recording: video time = t - startedAt
        recording = { startedAt: Date.now(), stoppedAt: null, file: clipUrl, mime: 'clip' };
      } else await camera.start();
      running = true;
      lastGoodDetectionTs = performance.now();
      startBtn.textContent = 'Stop camera';
      saveBtn.disabled = false;
      captureBtn.disabled = false;
      pauseBtn.disabled = false;
      recBtn.disabled = !!clipUrl;
      const gen = ++loopGen;
      vfcSeen = vfcFresh = false;
      armFrameSignal(camera.video, gen);
      requestAnimationFrame((t) => loop(t, gen));
    } catch (err) {
      msgEl.textContent = String(err instanceof Error ? err.message : err);
    }
  })();
});

$('reset').addEventListener('click', () => {
  newScramble();
  tracker.reset();
  arrivals.length = 0;
  log = emptyLog();
  detFrame = 0;
  lastCorners.clear();
  lastOffset.clear();
  nthOf.clear();
  knownTracks = new Set();
  solution = null;
  locked = null;
  logVersion = 0;
  solvedVersion = -1;
  solver.reset();
  pendingPairings.clear();
  models?.detector.exemplars.reset();
  solved = false;
  lastTick = null;
  setPaused(false);
  resultEl.textContent = '';
  $('attemptHd').hidden = true;
  $('legend').hidden = true;
  hintEl.hidden = true;
  stage1Misses = ticks = lateTicks = 0;
  sampledQuads = [];
  lastSampleTs = -Infinity;
  peakEma = 255;
  clipEma = 0;
  exposurePeakBefore = null;
  exposureGaveUp = false;
  void camera.resetExposure().then((v) => { if (v !== null) exposureComp = v; });
  renderedSolution = null;
  attemptEl.replaceChildren();
  tickHistory.length = 0;
});

// ---- debug exports (raw frame only, never the overlay) -------------------

saveBtn.addEventListener('click', () => {
  if (!running) return;
  void saveRawFrame(exportFrame(), 'scan-frame').then((name) => { msgEl.textContent = name ? `saved ${name}` : ''; });
});
captureBtn.addEventListener('click', () => {
  if (!models) { msgEl.textContent = 'nothing to capture: models not loaded'; return; }
  const sol = locked ?? solution;
  const extra = {
    // evidence-log capture format version: 2 = glare means blown to white
    // (v1 counted any saturated channel, which zeroed every orange reading)
    version: 2,
    scramble,
    // the truth only when the user says the scramble was applied from solved
    scrambleApplied: appliedChk.checked,
    scrambleTruth: appliedChk.checked ? scrambleState(scramble) : null,
    // solve recording (null when none): the .webm's name and wall-clock span
    // (video time = QuadObs.t - startedAt), the moves the user said they
    // turned, and the resulting state when scramble and moves are both truth
    recording,
    movesApplied: movesText() || null,
    endTruth: endTruth(),
    evidenceLog: log,
    solution: sol ? { ...sol, groups: sol.groups.map((g) => ({ ...g, rotation: [...g.rotation] })), gains: [...sol.gains] } : null,
    params: DEFAULT_PARAMS,
    locked: !!locked,
    stats: statsEl.textContent,
    timing: { fps: +fps.fps.toFixed(1), viewDelayFrames: syncSel.value === 'sync' ? Math.ceil(lagMax) : 0, latencyFrames: +lagEma.toFixed(2), lateTicks, samplingMs: +sampler.msEma.toFixed(1), samplingDropped: sampler.dropped, sampleMinMs: SAMPLE_MIN_MS, peak: +peakEma.toFixed(0), clip: +clipEma.toFixed(2), exposureComp, detectEvery: everySel.value, solveMs: +solveEma.toFixed(1), locateMs: +locateEma.toFixed(1), inferMs: +inferEma.toFixed(1), stage1Misses, ticks, ep: models.detector.ep, threads: models.detector.threads, worker: models.detector.proxied, bench: models.detector.benchMs ?? null },
  };
  const post = params.get('post');
  const sink = post
    ? async (json: string, name: string) => { await fetch(`/__capture?name=${encodeURIComponent(post === '1' ? name : post)}`, { method: 'POST', body: json }); }
    : undefined;
  void captureDebug(lastTick?.result ?? null, models.detector, exportFrame(), 'scan-debug', tickHistory, extra, sink)
    .then((stem) => { msgEl.textContent = `captured ${stem}.{json,png}`; console.log(`CAPTURED ${stem}`); });
});
cellsChk.addEventListener('change', () => { if (!cellsChk.checked) cellsEl.textContent = ''; });
exChk.addEventListener('change', () => { exEl.hidden = !exChk.checked; });

// ---- modes ----------------------------------------------------------------

let grid: ScannerHandle | null = null;

function setMode(mode: 'auto' | 'grid'): void {
  document.body.classList.toggle('grid', mode === 'grid');
  $('modeAuto').classList.toggle('on', mode === 'auto');
  $('modeGrid').classList.toggle('on', mode === 'grid');
  if (mode === 'grid') {
    if (running) stopAuto();
    grid ??= mountScanner($('grid'));
    grid.start();
  } else {
    grid?.stop();
  }
  const url = new URL(location.href);
  if (mode === 'grid') url.searchParams.set('mode', 'grid'); else url.searchParams.delete('mode');
  history.replaceState(null, '', url);
}

$('modeAuto').addEventListener('click', () => setMode('auto'));
$('modeGrid').addEventListener('click', () => setMode('grid'));
$('toGrid').addEventListener('click', (e) => { e.preventDefault(); setMode('grid'); });
if (new URL(location.href).searchParams.get('mode') === 'grid') setMode('grid');

// Free the camera when the tab is hidden; the user resumes with one tap.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (running) stopAuto();
  grid?.stop();
});

if (clipUrl && params.get('autostart')) {
  // a muted <video> may autoplay without a gesture; the models must be up first
  const kick = () => { if (models) startBtn.click(); else setTimeout(kick, 200); };
  setTimeout(kick, 500);
}

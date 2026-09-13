// scan.html - the one camera page.
//
//   Auto mode  (default) the M6/M7 pipeline per CLAUDE.md: camera -> two-stage
//              detector (stage-1 localizer on the frame, stage-2 corners on its
//              padded box; a stage-1 miss is a tick with no detections) ->
//              corner tracker -> homography rectify at native resolution ->
//              robust 9-cell sampling -> EVIDENCE LOG (readings with quality
//              weights, letter-free shared-edge pairings) -> the colour
//              solver (src/colour/solve.ts, docs/colour-pipeline-design.md)
//              on a timer -> lock on its certificates. Nothing on this page
//              decides a colour; the page pumps frames, appends to the log,
//              and renders the Solution.
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
import { FpsCounter } from './debug/fps';
import { blurScore, facePlan, labToSrgb, minFaceEdgePx, quadEdgePx, quadViewCos, sampleGridStats, type CellPlan } from './color';
import { SolverClient } from './colour/client';
import { emptyLog, makeReading, quadWeight, trimLog } from './colour/evidence';
import { DEFAULT_PARAMS } from './colour/solve';
import type { EvidenceLog, Solution } from './colour/types';
import type { Ep } from './detect/facekp';
import { drawHeatmap, drawQuad, drawStage1, exemplarSwatches } from './debug/detect-overlay';
import { captureDebug, renderCellReadout, saveRawFrame, summarizeTick, type TickSummary } from './debug/dump';
import { installDetectSelfTest } from './debug/selftest';
import { describeModels, loadTwoStage, type TwoStageModels } from './detect/models';
import { detectTwoStage, type TwoStageResult } from './detect/twostage';
import { QuadTracker, type QuadDetection, type TrackedQuad } from './detect/tracker';
import { OBSCURED_REASON, TOO_SMALL_REASON } from './detect/identify';
import { HintState, hintFor } from './ui/hint';
import { matchSharedEdge } from './detect/orient';
import { refineQuad } from './detect/gridfit';
import { mapUV, squareToQuad, warpQuad, type ImageDataLike } from './rectify';
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
const SOLVE_EVERY_MS = 700;
const TICK_HISTORY = 120;    // detection ticks kept for Capture debug (~1 min at 2 fps of ticks)

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="wrap">
    <h1>Scan the cube
      <span id="modes"><button id="modeAuto" class="on">Auto</button><button id="modeGrid">Grid</button></span>
      <small id="status" class="auto">model loading…</small>
      <small id="build" title="git hash · build time">build ${__BUILD__.hash} · ${__BUILD__.time}</small>
    </h1>
    <div id="scramble" class="auto" title="Apply this to a solved cube before scanning: the capture then carries the true state and becomes a regression fixture on its own"></div>
    <div id="bar" class="auto">
      <button id="start">Start camera</button>
      <button id="reset">Reset scan</button>
      <button id="pause" disabled title="Freeze the frame and the overlay to inspect what was sampled">Pause</button>
      <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
    </div>
    <div id="stage" class="auto"><canvas id="view"></canvas><div id="hint" hidden></div></div>
    <div id="fill" class="auto">${FACE_ORDER.map((f) => `<div class="f" id="fill-${f}" style="color:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span>0%</span></div>`).join('')}</div>
    <div id="unbound" class="auto"></div>
    <div id="fallback" class="auto">Having trouble? The <a href="#" id="toGrid">grid scanner</a> always works.</div>
    <div id="result" class="auto"></div>
    <div id="attempt" class="auto grids"></div>
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
          <option value="2">detect every 2nd frame</option>
          <option value="1">detect every frame</option>
          <option value="3">detect every 3rd frame</option>
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
function newScramble(): void {
  scramble = randomScramble();
  $('scramble').innerHTML = `<b>Scramble</b> <span>${scramble}</span> <small>(from solved; new one on Reset)</small>`;
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
const tracker = new QuadTracker();

// The evidence log is the whole colour state of the page. Everything the
// solver knows is in it, so Capture debug dumps it and the replay test can
// reproduce a phone session exactly.
let log: EvidenceLog = emptyLog();
let detFrame = 0;                                  // detection-frame index (log.frames)
const lastCorners = new Map<number, { corners: [number, number][]; t: number }>();
const nthOf = new Map<number, number>();           // track -> detections so far
let knownTracks = new Set<number>();
let solution: Solution | null = null;
let locked: Solution | null = null;
let logVersion = 0;
let solvedVersion = -1;
let solveEma = 0;
const solver = new SolverClient();
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

let models: TwoStageModels | null = null;
let running = false;
let frameNo = 0;
let inferBusy = false;
let pendingDetections: QuadDetection[] | null = null;
// The most recent detection tick, kept for the debug overlay and the banner:
// the pipeline itself consumes `pendingDetections` once and drops it.
let lastTick: TwoStageResult | null = null;
let lastTs = 0;
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

function frameImageData(): ImageDataLike {
  const v = camera.video;
  if (work.width !== v.videoWidth) {
    work.width = v.videoWidth;
    work.height = v.videoHeight;
  }
  workCtx.drawImage(v, 0, 0);
  return workCtx.getImageData(0, 0, work.width, work.height) as unknown as ImageDataLike;
}

/** One detection tick. Stage 1 on the frame, then stage 2 on its padded box
 *  unless the debug panel has switched stage 2 off. */
async function tick(v: HTMLVideoElement, m: TwoStageModels): Promise<TwoStageResult> {
  if (!stage2Off.checked) return detectTwoStage(m.localizer, m.detector, v);
  const t0 = performance.now();
  const box = await m.localizer.locate(v, v.videoWidth, v.videoHeight);
  return { result: null, box, roi: null, obj: m.localizer.lastObj, locateMs: performance.now() - t0 };
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
    hd.textContent = `${face} ${DEFAULT_SCHEME_NAMES[face]}${g ? ` - tracks ${g.tracks.map((t) => `#${t}`).join(' ')}` : ' - not seen'}\n`
      + `evidence ${Math.min(...n).toFixed(1)}-${Math.max(...n).toFixed(1)}${g ? ` - rot ${g.absRotation ?? '?'}${g.rotationVotes.some(Boolean) ? ` (${g.rotationVotes.join('/')})` : ''}` : ''}`;
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
}

/**
 * One quad's contribution to the log: refine the corners against the grid
 * prior, warp, read the nine cells as patch statistics, and weight them by
 * the quad's quality (design 3.1-3.2). Returns false below the size floor -
 * the one hard gate, because facePlan has no sampling budget there.
 */
function observeQuad(frame: ImageDataLike, t: TrackedQuad, frameH: number, now: number): boolean {
  let quad = t.corners.map((c) => [c[0], c[1]]) as [number, number][];
  if (REFINE) quad = refineQuad(frame, quad).quad.map((c) => [c[0], c[1]]) as [number, number][];
  let perim = 0;
  for (let i = 0; i < 4; i++) perim += Math.hypot(quad[i]![0] - quad[(i + 1) % 4]![0], quad[i]![1] - quad[(i + 1) % 4]![1]);
  const plan = facePlan(perim / 4 / 3, minFaceEdgePx(frameH));
  if (!plan) return false;
  const warped = warpQuad(frame, quad, 90);
  const stats = sampleGridStats(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 }, plan);
  const prev = lastCorners.get(t.id);
  let speed = 0;
  if (prev && now > prev.t) {
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(quad[i]![0] - prev.corners[i]![0], quad[i]![1] - prev.corners[i]![1]);
    speed = d / 4 / (now - prev.t);
  }
  lastCorners.set(t.id, { corners: quad, t: now });
  const nth = (nthOf.get(t.id) ?? 0) + 1;
  nthOf.set(t.id, nth);
  const q = { conf: t.conf, blur: blurScore(warped), viewCos: quadViewCos(quad), edgePx: quadEdgePx(quad), speed, nth, frameH };
  const w = quadWeight(q);
  log.quads.push({
    frame: detFrame, t: Date.now(), track: t.id, corners: quad, conf: t.conf,
    blur: q.blur, viewCos: q.viewCos, edgePx: q.edgePx, speed, nth,
    readings: stats.map((p, i) => makeReading(i, p, w)),
  });
  sampledQuads.push({ track: t.id, quad, plan });
  return true;
}

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
  exEl.textContent = [...pal, '', ...groups, '', `${sol.reason} - solve ${sol.ms.toFixed(0)} ms - frames ${log.frames} quads ${log.quads.length} pairings ${log.pairings.length}`].join('\n');
}

let renderedSolution: Solution | null = null;

function updateFillUI(): void {
  const sol = locked ?? solution;
  for (const f of FACE_ORDER) {
    const fi = FACE_ORDER.indexOf(f);
    const n = sol ? Math.min(...sol.nEff.slice(fi * 9, fi * 9 + 9)) : 0;
    document.querySelector(`#fill-${f} span`)!.textContent = `${Math.round(Math.min(1, n / DEFAULT_PARAMS.nMin) * 100)}%`;
  }
  $('unbound').textContent = sol && !locked ? `${sol.centresSeen}/6 faces - ${sol.reason}` : '';
  if (locked && !solved) {
    solved = true;
    const st = locked.facelets!;
    // the solution's moves are named by centre: U is the face whose centre
    // is the U colour, F the F colour - say so, or the moves are meaningless
    const hold = `Hold the cube with the ${DEFAULT_SCHEME_NAMES[st[4] as FaceId]} centre on top and the ${DEFAULT_SCHEME_NAMES[st[22] as FaceId]} centre facing you.`;
    const cert = `(${locked.decode!.changed} sticker(s) moved by the cube's constraints; runner-up ${locked.decode!.delta === Infinity ? 'none' : locked.decode!.delta.toFixed(1)} worse)`;
    resultEl.textContent = `LOCKED\n${st}\n${cert}\nsolving...`;
    void solveState(st)
      .then((sol) => { resultEl.textContent = `LOCKED\n${st}\n${cert}\n\n${hold}\nSolution: ${sol}`; })
      .catch((e) => { resultEl.textContent = `LOCKED\n${st}\n${cert}\n\nsolver failed: ${e}`; });
  }
  if (sol !== renderedSolution) { renderedSolution = sol; renderSolution(); }
}

async function loop(ts: number): Promise<void> {
  if (!running) return;
  if (paused) { requestAnimationFrame((t) => void loop(t)); return; }
  const v = camera.video;
  if (v.videoWidth > 0) {
    if (view.width !== v.videoWidth) {
      view.width = v.videoWidth;
      view.height = v.videoHeight;
    }
    ctx.drawImage(v, 0, 0);
    frameNo++;
    const dt = lastTs ? ts - lastTs : 33;
    lastTs = ts;

    // Detector on a cadence, never overlapping inferences. Every tick is
    // stage 1 on the frame then stage 2 on its padded box; a stage-1 miss
    // hands the tracker an empty detection list (tracks decay exactly as
    // they do when stage 2 finds nothing) and the banner says no cube.
    const m = models;
    if (m && !inferBusy && frameNo % Number(everySel.value) === 0) {
      inferBusy = true;
      void (async () => {
        try {
          const t = await tick(v, m);
          ticks++;
          if (!t.box) stage1Misses++;
          locateEma = locateEma === 0 ? t.locateMs : 0.1 * t.locateMs + 0.9 * locateEma;
          if (t.result) inferEma = inferEma === 0 ? t.result.inferMs : 0.1 * t.result.inferMs + 0.9 * inferEma;
          // anonymous quads feed the tracker; quality refusals are remembered per quad
          pendingDetections = (t.result?.quads ?? []).map((q) => ({ corners: q.corners, conf: q.conf }));
          lastTick = t;
          noCube = !t.box;
          // A face edge can't exceed the cube's silhouette, so a silhouette
          // under the range floor (a fraction of the SOURCE frame height) is
          // too far, full stop - whatever stage 2 then says about it.
          cubeTooSmall = !!t.box
            && Math.max(t.box.box[2] - t.box.box[0], t.box.box[3] - t.box.box[1]) < minFaceEdgePx(v.videoHeight);
          tickHistory.push(summarizeTick(Date.now(), t.obj, t.result));
          if (tickHistory.length > TICK_HISTORY) tickHistory.shift();
          if (cellsChk.checked) renderCellReadout(cellsEl, t.result, m.detector.exemplars);
        } catch { /* transient failure: try again next cadence */ }
        inferBusy = false;
      })();
    }

    const dets = pendingDetections;
    pendingDetections = null;
    const tracks = tracker.update(dets, dt);
    // track births and deaths, for the log (re-acquisition prior) and housekeeping
    const nowIds = new Set(tracks.map((t) => t.id));
    const centroid = (c: [number, number][]): [number, number] => [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
    for (const id of knownTracks) {
      if (nowIds.has(id)) continue;
      const last = lastCorners.get(id);
      if (last) log.events.push({ frame: detFrame, t: Date.now(), track: id, kind: 'died', at: centroid(last.corners) });
      lastCorners.delete(id);
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
    if (dets && !locked) {
      detFrame++;
      log.frames = detFrame;
      if (confident.length) {
        const frame = frameImageData();
        sampledQuads = [];
        const observed: TrackedQuad[] = [];
        // only tracks with a detection THIS frame: a coasting track is the
        // same pixels under a stale quad, and beside its own replacement it
        // reads as a second face in the frame
        for (const t of confident) if (t.sinceDetectMs === 0 && observeQuad(frame, t, v.videoHeight, ts)) observed.push(t);
        // letter-free pairings: two quads sharing an image-space edge. Which
        // cube edge it is, and hence every rotation, is the solver's job.
        for (let i = 0; i < observed.length; i++) {
          for (let j = i + 1; j < observed.length; j++) {
            const a = observed[i]!;
            const b = observed[j]!;
            const m = matchSharedEdge(a.corners, b.corners);
            if (m) log.pairings.push({ frame: detFrame, a: a.id, b: b.id, edgeA: m.i, edgeB: m.j, cost: m.cost, tol: m.tol });
          }
        }
        // mirror to the worker before trimming so both logs trim identically
        solver.sync(log);
        const dropped = trimLog(log);
        solver.trimmed(dropped.quads, dropped.pairings, dropped.events);
        logVersion++;
      }
      const pipeMs = performance.now() - pipeStart;
      pipeEma = pipeEma === 0 ? pipeMs : 0.1 * pipeMs + 0.9 * pipeEma;
    }
    if (!locked && !solver.busy && logVersion !== solvedVersion && ts - lastSolveTs >= SOLVE_EVERY_MS) {
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
    const hint = hintState.update(hintFor(reasons, confident.length > 0, cubeTooSmall, noCube), ts);
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
        `fps ${fps.fps.toFixed(1)}   sampling ${pipeEma.toFixed(1)} ms   solve ${solveEma.toFixed(0)} ms   tracks ${tracks.length}   groups ${solution?.groups.length ?? 0}   faces ${solution?.centresSeen ?? 0}/6   quads ${log.quads.length}   pairings ${log.pairings.length}\n`
        + (m ? `${v.videoWidth}x${v.videoHeight} ${m.detector.ep}${m.detector.threads > 1 ? ` x${m.detector.threads}` : ''}${m.detector.proxied ? ' (worker)' : ''}   ` : '')
        + (lastTick
          ? `stage 1 ${locateEma.toFixed(1)} ms obj ${lastTick.obj.toFixed(2)} (misses ${stage1Misses}/${ticks})   `
            + (lastTick.result
              ? `stage 2 ${inferEma.toFixed(1)} ms  quads ${lastTick.result.quads.length}`
              : stage2Off.checked ? 'stage 2 off' : 'stage 2 skipped')
          : '');
    }
  }
  requestAnimationFrame((t) => void loop(t));
}

function stopAuto(): void {
  running = false;
  setPaused(false);
  camera.stop();
  startBtn.textContent = 'Start camera';
  saveBtn.disabled = true;
  captureBtn.disabled = true;
  pauseBtn.disabled = true;
}

function setPaused(on: boolean): void {
  paused = on;
  pauseBtn.textContent = on ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('on', on);
  const v = camera.video;
  if (on) v.pause(); else void v.play().catch(() => undefined);
}

pauseBtn.addEventListener('click', () => { if (running) setPaused(!paused); });

startBtn.addEventListener('click', () => {
  void (async () => {
    if (running) { stopAuto(); return; }
    msgEl.textContent = '';
    try {
      await camera.start();
      running = true;
      lastGoodDetectionTs = performance.now();
      startBtn.textContent = 'Stop camera';
      saveBtn.disabled = false;
      captureBtn.disabled = false;
      pauseBtn.disabled = false;
      requestAnimationFrame((t) => void loop(t));
    } catch (err) {
      msgEl.textContent = String(err instanceof Error ? err.message : err);
    }
  })();
});

$('reset').addEventListener('click', () => {
  newScramble();
  tracker.reset();
  log = emptyLog();
  detFrame = 0;
  lastCorners.clear();
  nthOf.clear();
  knownTracks = new Set();
  solution = null;
  locked = null;
  logVersion = 0;
  solvedVersion = -1;
  solver.reset();
  models?.detector.exemplars.reset();
  solved = false;
  lastTick = null;
  resultEl.textContent = '';
  hintEl.hidden = true;
  stage1Misses = ticks = 0;
  sampledQuads = [];
  renderedSolution = null;
  attemptEl.replaceChildren();
  tickHistory.length = 0;
});

// ---- debug exports (raw frame only, never the overlay) -------------------

saveBtn.addEventListener('click', () => {
  if (!running) return;
  void saveRawFrame(camera.video, 'scan-frame').then((name) => { msgEl.textContent = name ? `saved ${name}` : ''; });
});
captureBtn.addEventListener('click', () => {
  if (!models) { msgEl.textContent = 'nothing to capture: models not loaded'; return; }
  const sol = locked ?? solution;
  const extra = {
    scramble,
    scrambleTruth: scrambleState(scramble),
    evidenceLog: log,
    solution: sol ? { ...sol, groups: sol.groups.map((g) => ({ ...g, rotation: [...g.rotation] })), gains: [...sol.gains] } : null,
    params: DEFAULT_PARAMS,
    locked: !!locked,
    stats: statsEl.textContent,
    timing: { fps: +fps.fps.toFixed(1), samplingMs: +pipeEma.toFixed(1), solveMs: +solveEma.toFixed(1), locateMs: +locateEma.toFixed(1), inferMs: +inferEma.toFixed(1), stage1Misses, ticks, ep: models.detector.ep, threads: models.detector.threads, worker: models.detector.proxied, bench: models.detector.benchMs ?? null },
  };
  void captureDebug(lastTick?.result ?? null, models.detector, camera.video, 'scan-debug', tickHistory, extra)
    .then((stem) => { msgEl.textContent = `captured ${stem}.{json,png}`; });
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

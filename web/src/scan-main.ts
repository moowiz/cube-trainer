// scan.html - the one camera page.
//
//   Auto mode  (default) the M6/M7 pipeline per CLAUDE.md: camera -> two-stage
//              detector (stage-1 localizer on the frame, stage-2 corners on its
//              padded box; a stage-1 miss is a tick with no detections) ->
//              corner tracker -> orientation from shared edges -> homography
//              rectify at native resolution -> 9-cell Lab sampling ->
//              per-sticker voting -> lock on convergence + cubejs validation.
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
import { StickerVoter, type FaceObservation } from './assembly';
import { minFaceEdgePx, sampleGridCells } from './color';
import type { DetectedFace, Ep } from './detect/facekp';
import { drawHeatmap, drawQuad, drawStage1, exemplarSwatches } from './debug/detect-overlay';
import { captureDebug, renderCellReadout, saveRawFrame, summarizeTick, type TickSummary } from './debug/dump';
import { installDetectSelfTest } from './debug/selftest';
import { describeModels, loadTwoStage, type TwoStageModels } from './detect/models';
import { detectTwoStage, type TwoStageResult } from './detect/twostage';
import { FaceTracker, type TrackedFace } from './detect/tracker';
import { TOO_SMALL_REASON } from './detect/identify';
import { HintState, hintFor } from './ui/hint';
import { resolveOrientations, orientQuad, fuseSharedCorners } from './detect/orient';
import { refineQuad, seamScore } from './detect/gridfit';
import { warpQuad, type ImageDataLike } from './rectify';
import { solveState } from './state';
import { mountScanner, type ScannerHandle } from './ui/scanner';
import { DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from './types';
import type { FaceId } from './types';

const SAMPLE_CONF = 0.55;    // min tracked conf to contribute color samples
const REFINE = true;         // grid-prior corner refinement before sampling
// Seam-score veto: a face whose PRE-refinement warp shows no 3x3 seam
// structure does not vote, no matter how confident the model is (the conf
// head predicts visibility, not quad quality - batch4 produced garbage
// quads at conf 1.00). Calibrated on 87 hand-labeled real faces vs 30
// known-garbage quads: score>=1.15 keeps 97% of good faces, rejects 83%
// of garbage. Must run BEFORE refineQuad - refinement optimizes this very
// metric and lifts garbage from ~0.63 to ~1.4 (would pass 70-80%).
const SEAM_VETO_SCORE = 1.15;
const FALLBACK_AFTER_MS = 6000;
const TICK_HISTORY = 120;    // detection ticks kept for Capture debug (~1 min at 2 fps of ticks)

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="wrap">
    <h1>Scan the cube
      <span id="modes"><button id="modeAuto" class="on">Auto</button><button id="modeGrid">Grid</button></span>
      <small id="status" class="auto">model loading…</small>
      <small id="build" title="git hash · build time">build ${__BUILD__.hash} · ${__BUILD__.time}</small>
    </h1>
    <div id="bar" class="auto">
      <button id="start">Start camera</button>
      <button id="reset">Reset scan</button>
      <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
    </div>
    <div id="stage" class="auto"><canvas id="view"></canvas><div id="hint" hidden></div></div>
    <div id="fill" class="auto">${FACE_ORDER.map((f) => `<div class="f" id="fill-${f}" style="color:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span>0%</span></div>`).join('')}</div>
    <div id="fallback" class="auto">Having trouble? The <a href="#" id="toGrid">grid scanner</a> always works.</div>
    <div id="result" class="auto"></div>
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
        <label><input type="checkbox" id="stage1" checked> stage-1 box + ROI</label>
        <label id="heatLbl" hidden><input type="checkbox" id="heat"> heatmap</label>
        <label><input type="checkbox" id="stage2off"> stage 2 off (localizer only)</label>
        <label id="cellsLbl" hidden><input type="checkbox" id="cellsChk"> per-sticker readout</label>
        <label><input type="checkbox" id="exChk"> exemplars</label>
        <button id="capture" disabled title="Download this tick's naming evidence + the last ${TICK_HISTORY} ticks as JSON, plus the raw frame">Capture debug</button>
      </div>
      <div id="msg"></div>
      <div id="swatches" hidden></div>
      <div id="exemplars" hidden></div>
      <div id="cells"></div>
    </details>
    <div id="grid"></div>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
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
const exEl = $('exemplars');

const camera = new Camera();
const fps = new FpsCounter();
const tracker = new FaceTracker();
const voter = new StickerVoter();
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

let models: TwoStageModels | null = null;
let running = false;
let frameNo = 0;
let inferBusy = false;
let pendingDetections: DetectedFace[] | null = null;
// The most recent detection tick, kept for the debug overlay and the banner:
// the pipeline itself consumes `pendingDetections` once and drops it.
let lastTick: TwoStageResult | null = null;
let lastTs = 0;
let rotations: Partial<Record<FaceId, number>> = {};
let lastGoodDetectionTs = 0;
const hintState = new HintState();
let cubeTooSmall = false;  // localizer found a cube whose silhouette is under the face floor
let noCube = false;        // localizer found nothing on the last tick
let solved = false;
let vetoedCount = 0;       // faces skipped by the seam veto (debug stat)
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

function drawOverlay(tracks: TrackedFace[]): void {
  // Debug layering, back to front: stage 1's box and ROI, heatmap, then the
  // raw anonymous quads in grey (what the model actually said), then the
  // tracked+named ones in scheme colors (what the app decided). Seeing them
  // all at once is how a naming bug is told apart from a detection bug, and
  // a stage-1 miss from a stage-2 one. Dashed amber = seen but deliberately
  // skipped for size; solid grey = tried, could not name.
  if (lastTick?.result?.heat && heatChk.checked) drawHeatmap(ctx, lastTick.result.heat);
  if (lastTick && stageChk.checked) drawStage1(ctx, lastTick.box?.box ?? null, lastTick.roi, lastTick.obj);
  if (lastTick?.result) {
    for (const u of lastTick.result.unnamed) {
      const tooSmall = u.reason.startsWith(TOO_SMALL_REASON);
      drawQuad(ctx, u.quad.corners, tooSmall ? '#d98a1f' : '#8b93a3', `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5, tooSmall);
    }
  }
  for (const t of tracks) {
    const strong = t.conf >= SAMPLE_CONF;
    const rot = rotations[t.face];
    ctx.globalAlpha = strong ? 1 : 0.5;
    drawQuad(ctx, t.corners, DEFAULT_SCHEME_HEX[t.face], `${t.face}${rot === undefined ? '?' : ''} ${t.conf.toFixed(2)}`, strong ? 4 : 1.5);
    ctx.globalAlpha = 1;
  }
}

/** Live exemplar table: what each face's colour is believed to be, and how that belief was built. */
function renderExemplars(m: TwoStageModels): void {
  const ex = m.detector.exemplars;
  const recent = ex.history.slice(-8).reverse()
    .map((e) => `${e.kind === 'observe' ? '+' : '×'} ${DEFAULT_SCHEME_NAMES[e.face]} d${e.own}${e.other ? ` (nearer ${DEFAULT_SCHEME_NAMES[e.other]} ${e.otherD})` : ''}`)
    .join('   ');
  exEl.textContent = ex.status()
    .map((e) => `${DEFAULT_SCHEME_NAMES[e.face].padEnd(6)} ${e.measured ? `measured x${e.n}` : 'prior     '}  L ${e.lab.L.toFixed(0).padStart(4)} a ${e.lab.a.toFixed(0).padStart(4)} b ${e.lab.b.toFixed(0).padStart(4)}`)
    .join('\n') + `\nrejected ${ex.rejected}   last: ${recent || '—'}`;
}

function updateFillUI(): void {
  const p = voter.progress();
  for (const f of FACE_ORDER) {
    document.querySelector(`#fill-${f} span`)!.textContent = `${Math.round(p.faceFill[f] * 100)}%`;
  }
  if (p.locked && !solved) {
    solved = true;
    resultEl.textContent = `LOCKED\n${p.locked.facelets}\nsolving…`;
    void solveState(p.locked.facelets)
      .then((sol) => { resultEl.textContent = `LOCKED\n${p.locked!.facelets}\n\nSolution: ${sol}`; })
      .catch((e) => { resultEl.textContent = `LOCKED\n${p.locked!.facelets}\n\nsolver failed: ${e}`; });
  } else if (!p.locked && p.validationError) {
    resultEl.textContent = `sampling complete but state invalid: ${p.validationError}\n(keep scanning - votes keep updating)`;
  }
}

async function loop(ts: number): Promise<void> {
  if (!running) return;
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
          pendingDetections = t.result?.faces ?? [];
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
          if (exChk.checked) renderExemplars(m);
        } catch { /* transient failure: try again next cadence */ }
        inferBusy = false;
      })();
    }

    const dets = pendingDetections;
    pendingDetections = null;
    const tracks = tracker.update(dets, dt);
    if (tracks.some((t) => t.conf >= SAMPLE_CONF)) lastGoodDetectionTs = ts;

    // orientation: shared edges when 2+ confident faces are co-visible;
    // otherwise each face keeps its previously resolved rotation
    const confident = tracks.filter((t) => t.conf >= SAMPLE_CONF);
    if (confident.length >= 2) {
      const res = resolveOrientations(confident.map((t) => ({ face: t.face, corners: t.corners })));
      for (const [f, k] of Object.entries(res.rotations)) rotations[f as FaceId] = k;
    }
    for (const f of FACE_ORDER) {
      if (rotations[f] !== undefined && !tracks.some((t) => t.face === f)) delete rotations[f];
    }

    // rectify + sample + vote (native-resolution reads)
    if (confident.length && !solved) {
      const frame = frameImageData();
      const observations: FaceObservation[] = [];
      // tier-1 geometry constraint: adjacent faces share physical vertices,
      // so fuse near-agreeing shared-corner estimates before sampling
      const oriented = confident
        .filter((t) => rotations[t.face] !== undefined)
        .map((t) => ({ face: t.face, corners: orientQuad(t.corners, rotations[t.face]!), conf: t.conf }));
      const { fused } = fuseSharedCorners(oriented);
      for (const t of oriented) {
        let quad = fused.get(t.face)!.map((c) => [c[0], c[1]]) as [number, number][];
        if (seamScore(frame, quad).score < SEAM_VETO_SCORE) { vetoedCount++; continue; }
        if (REFINE) quad = refineQuad(frame, quad).quad as [number, number][];
        const warped = warpQuad(frame, quad, 90);
        const cells = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 });
        observations.push({ face: t.face, cells: cells.map((c) => c.lab), conf: t.conf });
        // This face passed the seam veto and is being trusted for color
        // votes, so its center is a free labeled exemplar: hand it to the
        // namer, which until now has only had the default-scheme prior.
        // Full-resolution sampling, unlike the namer's own letterboxed read.
        m?.detector.observeCenter(t.face, cells.map((c) => c.lab), cells[4]!.rgb);
      }
      if (observations.length) voter.addFrame(observations);
    }

    drawOverlay(tracks);
    // Banner for refusals the user can fix (too far, too dark, glare).
    // Reasons come from the same list the grey debug quads show.
    const hint = hintState.update(
      hintFor(lastTick?.result?.unnamed.map((u) => u.reason) ?? [], confident.length > 0, cubeTooSmall, noCube), ts);
    hintEl.hidden = !hint;
    if (hint) hintEl.textContent = hint.text;
    if (m?.detector.anonymous) exemplarSwatches(swatchEl, m.detector.exemplars);
    updateFillUI();
    fallbackEl.style.display = ts - lastGoodDetectionTs > FALLBACK_AFTER_MS ? 'block' : 'none';
    fps.tick();
    statsEl.textContent =
      `fps ${fps.fps.toFixed(1)}   tracks ${tracks.length}   oriented ${Object.keys(rotations).length}   vetoed ${vetoedCount}\n`
      + (m ? `${v.videoWidth}x${v.videoHeight} ${m.detector.ep}   ` : '')
      + (lastTick
        ? `stage 1 ${locateEma.toFixed(1)} ms obj ${lastTick.obj.toFixed(2)} (misses ${stage1Misses}/${ticks})   `
          + (lastTick.result
            ? `stage 2 ${inferEma.toFixed(1)} ms  quads ${lastTick.result.quads.length}  unnamed ${lastTick.result.unnamed.length}  exemplar rejects ${m?.detector.exemplars.rejected ?? 0}`
            : stage2Off.checked ? 'stage 2 off' : 'stage 2 skipped')
        : '');
  }
  requestAnimationFrame((t) => void loop(t));
}

function stopAuto(): void {
  running = false;
  camera.stop();
  startBtn.textContent = 'Start camera';
  saveBtn.disabled = true;
  captureBtn.disabled = true;
}

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
      requestAnimationFrame((t) => void loop(t));
    } catch (err) {
      msgEl.textContent = String(err instanceof Error ? err.message : err);
    }
  })();
});

$('reset').addEventListener('click', () => {
  voter.reset();
  tracker.reset();
  models?.detector.exemplars.reset();
  rotations = {};
  solved = false;
  lastTick = null;
  resultEl.textContent = '';
  hintEl.hidden = true;
  vetoedCount = stage1Misses = ticks = 0;
  tickHistory.length = 0;
});

// ---- debug exports (raw frame only, never the overlay) -------------------

saveBtn.addEventListener('click', () => {
  if (!running) return;
  void saveRawFrame(camera.video, 'scan-frame').then((name) => { msgEl.textContent = name ? `saved ${name}` : ''; });
});
captureBtn.addEventListener('click', () => {
  if (!lastTick?.result || !models) { msgEl.textContent = 'nothing to capture: no stage-2 result on the last tick'; return; }
  void captureDebug(lastTick.result, models.detector, camera.video, 'scan-debug', tickHistory)
    .then((stem) => { msgEl.textContent = `captured ${stem}.{json,png}`; });
});
cellsChk.addEventListener('change', () => { if (!cellsChk.checked) cellsEl.textContent = ''; });
exChk.addEventListener('change', () => { exEl.hidden = !exChk.checked; if (exChk.checked && models) renderExemplars(models); });

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

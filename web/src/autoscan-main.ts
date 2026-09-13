// Any-order auto scanner (M6/M7 integration page).
//
// Pipeline per CLAUDE.md: camera -> two-stage detector (every 2nd frame:
// stage-1 localizer on the frame, stage-2 corners on its padded box; a
// stage-1 miss is a tick with no detections) -> corner tracker (every frame)
// -> orientation from shared edges (carried across single-face frames by the
// track) -> homography rectify at native camera resolution -> 9-cell Lab
// sampling -> per-sticker voting -> lock on convergence + cubejs validation.
// The M1 grid scanner remains the fallback (M8): a banner offers it when
// detection stays weak, and it is the only path when either model is missing.
//
// Standalone page on purpose - the trainer's Scan tab keeps the proven M1
// flow until this one has survived phone testing.

import { Camera } from './camera';
import { FpsCounter } from './debug/fps';
import { StickerVoter, type FaceObservation } from './assembly';
import { sampleGridCells } from './color';
import { FaceDetector } from './detect/facekp';
import { minFaceEdgePx } from './color';
import { drawHeatmap, drawQuad, drawStage1, exemplarSwatches } from './debug/detect-overlay';
import { CubeLocalizer } from './detect/cubebox';
import { detectTwoStage, type TwoStageResult } from './detect/twostage';
import { FaceTracker, type TrackedFace } from './detect/tracker';
import { HintState, hintFor } from './ui/hint';
import { resolveOrientations, orientQuad, fuseSharedCorners } from './detect/orient';
import { refineQuad, seamScore } from './detect/gridfit';
import { warpQuad, type ImageDataLike } from './rectify';
import { solveState } from './state';
import { DEFAULT_SCHEME_HEX, FACE_ORDER } from './types';
import type { FaceId } from './types';

const DETECT_EVERY = 2;      // frames between inferences (CLAUDE.md: 2-3)
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

const app = document.getElementById('app')!;
app.innerHTML = `
  <style>
    body { margin: 0; background: #111318; color: #e8eaf0; font: 14px system-ui, sans-serif; }
    #wrap { max-width: 720px; margin: 0 auto; padding: 12px; }
    h1 { font-size: 18px; margin: 4px 0 10px; }
    #stage { position: relative; background: #000; border-radius: 8px; overflow: hidden; }
    #view { width: 100%; display: block; }
    #hint { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px 14px; text-align: center;
            font-size: 16px; font-weight: 600; color: #fff; background: #c0392bd9; }
    button { background: #2a2f3a; color: inherit; border: 1px solid #3a4150; border-radius: 6px; padding: 8px 14px; font: inherit; }
    #bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
    #fill { display: flex; gap: 6px; margin: 8px 0; }
    .f { flex: 1; text-align: center; border-radius: 6px; padding: 4px 0; background: #1a1e26; border: 1px solid #3a4150; }
    .f b { display: block; }
    #result { background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-top: 10px; white-space: pre-wrap; word-break: break-all; }
    #fallback { display: none; background: #4a3320; border: 1px solid #8a6030; border-radius: 8px; padding: 8px 12px; margin-top: 8px; }
    #fallback a { color: #ffb454; }
    #stats { color: #8891a0; font-variant-numeric: tabular-nums; margin-top: 6px; }
    #swatches { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    #swatches .sw { width: 34px; height: 22px; border-radius: 4px; display: grid; place-items: center;
                    font: 11px system-ui; color: #0006; border: 1px solid #0004; }
    #swatches .sw.seed { opacity: 0.35; border-style: dashed; }
    label { display: flex; gap: 5px; align-items: center; color: #8891a0; }
  </style>
  <div id="wrap">
    <h1>Auto scan (M6/M7) — turn the cube slowly in view</h1>
    <div id="bar">
      <button id="start">Start camera</button>
      <button id="reset">Reset scan</button>
      <label id="heatLbl" style="display:none"><input type="checkbox" id="heat"> heatmap</label>
      <label id="stageLbl" style="display:none"><input type="checkbox" id="stage1" checked> stage-1 box</label>
      <span id="status">model loading…</span>
    </div>
    <div id="stage"><canvas id="view"></canvas><div id="hint" hidden></div></div>
    <div id="fill">${FACE_ORDER.map((f) => `<div class="f" id="fill-${f}" style="color:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span>0%</span></div>`).join('')}</div>
    <div id="fallback">Having trouble? The <a href="scanner.html">grid scanner</a> always works.</div>
    <div id="swatches" style="display:none"></div>
    <div id="result"></div>
    <div id="stats"></div>
  </div>
`;

const view = document.getElementById('view') as HTMLCanvasElement;
const ctx = view.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const resultEl = document.getElementById('result')!;
const fallbackEl = document.getElementById('fallback')!;
const statsEl = document.getElementById('stats')!;
const hintEl = document.getElementById('hint')!;
const swatchEl = document.getElementById('swatches')!;
const heatChk = document.getElementById('heat') as HTMLInputElement;
const heatLbl = document.getElementById('heatLbl')!;
const stageChk = document.getElementById('stage1') as HTMLInputElement;
const stageLbl = document.getElementById('stageLbl')!;

const camera = new Camera();
const fps = new FpsCounter();
const tracker = new FaceTracker();
const voter = new StickerVoter();
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

let detector: FaceDetector | null = null;
let localizer: CubeLocalizer | null = null;
let running = false;
let frameNo = 0;
let inferBusy = false;
let pendingDetections: import('./detect/facekp').DetectedFace[] | null = null;
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
let vetoedCount = 0; // faces skipped by the seam veto (debug stat)

void FaceDetector.load('auto').then(async (d) => {
  // Always two-stage (model/PORTRAIT-DESIGN.md 3.3): a stage 2 without the
  // crop stamp has no path to run on, and a missing stage 1 is the same as a
  // missing stage 2. Either way the grid scanner is the app.
  const l = d ? await CubeLocalizer.load() : null;
  if (!d || !l || !d.cropTrained) {
    detector = null;
    localizer = null;
    statusEl.textContent = !d || !l
      ? 'no model deployed — use the grid scanner'
      : `model ${d.modelId} is not crop-trained — no two-stage path; use the grid scanner`;
    fallbackEl.style.display = 'block';
    return;
  }
  detector = d;
  localizer = l;
  statusEl.textContent = `model ready (${l.modelId} → ${d.modelId}, ${d.ep})`;
  if (d.anonymous) {
    heatLbl.style.display = 'flex';
    swatchEl.style.display = 'flex';
  }
  stageLbl.style.display = 'flex';
});

function frameImageData(): ImageDataLike {
  const v = camera.video;
  if (work.width !== v.videoWidth) {
    work.width = v.videoWidth;
    work.height = v.videoHeight;
  }
  workCtx.drawImage(v, 0, 0);
  return workCtx.getImageData(0, 0, work.width, work.height) as unknown as ImageDataLike;
}

function drawOverlay(tracks: TrackedFace[]): void {
  // Raw anonymous quads first, in grey, under the tracked+named ones: when a
  // face stops being drawn, this says whether the detector lost it or the
  // namer refused it (and why).
  if (lastTick?.result) {
    for (const u of lastTick.result.unnamed) {
      drawQuad(ctx, u.quad.corners, '#8b93a3', `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5);
    }
  }
  for (const t of tracks) {
    const strong = t.conf >= SAMPLE_CONF;
    ctx.strokeStyle = DEFAULT_SCHEME_HEX[t.face];
    ctx.lineWidth = strong ? 4 : 1.5;
    ctx.globalAlpha = strong ? 1 : 0.5;
    ctx.beginPath();
    ctx.moveTo(t.corners[0][0], t.corners[0][1]);
    for (let k = 1; k < 4; k++) ctx.lineTo(t.corners[k][0], t.corners[k][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = DEFAULT_SCHEME_HEX[t.face];
    ctx.font = 'bold 16px system-ui';
    const rot = rotations[t.face];
    ctx.fillText(`${t.face}${rot === undefined ? '?' : ''} ${t.conf.toFixed(2)}`, t.corners[0][0] + 6, t.corners[0][1] + 16);
  }
}

function updateFillUI(): void {
  const p = voter.progress();
  for (const f of FACE_ORDER) {
    const el = document.querySelector(`#fill-${f} span`)!;
    el.textContent = `${Math.round(p.faceFill[f] * 100)}%`;
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
    if (lastTick?.result?.heat && heatChk?.checked) drawHeatmap(ctx, lastTick.result.heat);
    if (lastTick && stageChk?.checked) drawStage1(ctx, lastTick.box?.box ?? null, lastTick.roi, lastTick.obj);
    frameNo++;
    const dt = lastTs ? ts - lastTs : 33;
    lastTs = ts;

    // Detector on a cadence, never overlapping inferences. Every tick is
    // stage 1 on the frame then stage 2 on its padded box; a stage-1 miss
    // hands the tracker an empty detection list (tracks decay exactly as
    // they do when stage 2 finds nothing) and the banner says no cube.
    if (detector && localizer && !inferBusy && frameNo % DETECT_EVERY === 0) {
      inferBusy = true;
      void (async () => {
        try {
          const tick = await detectTwoStage(localizer!, detector!, v);
          pendingDetections = tick.result?.faces ?? [];
          lastTick = tick;
          noCube = !tick.box;
          // A face edge can't exceed the cube's silhouette, so a silhouette
          // under the range floor (a fraction of the SOURCE frame height) is
          // too far, full stop - whatever stage 2 then says about it.
          cubeTooSmall = !!tick.box
            && Math.max(tick.box.box[2] - tick.box.box[0], tick.box.box[3] - tick.box.box[1])
               < minFaceEdgePx(v.videoHeight);
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
        detector?.observeCenter(t.face, cells.map((c) => c.lab), cells[4]!.rgb);
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
    if (detector?.anonymous) exemplarSwatches(swatchEl, detector.exemplars);
    updateFillUI();
    fallbackEl.style.display = ts - lastGoodDetectionTs > FALLBACK_AFTER_MS ? 'block' : 'none';
    fps.tick();
    statsEl.textContent = `fps ${fps.fps.toFixed(1)}   tracks ${tracks.length}   oriented ${Object.keys(rotations).length}   vetoed ${vetoedCount}`
      + (lastTick
        ? `   stage1 ${lastTick.locateMs.toFixed(1)}ms obj ${lastTick.obj.toFixed(2)}`
          + (lastTick.result
            ? `   stage2 ${lastTick.result.inferMs.toFixed(1)}ms quads ${lastTick.result.quads.length}   unnamed ${lastTick.result.unnamed.length}`
            : '   stage2 skipped')
        : '');
  }
  requestAnimationFrame((t) => void loop(t));
}

document.getElementById('start')!.addEventListener('click', () => {
  void (async () => {
    if (running) {
      running = false;
      camera.stop();
      document.getElementById('start')!.textContent = 'Start camera';
      return;
    }
    try {
      await camera.start();
      running = true;
      lastGoodDetectionTs = performance.now();
      document.getElementById('start')!.textContent = 'Stop camera';
      requestAnimationFrame((t) => void loop(t));
    } catch (err) {
      statusEl.textContent = String(err instanceof Error ? err.message : err);
    }
  })();
});

document.getElementById('reset')!.addEventListener('click', () => {
  voter.reset();
  tracker.reset();
  detector?.exemplars.reset();
  rotations = {};
  solved = false;
  lastTick = null;
  resultEl.textContent = '';
  hintEl.hidden = true;
});

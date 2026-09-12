// Any-order auto scanner (M6/M7 integration page).
//
// Pipeline per CLAUDE.md: camera -> detector (every 2nd frame) -> corner
// tracker (every frame) -> orientation from shared edges (carried across
// single-face frames by the track) -> homography rectify at native camera
// resolution -> 9-cell Lab sampling -> per-sticker voting -> lock on
// convergence + cubejs validation. The M1 grid scanner remains the fallback
// (M8): a banner offers it when detection stays weak.
//
// Standalone page on purpose - the trainer's Scan tab keeps the proven M1
// flow until this one has survived phone testing.

import { Camera } from './camera';
import { FpsCounter } from './debug/fps';
import { StickerVoter, type FaceObservation } from './assembly';
import { sampleGridCells } from './color';
import { FaceDetector } from './detect/facekp';
import { FaceTracker, type TrackedFace } from './detect/tracker';
import { resolveOrientations, orientQuad } from './detect/orient';
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
    button { background: #2a2f3a; color: inherit; border: 1px solid #3a4150; border-radius: 6px; padding: 8px 14px; font: inherit; }
    #bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
    #fill { display: flex; gap: 6px; margin: 8px 0; }
    .f { flex: 1; text-align: center; border-radius: 6px; padding: 4px 0; background: #1a1e26; border: 1px solid #3a4150; }
    .f b { display: block; }
    #result { background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-top: 10px; white-space: pre-wrap; word-break: break-all; }
    #fallback { display: none; background: #4a3320; border: 1px solid #8a6030; border-radius: 8px; padding: 8px 12px; margin-top: 8px; }
    #fallback a { color: #ffb454; }
    #stats { color: #8891a0; font-variant-numeric: tabular-nums; margin-top: 6px; }
  </style>
  <div id="wrap">
    <h1>Auto scan (M6/M7) — turn the cube slowly in view</h1>
    <div id="bar">
      <button id="start">Start camera</button>
      <button id="reset">Reset scan</button>
      <span id="status">model loading…</span>
    </div>
    <div id="stage"><canvas id="view"></canvas></div>
    <div id="fill">${FACE_ORDER.map((f) => `<div class="f" id="fill-${f}" style="color:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span>0%</span></div>`).join('')}</div>
    <div id="fallback">Having trouble? The <a href="scanner.html">grid scanner</a> always works.</div>
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

const camera = new Camera();
const fps = new FpsCounter();
const tracker = new FaceTracker();
const voter = new StickerVoter();
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

let detector: FaceDetector | null = null;
let running = false;
let frameNo = 0;
let inferBusy = false;
let pendingDetections: import('./detect/facekp').DetectedFace[] | null = null;
let lastTs = 0;
let rotations: Partial<Record<FaceId, number>> = {};
let lastGoodDetectionTs = 0;
let solved = false;
let vetoedCount = 0; // faces skipped by the seam veto (debug stat)

void FaceDetector.load('auto').then((d) => {
  detector = d;
  statusEl.textContent = d ? `model ready (${d.modelId}, ${d.ep})` : 'no model deployed — use the grid scanner';
  if (!d) fallbackEl.style.display = 'block';
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
    frameNo++;
    const dt = lastTs ? ts - lastTs : 33;
    lastTs = ts;

    // detector on a cadence, never overlapping inferences
    if (detector && !inferBusy && frameNo % DETECT_EVERY === 0) {
      inferBusy = true;
      void detector.detect(v).then((res) => {
        pendingDetections = res.faces;
        inferBusy = false;
      }).catch(() => { inferBusy = false; });
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
      for (const t of confident) {
        const k = rotations[t.face];
        if (k === undefined) continue; // can't index stickers without orientation
        let quad = orientQuad(t.corners, k);
        if (seamScore(frame, quad).score < SEAM_VETO_SCORE) { vetoedCount++; continue; }
        if (REFINE) quad = refineQuad(frame, quad).quad as [number, number][];
        const warped = warpQuad(frame, quad, 90);
        const cells = sampleGridCells(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 });
        observations.push({ face: t.face, cells: cells.map((c) => c.lab), conf: t.conf });
      }
      if (observations.length) voter.addFrame(observations);
    }

    drawOverlay(tracks);
    updateFillUI();
    fallbackEl.style.display = ts - lastGoodDetectionTs > FALLBACK_AFTER_MS ? 'block' : 'none';
    fps.tick();
    statsEl.textContent = `fps ${fps.fps.toFixed(1)}   tracks ${tracks.length}   oriented ${Object.keys(rotations).length}   vetoed ${vetoedCount}`;
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
  rotations = {};
  solved = false;
  resultEl.textContent = '';
});

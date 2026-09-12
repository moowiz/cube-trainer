// Standalone debug/benchmark page for the M4 keypoint detector.
//
// The M4 exit test says "runs in the browser on a phone at >=15 fps —
// measure, don't guess": this page IS the measurement. It shows the live
// camera with the model's face quads drawn on top, plus execution provider,
// inference time, and end-to-end fps.
import { Camera } from './camera';
import { FpsCounter } from './debug/fps';
import { FaceDetector, type DetectResult, type Ep } from './detect/facekp';
import { drawHeatmap, drawQuad, exemplarSwatches } from './debug/detect-overlay';
import { DEFAULT_SCHEME_HEX } from './types';

const app = document.getElementById('app')!;
app.innerHTML = `
  <style>
    body { margin: 0; background: #111318; color: #e8eaf0; font: 14px system-ui, sans-serif; }
    #wrap { max-width: 720px; margin: 0 auto; padding: 12px; }
    h1 { font-size: 18px; margin: 4px 0 10px; }
    #stage { position: relative; width: 100%; background: #000; border-radius: 8px; overflow: hidden; }
    #view { width: 100%; display: block; }
    #bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
    button, select { background: #2a2f3a; color: inherit; border: 1px solid #3a4150; border-radius: 6px; padding: 8px 14px; font: inherit; }
    button:disabled { opacity: 0.5; }
    #stats { font-variant-numeric: tabular-nums; white-space: pre-line; background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
    #msg { color: #ffb454; min-height: 1.2em; margin-top: 8px; }
    #swatches { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    #swatches .sw { width: 34px; height: 24px; border-radius: 4px; display: grid; place-items: center;
                    font: 11px system-ui; color: #0006; border: 1px solid #0004; }
    #swatches .sw.seed { opacity: 0.35; border-style: dashed; }
    label { display: flex; gap: 5px; align-items: center; }
    a { color: #7aa2ff; }
  </style>
  <div id="wrap">
    <h1>Face detector test (M4)</h1>
    <div id="bar">
      <button id="start">Start camera</button>
      <select id="ep">
        <option value="auto">EP: auto</option>
        <option value="webgpu">EP: webgpu</option>
        <option value="wasm">EP: wasm</option>
      </select>
      <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
      <label id="heatLbl" style="display:none"><input type="checkbox" id="heat" checked> heatmap</label>
      <span id="epUsed"></span>
    </div>
    <div id="stage"><canvas id="view"></canvas></div>
    <div id="swatches"></div>
    <div id="stats">model: loading…</div>
    <div id="msg"></div>
  </div>
`;

const view = document.getElementById('view') as HTMLCanvasElement;
const ctx = view.getContext('2d')!;
const stats = document.getElementById('stats')!;
const msg = document.getElementById('msg')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const epSel = document.getElementById('ep') as HTMLSelectElement;
const epUsed = document.getElementById('epUsed')!;
const heatChk = document.getElementById('heat') as HTMLInputElement;
const heatLbl = document.getElementById('heatLbl')!;
const swatchEl = document.getElementById('swatches')!;

const camera = new Camera();
const fps = new FpsCounter();
let detector: FaceDetector | null = null;
let running = false;
let inferEma = 0;
let lastLoadError = '';

// Loads are serialized: ort-web's wasm module is not reentrant across
// sessions, so a second load (EP switch, self-test) must wait for any
// in-flight load — including the ~1s 'auto' benchmark — to finish.
let loadChain: Promise<void> = Promise.resolve();
function loadDetector(): Promise<void> {
  loadChain = loadChain.then(() => doLoadDetector());
  return loadChain;
}

async function doLoadDetector(): Promise<void> {
  detector?.dispose();
  detector = null;
  epUsed.textContent = '';
  stats.textContent = 'model: loading…';
  try {
    const t0 = performance.now();
    detector = await FaceDetector.load(epSel.value as Ep | 'auto');
    if (!detector) {
      stats.textContent = 'model: not deployed (public/models/facekp.onnx missing)';
      msg.textContent = 'No model file — this build only has the grid scanner.';
      return;
    }
    const b = detector.benchMs;
    epUsed.textContent = b
      ? `${detector.modelId} · using ${detector.ep} (bench: ${(['webgpu', 'wasm'] as const)
          .filter((e) => b[e] !== undefined)
          .map((e) => `${e} ${b[e]!.toFixed(1)}ms`)
          .join(', ')})`
      : `${detector.modelId} · using ${detector.ep}`;
    heatLbl.style.display = detector.anonymous ? 'flex' : 'none';
    swatchEl.style.display = detector.anonymous ? 'flex' : 'none';
    stats.textContent = `model: ${detector.modelId}, ready in ${(performance.now() - t0).toFixed(0)} ms `
      + `(${detector.ep}${detector.anonymous ? ', anonymous quads' : ''})`;
  } catch (err) {
    stats.textContent = 'model: failed to load';
    lastLoadError = String(err instanceof Error ? err.message : err);
    msg.textContent = lastLoadError;
  }
}

async function loop(): Promise<void> {
  if (!running || !detector) return;
  const video = camera.video;
  if (video.videoWidth > 0) {
    if (view.width !== video.videoWidth) {
      view.width = video.videoWidth;
      view.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0);
    const res: DetectResult = await detector.detect(video);
    inferEma = inferEma === 0 ? res.inferMs : 0.1 * res.inferMs + 0.9 * inferEma;
    // Debug layering, back to front: heatmap, then the raw anonymous quads in
    // grey (what the model actually said), then the named ones in scheme
    // colors (what the app decided). Seeing all three at once is how a
    // naming bug is told apart from a detection bug.
    if (res.heat && heatChk.checked) drawHeatmap(ctx, res.heat);
    for (const u of res.unnamed) drawQuad(ctx, u.quad.corners, '#8b93a3', `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5);
    for (const f of res.faces) {
      drawQuad(ctx, f.corners, DEFAULT_SCHEME_HEX[f.face],
               `${f.face} ${f.conf.toFixed(2)}`, f.conf >= 0.5 ? 4 : 1.5);
    }
    if (detector.anonymous) exemplarSwatches(swatchEl, detector.exemplars);
    fps.tick();
    stats.textContent =
      `ep ${detector.ep}   input ${video.videoWidth}x${video.videoHeight}\n` +
      `inference ${inferEma.toFixed(1)} ms   end-to-end ${fps.fps.toFixed(1)} fps\n` +
      `faces: ${res.faces.map((f) => `${f.face} ${f.conf.toFixed(2)}`).join('  ') || '—'}` +
      (detector.anonymous
        ? `\nquads ${res.quads.length}   dropped: ${res.unnamed.map((u) => u.reason).join(', ') || '—'}`
        : '');
  }
  requestAnimationFrame(() => void loop());
}

startBtn.addEventListener('click', () => {
  void (async () => {
    if (running) {
      running = false;
      camera.stop();
      startBtn.textContent = 'Start camera';
      saveBtn.disabled = true;
      return;
    }
    msg.textContent = '';
    try {
      await camera.start();
      running = true;
      startBtn.textContent = 'Stop camera';
      saveBtn.disabled = false;
      void loop();
    } catch (err) {
      msg.textContent = String(err instanceof Error ? err.message : err);
    }
  })();
});

// Save the RAW camera frame (never the overlay canvas — painted quads would
// poison training data) for the M5 labeling loop: download on the phone,
// upload via the photo inbox, label, fine-tune.
saveBtn.addEventListener('click', () => {
  const video = camera.video;
  if (!running || video.videoWidth === 0) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d')!.drawImage(video, 0, 0);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `detect-frame-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msg.textContent = `saved ${a.download}`;
  }, 'image/png');
});

epSel.addEventListener('change', () => void loadDetector());

void loadDetector();

// Headless self-test hook (web/scripts/check-detect.mjs drives this in CI-ish
// checks): runs the detector N times on a synthetic frame, no camera needed.
(window as unknown as Record<string, unknown>).__detectSelfTest = async (iters = 30, ep?: string) => {
  if (ep) {
    epSel.value = ep;
    await loadDetector();
  }
  if (!detector) await loadDetector();
  if (!detector) return { ok: false, reason: lastLoadError || 'no model deployed' };
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 480;
  const g = c.getContext('2d')!;
  g.fillStyle = '#555';
  g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#c41e3a';
  g.fillRect(220, 140, 200, 200); // face-ish red square, content irrelevant
  await detector.detect(c); // warmup
  const t0 = performance.now();
  let last = null;
  for (let i = 0; i < iters; i++) last = await detector.detect(c);
  const ms = (performance.now() - t0) / iters;
  return { ok: true, ep: detector.ep, avgMs: ms, fps: 1000 / ms, faces: last!.faces.length,
           quads: last!.quads.length, anonymous: detector.anonymous, model: detector.modelId };
};

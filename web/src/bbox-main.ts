// Standalone debug page for the STAGE-1 cube localizer (CubeLocalizer /
// cubebox.onnx). Deliberately separate from detect.html (the stage-2
// face-keypoint page): the two stages have different models, different
// execution providers, and different failure modes, and mixing them in one
// page makes it hard to tell which stage is misbehaving. This page loads
// ONLY CubeLocalizer — the face keypoint model is never touched here.
import { Camera } from './camera';
import { FpsCounter } from './debug/fps';
import { CubeLocalizer, type CubeBox } from './detect/cubebox';

const app = document.getElementById('app')!;
app.innerHTML = `
  <style>
    body { margin: 0; background: #111318; color: #e8eaf0; font: 14px system-ui, sans-serif; }
    #wrap { max-width: 720px; margin: 0 auto; padding: 12px; }
    h1 { font-size: 18px; margin: 4px 0 10px; }
    h1 small { display: block; font-size: 12px; font-weight: 400; color: #8b93a3; margin-top: 2px; }
    #stage { position: relative; width: 100%; background: #000; border-radius: 8px; overflow: hidden; }
    #view { width: 100%; display: block; }
    #bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
    button { background: #2a2f3a; color: inherit; border: 1px solid #3a4150; border-radius: 6px; padding: 8px 14px; font: inherit; }
    button:disabled { opacity: 0.5; }
    #stats { font-variant-numeric: tabular-nums; white-space: pre-line; background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
    #msg { color: #ffb454; min-height: 1.2em; margin-top: 8px; }
    a { color: #7aa2ff; }
  </style>
  <div id="wrap">
    <h1>Cube localizer debug (stage 1)<small>Bounding-box + objectness net only — no face keypoints loaded on this page.</small></h1>
    <div id="bar">
      <button id="start">Start camera</button>
      <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
    </div>
    <div id="stage"><canvas id="view"></canvas></div>
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

const camera = new Camera();
const fps = new FpsCounter();
let localizer: CubeLocalizer | null = null;
let running = false;
let inferEma = 0;
let lastLoadError = '';

async function loadLocalizer(): Promise<void> {
  stats.textContent = 'model: loading…';
  try {
    localizer = await CubeLocalizer.load();
    if (!localizer) {
      stats.textContent = 'model: no cubebox model deployed (public/models/cubebox.onnx missing)';
      msg.textContent = 'Stage-1 localizer is not deployed on this build — the camera still works, just with no box.';
      return;
    }
    msg.textContent = '';
    stats.textContent = `model: ${localizer.modelId}, ready (wasm)`;
  } catch (err) {
    localizer = null;
    stats.textContent = 'model: failed to load';
    lastLoadError = String(err instanceof Error ? err.message : err);
    msg.textContent = lastLoadError;
  }
}

/** Draw the box and its objectness score directly on the overlay canvas (in-place on the frame, source pixels). */
function drawBox(box: CubeBox['box'], obj: number): void {
  const [x0, y0, x1, y1] = box;
  ctx.strokeStyle = '#5ee66b';
  ctx.lineWidth = 3;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  const label = `obj ${obj.toFixed(2)}`;
  ctx.font = '14px system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  const ly = Math.max(0, y0 - 20);
  ctx.fillStyle = '#5ee66b';
  ctx.fillRect(x0, ly, tw + 8, 20);
  ctx.fillStyle = '#111318';
  ctx.fillText(label, x0 + 4, ly + 14);
}

async function loop(): Promise<void> {
  if (!running) return;
  const video = camera.video;
  if (video.videoWidth > 0) {
    if (view.width !== video.videoWidth) {
      view.width = video.videoWidth;
      view.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0);

    if (!localizer) {
      // Degrade honestly: no model deployed — show the raw feed, say so, never a stale box.
      fps.tick();
      stats.textContent =
        `model: no cubebox model deployed\n` +
        `input ${video.videoWidth}x${video.videoHeight}   end-to-end ${fps.fps.toFixed(1)} fps\n` +
        `box: n/a (no model)`;
    } else {
      const t0 = performance.now();
      const result: CubeBox | null = await localizer.locate(video, video.videoWidth, video.videoHeight);
      const inferMs = performance.now() - t0;
      inferEma = inferEma === 0 ? inferMs : 0.1 * inferMs + 0.9 * inferEma;
      fps.tick();

      let boxLine: string;
      if (result) {
        drawBox(result.box, result.obj);
        const [x0, y0, x1, y1] = result.box;
        boxLine = `box [${x0.toFixed(0)}, ${y0.toFixed(0)}] – [${x1.toFixed(0)}, ${y1.toFixed(0)}]   obj ${result.obj.toFixed(2)}`;
      } else {
        boxLine = 'box: no cube found';
      }
      stats.textContent =
        `model ${localizer.modelId}   ep wasm\n` +
        `inference ${inferEma.toFixed(1)} ms   end-to-end ${fps.fps.toFixed(1)} fps\n` +
        boxLine;
    }
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

// Save the RAW camera frame (never the overlay canvas — a painted box would
// poison training data), same approach as detect-main.ts's save button.
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
    a.download = `bbox-frame-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msg.textContent = `saved ${a.download}`;
  }, 'image/png');
});

void loadLocalizer();

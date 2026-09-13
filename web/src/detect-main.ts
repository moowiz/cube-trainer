// Standalone debug/benchmark page for the two-stage detector (stage-1
// localizer -> stage-2 keypoints on its padded box, model/PORTRAIT-DESIGN.md).
//
// The M4 exit test says "runs in the browser on a phone at >=15 fps —
// measure, don't guess": this page IS the measurement. It shows the live
// camera with stage 1's box, the ROI stage 2 was given and the model's face
// quads drawn on top, plus execution provider, per-stage inference time, and
// end-to-end fps. bbox.html is the stage-1-only page.
import { Camera } from './camera';
import { FpsCounter } from './debug/fps';
import { FaceDetector, type DetectResult, type Ep } from './detect/facekp';
import { CubeLocalizer } from './detect/cubebox';
import { detectTwoStage, type TwoStageResult } from './detect/twostage';
import { drawHeatmap, drawQuad, drawStage1, exemplarSwatches } from './debug/detect-overlay';
import { TOO_SMALL_REASON } from './detect/identify';
import { DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from './types';
import type { FaceId, Lab } from './types';
import { labDistance } from './color';

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
    #cells { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
    #cells .face { background: #1a1e26; border-radius: 8px; padding: 8px 10px; }
    #cells .hd { font: 11px ui-monospace, monospace; color: #8b93a6; margin-bottom: 6px; white-space: pre-line; }
    #cells .g { display: grid; grid-template-columns: repeat(3, 52px); grid-auto-rows: 52px; gap: 3px; }
    #cells .c { border-radius: 4px; display: flex; flex-direction: column; align-items: center;
                justify-content: center; font: 10px/1.15 ui-monospace, monospace; border: 1px solid #0005; }
    #cells .c.mid { outline: 2px solid #e8eaf0; outline-offset: 1px; }
    #cells .c b { font-size: 10px; font-weight: 600; }
  </style>
  <div id="wrap">
    <h1>Two-stage detector test (M4)</h1>
    <div id="bar">
      <button id="start">Start camera</button>
      <select id="ep">
        <option value="auto">EP: auto</option>
        <option value="webgpu">EP: webgpu</option>
        <option value="wasm">EP: wasm</option>
      </select>
      <button id="save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
      <label id="heatLbl" style="display:none"><input type="checkbox" id="heat"> heatmap</label>
      <label id="cellsLbl" style="display:none"><input type="checkbox" id="cellsChk"> per-sticker readout</label>
      <button id="capture" disabled title="Download this frame's naming evidence as JSON, plus the raw frame">Capture debug</button>
      <span id="epUsed"></span>
    </div>
    <div id="stage"><canvas id="view"></canvas></div>
    <div id="swatches"></div>
    <div id="cells"></div>
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
const captureBtn = document.getElementById('capture') as HTMLButtonElement;
const cellsChk = document.getElementById('cellsChk') as HTMLInputElement;
const cellsLbl = document.getElementById('cellsLbl')!;
const cellsEl = document.getElementById('cells')!;
const epSel = document.getElementById('ep') as HTMLSelectElement;
const epUsed = document.getElementById('epUsed')!;
const heatChk = document.getElementById('heat') as HTMLInputElement;
const heatLbl = document.getElementById('heatLbl')!;
const swatchEl = document.getElementById('swatches')!;

const camera = new Camera();
const fps = new FpsCounter();
let detector: FaceDetector | null = null;
let localizer: CubeLocalizer | null = null;
let running = false;
let inferEma = 0;
let locateEma = 0;
let lastLoadError = '';
let stage1Misses = 0;
let ticks = 0;

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
    const d = await FaceDetector.load(epSel.value as Ep | 'auto');
    if (!d) {
      stats.textContent = 'model: not deployed (public/models/facekp.onnx missing)';
      msg.textContent = 'No model file — this build only has the grid scanner.';
      return;
    }
    // Always two-stage: no localizer or no crop stamp = no detection path.
    localizer ??= await CubeLocalizer.load();
    if (!localizer) {
      stats.textContent = 'model: stage-1 localizer not deployed (public/models/cubebox.onnx missing)';
      msg.textContent = 'No cubebox model — no two-stage path; this build only has the grid scanner.';
      d.dispose();
      return;
    }
    if (!d.cropTrained) {
      stats.textContent = `model: ${d.modelId} is not crop-trained`;
      msg.textContent = 'facekp.json has no cropTrained stamp — the app only runs stage 2 on crops. Re-export.';
      d.dispose();
      return;
    }
    detector = d;
    const b = detector.benchMs;
    epUsed.textContent = b
      ? `${detector.modelId} · using ${detector.ep} (bench: ${(['webgpu', 'wasm'] as const)
          .filter((e) => b[e] !== undefined)
          .map((e) => `${e} ${b[e]!.toFixed(1)}ms`)
          .join(', ')})`
      : `${detector.modelId} · using ${detector.ep}`;
    heatLbl.style.display = detector.anonymous ? 'flex' : 'none';
    cellsLbl.style.display = detector.anonymous ? 'flex' : 'none';
    swatchEl.style.display = detector.anonymous ? 'flex' : 'none';
    stats.textContent = `model: ${localizer.modelId} → ${detector.modelId}, ready in ${(performance.now() - t0).toFixed(0)} ms `
      + `(${detector.ep}${detector.anonymous ? ', anonymous quads' : ''})`;
  } catch (err) {
    stats.textContent = 'model: failed to load';
    lastLoadError = String(err instanceof Error ? err.message : err);
    msg.textContent = lastLoadError;
  }
}

// The per-sticker readout and the capture file are both built from
// `res.named`, which is what nameQuads actually decided from - the same cell
// samples and the same exemplar ranking. Nothing here re-derives a colour
// decision; the one derived value is each cell's nearest exemplar, which
// naming never computes because only the centre names a face, and it is
// computed with the app's own labDistance against the app's own live
// exemplars so it cannot drift from what the centre decision would say.
let lastNamed: DetectResult | null = null;

function cellPick(lab: Lab): { face: FaceId; d: number; second: number } {
  const ranked = FACE_ORDER
    .map((f) => ({ f, d: labDistance(lab, detector!.exemplars.get(f)) }))
    .sort((a, b) => a.d - b.d);
  return { face: ranked[0]!.f, d: ranked[0]!.d, second: ranked[1]!.d };
}

function renderCells(res: DetectResult): void {
  if (!cellsChk.checked || !res.named) { cellsEl.textContent = ''; return; }
  cellsEl.textContent = '';
  res.named.forEach((n, i) => {
    if (!n.cellsNorm || !n.cellRgb) return;
    const box = document.createElement('div');
    box.className = 'face';
    const hd = document.createElement('div');
    hd.className = 'hd';
    const best = n.ranked?.[0];
    hd.textContent =
      `quad ${i} · ${res.quads[i] ? res.quads[i]!.conf.toFixed(2) : '?'} · ${n.reason}
` +
      (best ? `centre ${n.color ?? '—'} d ${best.d.toFixed(1)} · conf ${n.nameConf.toFixed(2)}` : 'not named');
    const g = document.createElement('div');
    g.className = 'g';
    n.cellsNorm.forEach((lab, k) => {
      const p = cellPick(lab);
      const rgb = n.cellRgb![k]!;
      const c = document.createElement('div');
      c.className = 'c' + (k === 4 ? ' mid' : '');
      c.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      c.style.color = p.d > 35 ? '#fff' : '#000';
      c.innerHTML = `<b>${DEFAULT_SCHEME_NAMES[p.face].slice(0, 3)}</b><span>${p.d.toFixed(0)}</span>`;
      g.append(c);
    });
    box.append(hd, g);
    cellsEl.append(box);
  });
}

/** Everything the naming layer saw this frame, as a plain object. */
function debugSnapshot(res: DetectResult, video: HTMLVideoElement): unknown {
  return {
    captured: new Date().toISOString(),
    model: detector!.modelId,
    ep: detector!.ep,
    input: { w: video.videoWidth, h: video.videoHeight },
    inferMs: res.inferMs,
    totalMs: res.totalMs,
    exemplars: FACE_ORDER.map((f) => ({
      face: f, color: DEFAULT_SCHEME_NAMES[f],
      measured: detector!.exemplars.isMeasured(f),
      lab: detector!.exemplars.get(f),
    })),
    quads: res.quads.map((q, i) => {
      const n = res.named?.[i];
      return {
        i,
        conf: q.conf,
        cornersSourcePx: q.corners,
        named: n && {
          face: n.face, color: n.color, reason: n.reason, nameConf: n.nameConf,
          centreNorm: n.center, centreRgb: n.rgb,
          ranked: n.ranked,
          cells: n.cellsNorm?.map((lab, k) => ({
            k,
            rgb: n.cellRgb?.[k],
            lab: n.cells?.[k],
            labNorm: lab,
            nearest: cellPick(lab),
          })),
        },
      };
    }),
  };
}

async function loop(): Promise<void> {
  if (!running || !detector || !localizer) return;
  const video = camera.video;
  if (video.videoWidth > 0) {
    if (view.width !== video.videoWidth) {
      view.width = video.videoWidth;
      view.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0);
    const tick: TwoStageResult = await detectTwoStage(localizer, detector, video);
    ticks++;
    locateEma = locateEma === 0 ? tick.locateMs : 0.1 * tick.locateMs + 0.9 * locateEma;
    // Debug layering, back to front: stage 1's box and ROI, heatmap, then the
    // raw anonymous quads in grey (what the model actually said), then the
    // named ones in scheme colors (what the app decided). Seeing them all at
    // once is how a naming bug is told apart from a detection bug, and a
    // stage-1 miss from a stage-2 one.
    drawStage1(ctx, tick.box?.box ?? null, tick.roi, tick.obj);
    if (!tick.result) {
      stage1Misses++;
      fps.tick();
      stats.textContent =
        `ep ${detector.ep}   input ${video.videoWidth}x${video.videoHeight}\n` +
        `stage 1 ${locateEma.toFixed(1)} ms (no cube, obj ${tick.obj.toFixed(2)}; misses ${stage1Misses}/${ticks})   ` +
        `stage 2 ${inferEma.toFixed(1)} ms   end-to-end ${fps.fps.toFixed(1)} fps\nfaces: —`;
      requestAnimationFrame(() => void loop());
      return;
    }
    const res: DetectResult = tick.result;
    inferEma = inferEma === 0 ? res.inferMs : 0.1 * res.inferMs + 0.9 * inferEma;
    if (res.heat && heatChk.checked) drawHeatmap(ctx, res.heat);
    for (const u of res.unnamed) {
      // A face refused for size is a different event from one the namer tried
      // and failed on: the model found it, and the app declined to guess at a
      // scale where its own corner error is a large fraction of a sticker.
      // Dashed amber says "seen, deliberately skipped"; solid grey says
      // "tried, could not name".
      const tooSmall = u.reason.startsWith(TOO_SMALL_REASON);
      drawQuad(ctx, u.quad.corners, tooSmall ? '#d98a1f' : '#8b93a3',
               `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5, tooSmall);
    }
    for (const f of res.faces) {
      // Colour word leads — that's what the user is looking for on the cube,
      // not the cubejs letter, which asserts an orientation the app has not
      // established yet (CLAUDE.md: the letter is internal-only notation).
      drawQuad(ctx, f.corners, DEFAULT_SCHEME_HEX[f.face],
               `${DEFAULT_SCHEME_NAMES[f.face]} ${f.conf.toFixed(2)}`, f.conf >= 0.5 ? 4 : 1.5);
    }
    if (detector.anonymous) exemplarSwatches(swatchEl, detector.exemplars);
    lastNamed = res;
    renderCells(res);
    fps.tick();
    stats.textContent =
      `ep ${detector.ep}   input ${video.videoWidth}x${video.videoHeight}\n` +
      `stage 1 ${locateEma.toFixed(1)} ms (obj ${tick.obj.toFixed(2)}; misses ${stage1Misses}/${ticks})   ` +
      `stage 2 ${inferEma.toFixed(1)} ms   end-to-end ${fps.fps.toFixed(1)} fps\n` +
      // Debug line: colour word leads, cubejs letter shown small/secondary in
      // parens for correlating against state.ts's facelet string.
      `faces: ${res.faces.map((f) => `${DEFAULT_SCHEME_NAMES[f.face]} (${f.face}) ${f.conf.toFixed(2)}`).join('  ') || '—'}` +
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
      captureBtn.disabled = true;
      return;
    }
    msg.textContent = '';
    try {
      await camera.start();
      running = true;
      startBtn.textContent = 'Stop camera';
      saveBtn.disabled = false;
      captureBtn.disabled = false;
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

// Capture: the JSON and the RAW frame at the same instant, under the same
// timestamp, so the numbers can be replayed against the pixels that produced
// them. Two files rather than one because the frame must stay a clean PNG -
// the same rule as Save frame, no overlay ever written to a training image.
captureBtn.addEventListener('click', () => {
  if (!lastNamed || !detector) return;
  const video = camera.video;
  const stamp = Date.now();
  const dl = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  dl(new Blob([JSON.stringify(debugSnapshot(lastNamed, video), null, 1)], { type: 'application/json' }),
     `detect-debug-${stamp}.json`);
  if (video.videoWidth > 0) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    c.toBlob((b) => b && dl(b, `detect-debug-${stamp}.png`), 'image/png');
  }
  msg.textContent = `captured detect-debug-${stamp}.{json,png}`;
});

cellsChk.addEventListener('change', () => {
  if (!cellsChk.checked) cellsEl.textContent = '';
});

epSel.addEventListener('change', () => void loadDetector());

void loadDetector();

// Headless self-test hook (web/scripts/check-detect.mjs drives this in CI-ish
// checks): runs the detector N times on a synthetic frame, no camera needed.
(window as unknown as Record<string, unknown>).__detectSelfTest = async (iters = 30, ep?: string, imgUrl?: string) => {
  if (ep) {
    epSel.value = ep;
    await loadDetector();
  }
  if (!detector) await loadDetector();
  if (!detector || !localizer) return { ok: false, reason: lastLoadError || msg.textContent || 'no model deployed' };
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  if (imgUrl) {
    // A real frame, so the check can compare what each EP actually decodes.
    // The synthetic rectangle below produces zero detections on every EP,
    // which is correct behaviour and therefore blind to a broken EP.
    const img = new Image();
    img.src = imgUrl;
    await img.decode();
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    g.drawImage(img, 0, 0);
  } else {
    c.width = 640;
    c.height = 480;
    g.fillStyle = '#555';
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#c41e3a';
    g.fillRect(220, 140, 200, 200); // face-ish red square, content irrelevant
  }
  // Two-stage like the app. On the synthetic square stage 1 will usually
  // miss, which is a correct answer; a real frame (imgUrl) exercises stage 2.
  await detectTwoStage(localizer, detector, c); // warmup
  const t0 = performance.now();
  let last: TwoStageResult | null = null;
  for (let i = 0; i < iters; i++) last = await detectTwoStage(localizer, detector, c);
  const ms = (performance.now() - t0) / iters;
  const r = last!.result;
  return { ok: true, ep: detector.ep, avgMs: ms, fps: 1000 / ms,
           stage1: { obj: +last!.obj.toFixed(3), box: last!.box?.box.map((v) => Math.round(v)) ?? null },
           faces: r?.faces.length ?? 0, quads: r?.quads.length ?? 0,
           anonymous: detector.anonymous, model: `${localizer.modelId} -> ${detector.modelId}`,
           // enough to tell "this EP decoded nothing" from "this EP decoded
           // something different" without eyeballing an overlay
           scores: r?.quads.map((q) => +q.conf.toFixed(3)) ?? [],
           names: r?.faces.map((f) => f.face) ?? [],
           corner0: r?.quads[0]?.corners.map((c) => c.map((v) => Math.round(v))) };
};

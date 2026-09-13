// Grid-overlay scanner (milestone M1): fixed 3x3 grid over the camera feed,
// scan the six faces in U R F D L B order, classify in Lab via k-means seeded
// from the face centers, validate with cubejs, show the solution.
// Mounted by scan.html (grid mode) and by the trainer's Scan tab.

import './scanner.css';
import { Camera } from '../camera';
import { FpsCounter } from '../debug/fps';
import {
  rgbCss,
  sampleGridCells,
  sampleSurroundPatches,
  isFaceTooDark,
  labDistance,
  labMean,
  maxPairwiseLabDistance,
  type Rect,
} from '../color';
import type { CellSample, FaceId } from '../types';
import { FACE_ORDER, DEFAULT_SCHEME_HEX } from '../types';
import {
  CENTER_MIN_DIST,
  FaceStabilizer,
  assembleState,
  normalizeFaceCells,
  validateState,
  solveState,
  warmSolver,
  inverseMoves,
  type AssembledState,
  type FaceCapture,
} from '../state';

export interface ScannerOptions {
  /** When set, a "Practice in trainer" button appears after a successful scan
   *  and is called with a scramble that reproduces the scanned state. */
  onUseInTrainer?: (scramble: string) => void;
}

export interface ScannerHandle {
  /** Start (or resume) the camera + scan loop. Safe to call repeatedly. */
  start(): void;
  /** Stop the camera and the loop (e.g. when the tab is hidden). */
  stop(): void;
}

// Scan prompts, in FACE_ORDER (U R F D L B). Color names are the default
// scheme and are hints only — centers define the real scheme.
const PROMPTS: Record<FaceId, string> = {
  U: 'Point the <b>top (white)</b> center at the camera, green center toward the floor.',
  R: 'Show the <b>right (red)</b> face — white center on top.',
  F: 'Show the <b>front (green)</b> face — white center on top.',
  D: 'Point the <b>bottom (yellow)</b> center at the camera, green center toward the ceiling.',
  L: 'Show the <b>left (orange)</b> face — white center on top.',
  B: 'Show the <b>back (blue)</b> face — white center on top.',
};

// DECISION: grid square is 55% of the smaller video dimension; sample patches
// are 12px at 640x480 (per CLAUDE.md). The duplicate-face guard compares
// centers in the SAME exposure-normalized space assembleState clusters in,
// using the same CENTER_MIN_DIST threshold — with a raw-Lab guard, two
// centers can pass here (absolute L differs) and still be rejected at
// assembly, surfacing the error only after all six faces (fixture
// cube-scan-1789101879130: white read dark-bluish, blue read near-black;
// raw distance 16.5, normalized 6.3).
const GRID_FRACTION = 0.55;
const PATCH_SIZE = 12;
const LOW_CONFIDENCE = 0.35;
// DECISION: background rejection. A capture whose 9 cells are near-uniform
// (max pairwise Lab distance < 15) is only accepted when the surroundings of
// the grid look different from the face (otherwise we're staring at a
// ceiling/wall/desk, not a cube). "Different" = at least half the surround
// patches are >= 16 Lab away from the face's mean color. A solved,
// single-color face still passes as long as the cube is held against any
// contrasting background. Multi-colored (scrambled) faces skip the check.
const UNIFORM_FACE_SPREAD = 15;
const BG_SIMILAR_DIST = 16;

export function mountScanner(root: HTMLElement, opts: ScannerOptions = {}): ScannerHandle {
  root.innerHTML = `
    <div class="cscan">
      <h1>Cube scanner</h1>
      <p class="cs-sub">Hold each face flat to the camera inside the grid. A face locks
        automatically once the reading is steady.</p>
      <div class="cs-stage">
        <canvas width="640" height="480"></canvas>
        <span class="cs-fps" hidden></span>
        <div class="cs-start">
          <button class="cs-btn cs-primary" type="button">Enable camera</button>
          <p></p>
        </div>
      </div>
      <p class="cs-prompt"></p>
      <p class="cs-hint"></p>
      <div class="cs-faces"></div>
      <div class="cs-controls">
        <button class="cs-btn" type="button" data-a="redo" hidden>Redo last face</button>
        <button class="cs-btn" type="button" data-a="restart" hidden>Restart scan</button>
        <button class="cs-btn" type="button" data-a="saveframe" hidden>Save debug frame</button>
      </div>
      <div class="cs-review" hidden>
        <p class="cs-sub">Tap any sticker to correct it (the ringed ones are low-confidence reads).</p>
        <div class="cs-net"></div>
        <p class="cs-valid"></p>
        <div class="cs-solution" hidden>
          <h2>Solution</h2>
          <div class="cs-moves"></div>
          <p>Hold the cube as scanned: U center up, F center facing you.</p>
        </div>
        <div class="cs-controls">
          <button class="cs-btn cs-primary" type="button" data-a="trainer" hidden>Practice in trainer</button>
          <button class="cs-btn" type="button" data-a="copystate">Copy state</button>
          <button class="cs-btn" type="button" data-a="copysol" hidden>Copy solution</button>
          <button class="cs-btn" type="button" data-a="savescan">Save scan report</button>
          <button class="cs-btn" type="button" data-a="rescan">Scan again</button>
        </div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stageEl = $('.cs-stage') as HTMLDivElement;
  const canvas = $('canvas') as unknown as HTMLCanvasElement;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const fpsEl = $('.cs-fps');
  const startOverlay = $('.cs-start') as HTMLDivElement;
  const startBtn = startOverlay.querySelector('button')!;
  const startMsg = startOverlay.querySelector('p')!;
  const promptEl = $('.cs-prompt');
  const hintEl = $('.cs-hint');
  const facesEl = $('.cs-faces');
  const redoBtn = $('[data-a="redo"]') as HTMLButtonElement;
  const restartBtn = $('[data-a="restart"]') as HTMLButtonElement;
  const reviewEl = $('.cs-review') as HTMLDivElement;
  const netEl = $('.cs-net');
  const validEl = $('.cs-valid');
  const solutionBox = $('.cs-solution') as HTMLDivElement;
  const movesEl = $('.cs-moves');
  const trainerBtn = $('[data-a="trainer"]') as HTMLButtonElement;
  const copyStateBtn = $('[data-a="copystate"]') as HTMLButtonElement;
  const copySolBtn = $('[data-a="copysol"]') as HTMLButtonElement;
  const rescanBtn = $('[data-a="rescan"]') as HTMLButtonElement;
  const saveFrameBtn = $('[data-a="saveframe"]') as HTMLButtonElement;
  const saveScanBtn = $('[data-a="savescan"]') as HTMLButtonElement;

  const camera = new Camera();
  const fps = new FpsCounter();

  type Phase = 'idle' | 'scanning' | 'review';
  let phase: Phase = 'idle';
  let raf = 0;
  let faceIdx = 0;
  let stabilizer = new FaceStabilizer();
  /** Lab cells per captured face (for state.ts). */
  let captures: FaceCapture[] = [];
  /** Display rgb per captured face (last sampled frame at capture time). */
  let captureRgb: string[][] = [];
  /** Center display color per face id, filled as faces are captured. */
  const centerCss: Partial<Record<FaceId, string>> = {};
  /** After a capture (or duplicate warning), wait for the scene to move before
   *  accepting stability again — otherwise the same face locks in twice. */
  let needMotion = false;
  let duplicateStrikes = 0;
  // review state
  let letters: FaceId[] = [];
  let confidences: number[] = [];
  let badStickers: number[] = [];
  let solveToken = 0;
  /** The k-means result as assembled, before any tap-to-fix edits. */
  let assembled: AssembledState | null = null;

  // ---------- face progress strip ----------

  function renderFaces(): void {
    facesEl.innerHTML = '';
    FACE_ORDER.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'cs-facechip' + (phase === 'scanning' && i === faceIdx ? ' cur' : '');
      const mini = document.createElement('div');
      mini.className = 'cs-mini';
      for (let c = 0; c < 9; c++) {
        const cell = document.createElement('i');
        const rgb = captureRgb[i]?.[c];
        if (rgb) cell.style.background = rgb;
        mini.appendChild(cell);
      }
      const label = document.createElement('span');
      label.textContent = f;
      chip.append(mini, label);
      facesEl.appendChild(chip);
    });
  }

  function setPrompt(): void {
    if (phase !== 'scanning') {
      promptEl.innerHTML = '';
      return;
    }
    const face = FACE_ORDER[faceIdx]!;
    promptEl.innerHTML = `Face ${faceIdx + 1} of 6 — <b>${face}</b>. ${PROMPTS[face]}`;
  }

  function setHint(text: string, warn = false): void {
    hintEl.textContent = text;
    hintEl.classList.toggle('warn', warn);
  }

  // ---------- scan loop ----------

  function gridRectFor(w: number, h: number): Rect {
    const side = Math.round(Math.min(w, h) * GRID_FRACTION);
    return {
      x: Math.round((w - side) / 2),
      y: Math.round((h - side) / 2),
      w: side,
      h: side,
    };
  }

  function gridRect(): Rect {
    return gridRectFor(canvas.width, canvas.height);
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    fps.tick(now);
    fpsEl.textContent = `${fps.fps.toFixed(0)} fps`;

    const video = camera.video;
    if (!camera.running || video.videoWidth === 0) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (phase !== 'scanning') return;

    const rect = gridRect();
    const img = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    // No plan passed: this rect is in source pixels, so sampleGridCells sizes
    // the patches from the grid's own cell size.
    const cells = sampleGridCells(img, { x: 0, y: 0, w: rect.w, h: rect.h });
    const { stable, progress, moved } = stabilizer.push(cells.map((c) => c.lab), now);

    if (needMotion) {
      // Rearm only once the scene actually changes (the user turned the cube);
      // otherwise a face left in view would immediately lock into the next slot.
      if (moved) needMotion = false;
      drawOverlay(rect, cells, needMotion ? 0 : progress);
      return;
    }

    drawOverlay(rect, cells, progress);
    if (stable) onFaceStable(cells);
  }

  function drawOverlay(rect: Rect, cells: CellSample[], progress: number): void {
    const { x, y, w, h } = rect;
    // dim everything outside the grid
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (i * w) / 3, y);
      ctx.lineTo(x + (i * w) / 3, y + h);
      ctx.moveTo(x, y + (i * h) / 3);
      ctx.lineTo(x + w, y + (i * h) / 3);
      ctx.stroke();
    }
    // sampled colors, mirrored back as little swatches at each cell center
    for (let i = 0; i < cells.length; i++) {
      const cx = x + ((i % 3) + 0.5) * (w / 3);
      const cy = y + (Math.floor(i / 3) + 0.5) * (h / 3);
      ctx.fillStyle = rgbCss(cells[i]!.rgb);
      ctx.fillRect(cx - 9, cy - 9, 18, 18);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - 9.5, cy - 9.5, 19, 19);
    }
    // stability progress bar just under the grid
    const by = Math.min(y + h + 10, canvas.height - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, by, w, 6);
    ctx.fillStyle = '#33B15D';
    ctx.fillRect(x, by, w * progress, 6);
  }

  function onFaceStable(lastCells: CellSample[]): void {
    const face = FACE_ORDER[faceIdx]!;
    const cells = stabilizer.result();

    // Darkness guard: an underexposed face is unclassifiable — refuse it now
    // rather than failing at assembly with all six faces garbage (see
    // fixture cube-scan-1789100642010.json).
    if (isFaceTooDark(cells)) {
      needMotion = true;
      stabilizer.reset();
      setHint('Too dark to read the colors — add light or move toward a lamp, then show the face again.', true);
      return;
    }

    // Background guard: a near-uniform reading that blends into the grid's
    // surroundings is not a cube face. Reject and wait for the scene to move.
    if (maxPairwiseLabDistance(cells) < UNIFORM_FACE_SPREAD) {
      const frame = camera.grabFrame();
      if (frame) {
        const surround = sampleSurroundPatches(frame, gridRectFor(frame.width, frame.height), PATCH_SIZE);
        const faceMean = labMean(cells);
        const similar = surround.filter((s) => labDistance(s.lab, faceMean) < BG_SIMILAR_DIST).length;
        if (surround.length > 0 && similar >= surround.length / 2) {
          needMotion = true;
          stabilizer.reset();
          setHint("That looks like the background, not a cube — hold the cube's " + face + ' face inside the grid.', true);
          return;
        }
      }
    }

    // Duplicate guard: a new face's center color must differ from every face
    // captured so far, measured in the normalized space assembly will use.
    // Warn once; accept on the second consecutive stable read (so a genuinely
    // close pair, e.g. red/orange in bad light, can't wedge).
    const normCenter = normalizeFaceCells(cells)[4]!;
    const dup = captures.find(
      (c) => labDistance(normalizeFaceCells(c.cells)[4]!, normCenter) < CENTER_MIN_DIST,
    );
    if (dup && duplicateStrikes === 0) {
      duplicateStrikes = 1;
      needMotion = true;
      stabilizer.reset();
      setHint(`That looks like the ${dup.face} face you already scanned — turn the cube to show ${face}. (Hold it again to override.)`, true);
      return;
    }
    duplicateStrikes = 0;

    captures.push({ face, cells });
    captureRgb.push(lastCells.map((c) => rgbCss(c.rgb)));
    centerCss[face] = rgbCss(lastCells[4]!.rgb);
    stabilizer.reset();
    needMotion = true;
    setHint('');
    stageEl.classList.remove('flash');
    void stageEl.offsetWidth; // restart the css animation
    stageEl.classList.add('flash');

    if (captures.length === 6) {
      enterReview();
    } else {
      faceIdx++;
      setPrompt();
      renderFaces();
    }
  }

  // ---------- review ----------

  function enterReview(): void {
    phase = 'review';
    setPrompt();
    renderFaces();
    redoBtn.hidden = true;
    restartBtn.hidden = true;
    saveFrameBtn.hidden = true;
    reviewEl.hidden = false;
    camera.stop(); // save battery while reviewing
    cancelAnimationFrame(raf);
    raf = 0;
    fpsEl.hidden = true;

    try {
      assembled = assembleState(captures);
      letters = [...assembled.stickerFaces];
      confidences = [...assembled.confidences];
    } catch (e) {
      assembled = null;
      netEl.innerHTML = '';
      validEl.className = 'cs-valid err';
      validEl.textContent = e instanceof Error ? e.message : String(e);
      solutionBox.hidden = true;
      return;
    }
    renderNet();
    revalidate();
  }

  function displayColor(f: FaceId): string {
    return centerCss[f] ?? DEFAULT_SCHEME_HEX[f];
  }

  function renderNet(): void {
    netEl.innerHTML = '';
    FACE_ORDER.forEach((f, fi) => {
      const faceDiv = document.createElement('div');
      faceDiv.className = 'cs-face';
      faceDiv.dataset.f = f;
      for (let c = 0; c < 9; c++) {
        const idx = fi * 9 + c;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cs-st';
        if (c === 4) b.classList.add('center');
        if (c !== 4 && (confidences[idx] ?? 1) < LOW_CONFIDENCE) b.classList.add('lowconf');
        if (badStickers.includes(idx)) b.classList.add('bad');
        b.style.background = displayColor(letters[idx]!);
        b.title = `${f}${c + 1}: ${letters[idx]}`;
        if (c !== 4) {
          b.addEventListener('click', () => {
            letters[idx] = FACE_ORDER[(FACE_ORDER.indexOf(letters[idx]!) + 1) % 6]!;
            confidences[idx] = 1; // the user said so
            revalidate();
            renderNet();
          });
        }
        faceDiv.appendChild(b);
      }
      netEl.appendChild(faceDiv);
    });
  }

  function facelets(): string {
    return letters.join('');
  }

  function revalidate(): void {
    const token = ++solveToken;
    const res = validateState(facelets());
    badStickers = res.badStickers ?? [];
    solutionBox.hidden = true;
    copySolBtn.hidden = true;
    trainerBtn.hidden = true;
    if (!res.ok) {
      validEl.className = 'cs-valid err';
      validEl.textContent = res.error ?? 'Not a valid cube state.';
      renderNetBadOnly();
      return;
    }
    validEl.className = 'cs-valid ok';
    validEl.textContent = 'Valid cube state ✓ — solving…';
    renderNetBadOnly();
    solveState(facelets())
      .then((sol) => {
        if (token !== solveToken) return; // user edited meanwhile
        validEl.textContent = 'Valid cube state ✓';
        movesEl.textContent = sol.trim() === '' ? 'Already solved!' : sol;
        solutionBox.hidden = false;
        copySolBtn.hidden = sol.trim() === '';
        trainerBtn.hidden = !opts.onUseInTrainer || sol.trim() === '';
        trainerBtn.onclick = () => opts.onUseInTrainer!(inverseMoves(sol));
        copySolBtn.onclick = () => void navigator.clipboard?.writeText(sol);
      })
      .catch((e) => {
        if (token !== solveToken) return;
        validEl.className = 'cs-valid err';
        validEl.textContent = `Solver error: ${e instanceof Error ? e.message : e}`;
      });
  }

  /** Refresh only the bad/ok rings without rebuilding (cheap path). */
  function renderNetBadOnly(): void {
    const buttons = netEl.querySelectorAll<HTMLButtonElement>('.cs-st');
    buttons.forEach((b, idx) => b.classList.toggle('bad', badStickers.includes(idx)));
  }

  // ---------- debug fixtures (milestone M2) ----------
  // Both buttons download a JSON file meant for web/test/fixtures/: enough to
  // reproduce a color misread in a unit test without a camera.

  function download(filename: string, text: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** Clean current frame (no overlay) + its grid samples, as a fixture. */
  function saveDebugFrame(): void {
    const img = camera.grabFrame();
    if (!img) {
      setHint('No camera frame to save yet.', true);
      return;
    }
    const rect = gridRectFor(img.width, img.height);
    const cells = sampleGridCells(img, rect);
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    const fixture = {
      type: 'frame',
      version: 1,
      savedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      targetFace: FACE_ORDER[faceIdx],
      faceIdx,
      gridRect: rect,
      patchSize: PATCH_SIZE,
      cells,
      capturedSoFar: captures.map((cap, i) => ({ face: cap.face, cells: cap.cells, rgb: captureRgb[i] })),
      imagePng: c.toDataURL('image/png'),
    };
    download(`cube-frame-${fixture.targetFace}-${Date.now()}.json`, JSON.stringify(fixture, null, 1));
    setHint('Debug frame saved to your downloads.');
  }

  /** Everything the classifier saw and decided for a completed scan. */
  function saveScanReport(): void {
    const report = {
      type: 'scan',
      version: 1,
      savedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      captures: captures.map((cap, i) => ({ face: cap.face, cells: cap.cells, rgb: captureRgb[i] })),
      autoLetters: assembled ? assembled.stickerFaces.join('') : null,
      centroids: assembled?.centroids ?? null,
      confidences: assembled ? assembled.confidences : null,
      assembleError: assembled ? null : validEl.textContent,
      lettersAfterFixes: letters.length ? letters.join('') : null,
      validation: letters.length ? validateState(letters.join('')) : null,
    };
    download(`cube-scan-${Date.now()}.json`, JSON.stringify(report, null, 1));
  }

  // ---------- lifecycle ----------

  function resetScan(): void {
    faceIdx = 0;
    captures = [];
    captureRgb = [];
    stabilizer = new FaceStabilizer();
    needMotion = false;
    duplicateStrikes = 0;
    letters = [];
    confidences = [];
    badStickers = [];
    assembled = null;
    solveToken++;
    reviewEl.hidden = true;
    redoBtn.hidden = false;
    restartBtn.hidden = false;
    saveFrameBtn.hidden = false;
    setHint('');
    renderFaces();
  }

  async function startCamera(): Promise<void> {
    startMsg.textContent = '';
    startBtn.disabled = true;
    try {
      await camera.start();
      startOverlay.hidden = true;
      fpsEl.hidden = false;
      if (phase !== 'review') {
        phase = 'scanning';
        if (captures.length === 0) resetScan();
        setPrompt();
        renderFaces();
      }
      warmSolver();
      if (!raf) raf = requestAnimationFrame(loop);
    } catch (e) {
      startOverlay.hidden = false;
      startMsg.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener('click', () => void startCamera());
  restartBtn.addEventListener('click', () => {
    resetScan();
    phase = camera.running ? 'scanning' : 'idle';
    if (!camera.running) void startCamera();
    setPrompt();
    renderFaces();
  });
  redoBtn.addEventListener('click', () => {
    if (captures.length > 0 && phase === 'scanning') {
      captures.pop();
      captureRgb.pop();
      faceIdx--;
      stabilizer.reset();
      needMotion = true;
      setPrompt();
      renderFaces();
    }
  });
  rescanBtn.addEventListener('click', () => {
    resetScan();
    void startCamera();
  });
  copyStateBtn.addEventListener('click', () => void navigator.clipboard?.writeText(facelets()));
  saveFrameBtn.addEventListener('click', saveDebugFrame);
  saveScanBtn.addEventListener('click', saveScanReport);

  resetScan();
  setPrompt();

  return {
    start(): void {
      if (phase === 'review') return; // keep the review; user can hit "Scan again"
      void startCamera();
    },
    stop(): void {
      camera.stop();
      cancelAnimationFrame(raf);
      raf = 0;
      if (phase === 'scanning') {
        phase = 'idle';
        startOverlay.hidden = false;
        startBtn.textContent = 'Resume camera';
      }
    },
  };
}

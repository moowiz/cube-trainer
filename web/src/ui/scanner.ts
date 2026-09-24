// The scanner: one component, mounted on the trainer's Scan tab.
//
//   The M6/M7 pipeline per CLAUDE.md: camera -> frame ring (every frame
//   frozen on arrival) -> two-stage detector (stage-1 localizer on the
//   frame, stage-2 corners on its padded box; a stage-1 miss is a tick with
//   no detections) -> corner tracker -> homography rectify at native
//   resolution -> robust 9-cell sampling -> EVIDENCE LOG (readings with
//   quality weights, letter-free shared-edge pairings) -> the colour solver
//   (src/colour/solve.ts, docs/colour-pipeline-design.md) on a timer ->
//   lock on its certificates -> the locked cube handed to the host
//   (trainer-main.ts: the EO trainer). Nothing here decides a colour; the
//   component pumps frames, appends to the log, and renders the Solution.
//   The view runs one inference latency behind the camera so every overlay
//   is drawn on the exact frame its corners came from (framering.ts); the
//   debug panel can switch it back to live for comparison.
//
//   Debug: one collapsible panel: EP switch, detection cadence, stage-1 box
//   / ROI and heatmap overlays, a localizer-only switch (stage 2 off, to
//   tell a stage-1 failure from a stage-2 one), the per-sticker readout,
//   and the raw-frame / naming-evidence exports for the labeling loop.
//   Everything it shows is the pipeline's own state; nothing is recomputed
//   differently for the panel.
//
//   Replays: ?tab=scan&clip=/clips/x.mp4[&autostart=1][&autocapture=1]
//   [&solve=1][&post=<name>] feeds a recording through the same pipeline
//   (see the clip section at the end).
//
// Everything is scoped to the mount root: elements are found by class
// (`sc-<name>`), never by id, so the component can live inside the trainer
// page beside its own markup.
import './scanner.css';
import { Camera } from '../camera';
import { FrameRing, type RingFrame } from '../framering';
import { FpsCounter } from '../debug/fps';
import { labToSrgb } from '../colour/lab';
import { minFaceEdgePx } from '../colour/patch';
import { SolverClient } from '../colour/client';
import type { MovesResult } from '../colour/solve.worker';
import { commitmentsFrom } from '../moves/anchor';
import { applySeq, type Move } from '../moves/moves';
import { formatItems, recordMoves, type MoveRecord } from '../moves/record';
import { colourString } from '../follow';
import { renderNet } from '../cube/render';
import { formatTrace } from '../moves/reader';
import { emptyLog, trimLog } from '../colour/evidence';
import { SamplerClient } from '../colour/sampler';
import type { SampleTrack } from '../colour/sample.worker';
import { DEFAULT_PARAMS } from '../colour/solve';
import type { EvidenceLog, Solution } from '../colour/types';
import { ensureCrossOriginIsolated } from '../detect/coi';
import type { Ep } from '../detect/facekp';
import { drawSamplePatches, drawTracks, type SampledQuad } from '../debug/detect-overlay';
import { captureDebug, saveRawFrame, summarizeTick, type TickSummary } from '../debug/dump';
import { installDetectSelfTest } from '../debug/selftest';
import { describeModels, loadTwoStage, type TwoStageModels } from '../detect/models';
import { detectTwoStage, type TwoStageResult } from '../detect/twostage';
import { QuadTracker, type QuadDetection } from '../detect/tracker';
import { HintState, hintFor } from './hint';
import { SolveRecorder } from './recorder';
import { matchSharedEdge } from '../detect/orient';
import { randomScramble, scrambleState } from '../scramble';
import { solveState, warmSolver } from '../state';
import { diffFacelets, expectedFacelets, type Hold, type ScannedCube } from '../handoff';
import type { RecordingSession } from '../rig/session';
import { persistControls } from './settings';
import { COLOR_NAMES, DEFAULT_SCHEME_HEX, DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';
import type { ColorName, FaceId } from '../types';
import { scoped } from './dom';

export interface ScannerOptions {
  /**
   * Called with the locked cube (and again from the result panel's button):
   * a live scan hands off as soon as the lock's solution is in; a clip
   * replay or a solve recording stays on the scanner, where the log and the
   * move reader are the point.
   */
  onUseInTrainer?: (scan: ScannedCube) => void;
  /**
   * The scramble the host expects the cube to be in (a stage's current scramble, in the frame it is
   * held), or null. Every solve is checked against it and the check is shown live; the lock reports it.
   */
  expected?: () => { scramble: string; hold: Hold; shown?: string } | null;
  /** The host can give the open stage a fresh scramble (the Check line's New scramble button). */
  onNewScramble?: () => void;
  /**
   * Follow mode, a few times a second after the lock: the lock the reader
   * started from and the turns it has read since (the solver's letters), so
   * the host can move the trainer along with the cube. A fresh lock that
   * disagrees with the reader comes through `onUseInTrainer` again first.
   */
  onFollow?: (scan: ScannedCube, moves: readonly Move[], record: MoveRecord) => void;
  /** The follow strip's Stop button. */
  onStopFollow?: () => void;
  /**
   * Record was pressed: a recording session to stream the video and the capture into, or null to
   * keep the download behaviour (no sink on the deployed site).
   */
  onRecordStart?: () => Promise<RecordingSession | null>;
  /** The recording's capture has been written: close the session. */
  onRecordStop?: () => Promise<void>;
}

export interface ScannerHandle {
  /** Open the camera (a no-op while a clip replay is driving the page). */
  start(): void;
  /** Release the camera; the scan's state stays until Reset. */
  stop(): void;
  /** Forget the scan in progress (what the Reset scan button does; a no-op during a clip replay). */
  reset(): void;
  /** Follow mode is on: the camera keeps watching after the lock and the host is fed the cube's progress. */
  following(): boolean;
  /** Lay the scanner out as a dock (camera view and follow strip only) or in full. */
  setDocked(on: boolean): void;
  /** Start recording (the camera first if it is off): the video, the evidence log and, through the rig, the cube's events and the solves. */
  record(): Promise<void>;
  /** Stop the recording in progress (the evidence log follows it out). */
  stopRecording(): void;
  /** Seconds recorded so far, or null while not recording. */
  recording(): number | null;
  /** Float the live camera in its own window (Picture-in-Picture), or bring it back. */
  popOut(): Promise<void>;
}

const SAMPLE_CONF = 0.55;    // min tracked conf to contribute readings
const REFINE = true;         // grid-prior corner refinement before sampling
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
// ...and too bright when the median peak is up here or this share of the
// sampled sticker pixels is clipped: whites and yellows both read (2xx,
// 25x, 25x) and stop separating (solve 1789360518933: peak 228-255, clip
// 0.17, and auto at 62.5 ms had every turn motion-blurred at 15 fps).
const BRIGHT_PEAK = 215;
const BRIGHT_CLIP = 0.12;
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

// Which controls survive a refresh (values only; 'change' is dispatched at
// the end of mount, once every listener is attached). The exposure select
// is not among them: its options are per camera.
const PERSISTED = ['pauseOnLock', 'followChk', 'ep', 'every', 'sync', 'stage1', 'labelsChk', 'refusedChk', 'heat', 'stage2off', 'exChk', 'samplesChk', 'debug'] as const;

const TEMPLATE = `
  <div class="sc-wrap">
    <div class="sc-version"><span class="sc-status">model loading…</span></div>
    <div class="sc-cols">
      <div class="sc-main">
        <div class="sc-expect" hidden><b>Check</b> <span class="sc-expectAlg"></span> <span class="sc-expectState"></span> <button class="sc-expectNew" title="A fresh scramble for the open stage; the scan starts over">New scramble</button></div>
        <div class="sc-scramble" title="Apply this to a solved cube before scanning and tick the box: the capture then carries the true state and becomes a regression fixture on its own"><b>Scramble</b> <span class="sc-scrambleAlg"></span> <label><input type="checkbox" class="sc-applied"> I applied it (from solved)</label></div>
        <div class="sc-solverec" title="Record the camera feed while you turn the cube: the .webm and the debug capture download together, aligned on the same clock, and become a move-tracking fixture. Type the moves you will make (or leave blank for a free solve)"><b>Moves</b> <input class="sc-moves" placeholder="R U R' U' - what you will turn while recording" spellcheck="false" autocapitalize="characters"> <button class="sc-rec" disabled>Record</button> <span class="sc-recState"></span></div>
        <div class="sc-bar">
          <button class="sc-start">Start camera</button>
          <button class="sc-reset">Reset scan</button>
          <button class="sc-pause" disabled title="Freeze the frame and the overlay to inspect what was sampled">Pause</button>
          <button class="sc-save" disabled title="Download the raw camera frame (no overlay) for labeling">Save frame</button>
          <label title="Freeze the view on the frame that locked the cube instead of streaming a feed nothing reads any more"><input type="checkbox" class="sc-pauseOnLock" checked> pause on lock</label>
          <label title="After the lock the camera keeps watching while you solve: the turns it reads move the trainer from stage to stage, and pausing to show the cube around re-reads it in full"><input type="checkbox" class="sc-followChk" checked> follow my solve</label>
        </div>
        <div class="sc-stage"><canvas class="sc-view" width="640" height="480"></canvas><div class="sc-hint" hidden></div><div class="sc-lockbadge" hidden>Locked ✓ — camera paused. <b>Resume</b> keeps watching, <b>Reset scan</b> starts over.</div></div>
        <div class="sc-follow" hidden>
          <svg class="sc-followNet" viewBox="0 0 400 300" aria-label="the cube as followed"></svg>
          <div class="sc-followText"><div class="sc-followState">Following…</div><div class="sc-followAlg"></div></div>
          <button class="sc-followStop" title="Stop watching: the camera goes off">Stop</button>
        </div>
      </div>
      <aside class="sc-side">
        <div class="sc-ph">Face evidence</div>
        <div class="sc-fill">${FACE_ORDER.map((f) => `<div class="sc-chip" data-face="${f}" style="--fc:${DEFAULT_SCHEME_HEX[f]}"><b>${f}</b><span class="sc-chip-name">${DEFAULT_SCHEME_NAMES[f]}</span><span class="sc-chip-pct">0%</span><div class="sc-chip-bar"><i></i></div></div>`).join('')}</div>
        <div class="sc-unbound"></div>
        <p class="sc-note">One bar per face of the cube, named by its centre (U up, R right, F front, D down, L left, B back; the colours are the standard scheme until the solver has measured the cube's own). The bar is the weakest sticker of that face: how much of the lock floor (${DEFAULT_PARAMS.nMin} weighted readings) it has collected. Turn the cube until every bar is full.</p>
        <div class="sc-result"></div>
        <details class="sc-fold sc-attemptHd" hidden><summary class="sc-ph">Decoded faces</summary>
        <div class="sc-attempt sc-grids"></div>
        <p class="sc-note sc-legend" hidden>Each cell is painted with the colour actually measured for that sticker; the badge is the letter the decoder assigned it (<code>?</code> = too close to call, <code>·</code> = no evidence yet; the ringed cell is the centre). Header: which tracked quads fed the face and its rotation. Footer: why the solver will not lock yet — <i>changed</i> is how many stickers the cube's constraints moved off their raw best colour, <i>delta</i> how much worse the runner-up state scores, <i>min margin</i> the tightest sticker call.</p>
        </details>
      </aside>
      <aside class="sc-diag">
        <details class="sc-fold"><summary class="sc-ph">Pipeline</summary>
        <div class="sc-stats"></div>
        </details>
        <details class="sc-debug">
          <summary>Debug controls</summary>
          <div class="sc-row">
            <select class="sc-ep">
              <option value="auto">EP: auto</option>
              <option value="webgpu">EP: webgpu</option>
              <option value="wasm">EP: wasm</option>
            </select>
            <select class="sc-every">
              <option value="auto">detect: as fast as the machine allows</option>
              <option value="1">detect every frame</option>
              <option value="2">detect every 2nd frame</option>
              <option value="3">detect every 3rd frame</option>
            </select>
            <select class="sc-sync" title="Synced: the view is delayed by the detector's latency and each overlay is drawn on the frame it was computed for. Live: the view is the newest frame and detections are carried forward to it.">
              <option value="sync">view: synced to detection</option>
              <option value="live">view: live (overlay carried forward)</option>
            </select>
            <label><input type="checkbox" class="sc-stage1"> stage-1 box + ROI</label>
            <label><input type="checkbox" class="sc-labelsChk"> labels</label>
            <label><input type="checkbox" class="sc-refusedChk"> refused quads</label>
            <label class="sc-heatLbl" hidden><input type="checkbox" class="sc-heat"> heatmap</label>
            <label><input type="checkbox" class="sc-stage2off"> stage 2 off (localizer only)</label>
            <select class="sc-exposure" title="Exposure: the app steers the camera toward well-exposed stickers (peak/clip in the stats line), or hold a setting by hand"><option value="loop">exposure: app-controlled</option><option value="auto">exposure: camera auto</option></select>
            <label><input type="checkbox" class="sc-exChk"> solver</label>
            <label><input type="checkbox" class="sc-samplesChk"> sample patches</label>
            <button class="sc-capture" disabled title="Download the evidence log (every reading and pairing of this session), the solution, and the last ${TICK_HISTORY} ticks as JSON, plus the raw frame">Capture debug</button>
          </div>
          <div class="sc-msg"></div>
          <div class="sc-solverOut" hidden></div>
          <pre class="sc-movesTrace" title="The move reader's last frames: faces anchored (letter, g = face from geometry, . , ? = rotation from pairing / fit / free, digit = reliability in ninths), total reading weight, pre-vetoed cells, fit (mean cost per unit weight of the leader; over 2.5 = unexplained), cost margin to the runner-up state, burst depth tried, candidates scored, ms, the frame's chroma shift and inlier share, and the turns the leader took to reach this frame"></pre>
        </details>
      </aside>
    </div>
  </div>
`;

/** Mount the scanner into `root`. The camera runs between start() and stop(); the models load once, on mount. */
export function mountScanner(root: HTMLElement, opts: ScannerOptions = {}): ScannerHandle {
  ensureCrossOriginIsolated();
  root.classList.add('scan');
  root.innerHTML = TEMPLATE;

  /** An element of this mount by its `sc-<name>` class. */
  const $ = scoped(root, (name) => `.sc-${name}`, 'scanner template');

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
  const statsEl = $('stats');
  const movesTraceEl = $('movesTrace');

  // The pipeline readout: one labelled value per thing worth watching, grouped
  // by stage, each with a hover explanation. Values are written in place on
  // the UI tick; the capture dumps the same text.
  const DIAG: { group: string; rows: { id: string; label: string; hint: string }[] }[] = [
    { group: 'Camera', rows: [
      { id: 'frame', label: 'frame', hint: 'Camera frame size and the measured frame rate. A webcam drops to 15 fps when its exposure goes past 33 ms.' },
      { id: 'exposure', label: 'exposure', hint: "What the app last asked the camera for. 'app-controlled' steps the exposure until the stickers read well (see brightness); 'auto' is the camera's own whole-frame metering. '(step did not help)' = a step was undone and the loop is off for this session." },
      { id: 'peak', label: 'sticker brightness', hint: 'Running median of the brightest channel (0-255) of the sticker readings being sampled, the same for their darkest tenth (blues, shaded stickers), and the share of their pixels that are clipped. Under 55 is too dark to tell colours apart; over 215, or more than 12% clipped, is blown out (white and yellow merge) - but the loop only darkens while the darkest tenth would still clear 55 afterwards.' },
    ] },
    { group: 'Detector', rows: [
      { id: 'backend', label: 'backend', hint: 'ONNX runtime execution provider (webgpu or wasm), wasm threads, and whether inference runs in a worker.' },
      { id: 'stage1', label: 'stage 1 (find cube)', hint: 'The localizer: ms per tick, the objectness score of the last tick (1 = sure there is a cube), and how many ticks this session found no cube at all.' },
      { id: 'stage2', label: 'stage 2 (faces)', hint: 'The face keypoint model on the cube crop: ms per tick and how many face quads it returned on the last tick.' },
      { id: 'latency', label: 'latency', hint: 'Detector latency in camera frames. The view is delayed by this much so every overlay is drawn on the frame its corners came from; late = ticks that arrived after the view had already passed their frame.' },
      { id: 'tracks', label: 'tracks', hint: 'Face quads the tracker is following right now (up to 3 visible faces; a hand or a keyboard can be a false one).' },
    ] },
    { group: 'Sampling', rows: [
      { id: 'sampling', label: 'per frame', hint: 'Time the sampling worker spends on one sampled frame: corner refinement, the 90x90 warp and nine patch statistics per face. dropped = frames skipped because the worker was still busy. Frames are sampled at most every 80 ms.' },
      { id: 'log', label: 'evidence log', hint: 'What the solver sees: detection frames sampled this session, face readings (quads, nine cells each) and same-frame face pairings kept. The log keeps the newest 1500 quads (~40 s).' },
    ] },
    { group: 'Solver', rows: [
      { id: 'solve', label: 'solve', hint: 'ms per solve in the solver worker (it re-runs whenever new evidence lands, never back to back) and the colour space that produced the current answer (three are tried).' },
      { id: 'faces', label: 'faces', hint: 'Faces with a lettered centre out of six, and how many track groups the solver currently holds. More than six groups = the same face seen twice and not yet merged, or a junk quad.' },
      { id: 'verdict', label: 'verdict', hint: 'Why the solver will not lock yet, or ok. A lock needs a legal cube, every sticker seen, and a runner-up state clearly worse.' },
      { id: 'moves', label: 'move reader', hint: 'After a lock in solve mode (a recording running, or ?solve=1): frames the reader has anchored since the lock, ms per frame in the worker, and the cost margin of the leading move sequence over the best other one in its beam. The record itself is in the result panel; the last frames of its trace in the debug panel.' },
    ] },
  ];
  const diagCells = new Map<string, HTMLElement>();
  for (const g of DIAG) {
    const gh = document.createElement('div');
    gh.className = 'sc-dg';
    gh.textContent = g.group;
    statsEl.append(gh);
    for (const r of g.rows) {
      const row = document.createElement('div');
      row.className = 'sc-dr';
      row.title = r.hint;
      const k = document.createElement('span');
      k.className = 'sc-k';
      k.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'sc-v';
      v.textContent = '–';
      row.append(k, v);
      statsEl.append(row);
      diagCells.set(r.id, v);
    }
  }
  function setDiag(id: string, text: string): void {
    const el = diagCells.get(id)!;
    if (el.textContent !== text) el.textContent = text;
  }
  /** The readout as text, for the capture. */
  function diagText(): string {
    return DIAG.map((g) => `${g.group}: ${g.rows.map((r) => `${r.label} = ${diagCells.get(r.id)!.textContent}`).join('; ')}`).join('\n');
  }
  const hintEl = $('hint');
  const msgEl = $('msg');
  const startBtn = $<HTMLButtonElement>('start');
  const saveBtn = $<HTMLButtonElement>('save');
  const captureBtn = $<HTMLButtonElement>('capture');
  const epSel = $<HTMLSelectElement>('ep');
  const everySel = $<HTMLSelectElement>('every');
  const syncSel = $<HTMLSelectElement>('sync');
  const stageChk = $<HTMLInputElement>('stage1');
  const heatChk = $<HTMLInputElement>('heat');
  const stage2Off = $<HTMLInputElement>('stage2off');
  const exposureSel = $<HTMLSelectElement>('exposure');
  const exChk = $<HTMLInputElement>('exChk');
  const samplesChk = $<HTMLInputElement>('samplesChk');
  const labelsChk = $<HTMLInputElement>('labelsChk');
  const refusedChk = $<HTMLInputElement>('refusedChk');
  const pauseBtn = $<HTMLButtonElement>('pause');
  const attemptEl = $('attempt');
  const solverEl = $('solverOut');
  const pauseOnLockChk = $<HTMLInputElement>('pauseOnLock');
  const followChk = $<HTMLInputElement>('followChk');

  const restoredControls = persistControls(Object.fromEntries(PERSISTED.map((k) => [k, $(k)])));

  // The page's URL drives the replay harness: ?clip= plays a recording
  // instead of the camera, ?solve=1 keeps the log growing past the lock.
  const params = new URL(location.href).searchParams;
  const clipUrl = params.get('clip');
  // Solve mode (?solve=1, or while a recording is running): the log keeps
  // growing after the start lock - sampling continues, nothing is trimmed -
  // so the moves that follow the lock are in the capture. The solver still
  // stops at the lock; its Solution is the start state, not a running read.
  const solveMode = (): boolean => params.get('solve') === '1' || rec.active() || following();
  // Follow mode (the checkbox; a clip replay follows only when its URL says
  // ?follow=1, so the replay tooling's captures are unchanged): after the
  // lock the reader runs, the camera stays on, and the solver keeps working
  // on the current EPOCH - the evidence since the last turn read - so a
  // pause to show the cube around re-locks it in full. A re-lock that
  // agrees with the reader confirms it; one that disagrees replaces it.
  const following = (): boolean => followChk.checked && (!clipUrl || params.get('follow') === '1');
  // the whole log is kept only where it is the point (a recording, ?solve=1); following alone trims like a scan.
  // A stopped recording's capture comes 800 ms after the stop, with the camera still running: the log is kept
  // until that capture has been taken (2026-09-19: a six-minute session's log was trimmed to its last 40 s
  // in that gap).
  let captureOwed = false;
  const keepWholeLog = (): boolean => params.get('solve') === '1' || rec.active() || captureOwed;

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
  // The move reader (src/moves/): started in the worker once the cube is locked
  // and the session is in solve mode; polled for its record while it runs.
  let tracking = false;
  let movesResult: MovesResult | null = null;
  let lastMovesTs = -Infinity;
  const MOVES_POLL_MS = 250;
  // follow mode: the epoch the solver re-reads (wall-clock ms; evidence before it is a cube that has since been turned),
  // the lock handed to the host (its cubejs solution is what the trainer needs), and the last re-lock's verdict
  let epochFromT = -Infinity;
  let followScan: ScannedCube | null = null;
  let relockNote = '';
  let logVersion = 0;
  let solvedVersion = -1;
  let solveEma = 0;
  let solverError: string | null = null; // the last solve threw: shown in the verdict row instead of a silent freeze
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
  const hintState = new HintState();
  let cubeTooSmall = false;  // localizer found a cube whose silhouette is under the face floor
  let noCube = false;        // localizer found nothing on the last tick
  let solved = false;
  let pipeEma = 0;           // ms spent in the colour pipeline per detection frame (EMA)
  let lastUiTs = 0;
  let paused = false;
  /** The quads actually sampled this frame (source px, refined) and their sampling plan, for the overlay. */
  let sampledQuads: SampledQuad[] = [];
  let lastSolveTs = 0;
  let lastSampleTs = -Infinity;
  let peakEma = 255;         // running median-ish of the brightest channel of sampled readings
  let peakLowEma = 255;      // same for the darkest tenth of them (the blues and shaded stickers)
  let clipEma = 0;           // running mean of the sampled readings' clipped fraction
  let exposureAt = 0;        // when the camera's exposure compensation was last nudged
  let exposureComp: string | null = null;   // what was applied ('ev +1', '62.5 ms', 'auto'; null: never / not supported)
  let exposureLevels: number[] = [];   // manual times the camera offers (ms, longest first); empty: none
  let exposureIdx = -1;                // index into exposureLevels, -1 = camera auto
  let exposureGaveUp = false;          // a step did not move the cube's brightness the way it should: leave the camera alone
  // the step just taken, checked one hold-off later against what the cube reads
  let exposureStep: { fromIdx: number; dir: 1 | -1; peakBefore: number; clipBefore: number } | null = null;
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
      return outcome;
    }
    statusEl.textContent = `model ready: ${describeModels(models)}`;
    const anon = models.detector.anonymous;
    $('heatLbl').hidden = !anon;
    return outcome;
  }

  void load(epSel.value as Ep | 'auto');
  epSel.addEventListener('change', () => void load(epSel.value as Ep | 'auto'));
  warmSolver();
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
      box.className = 'sc-face';
      const hd = document.createElement('div');
      hd.className = 'sc-hd';
      const g = sol.groups.find((x) => x.letter === face);
      const n = sol.nEff.slice(fi * 9, fi * 9 + 9);
      const dot = document.createElement('i');
      dot.className = 'sc-dot';
      dot.style.background = cssOfLetter(face);
      const title = document.createElement('b');
      title.textContent = `${face} ${DEFAULT_SCHEME_NAMES[face]}`;
      hd.append(dot, title, document.createTextNode(
        `${g ? ` · tracks ${g.tracks.map((t) => `#${t}`).join(' ')}` : ' · not seen'}\n`
        + `evidence ${Math.min(...n).toFixed(1)}–${Math.max(...n).toFixed(1)}${g ? ` · rot ${g.absRotation ?? '?'}${g.rotationVotes.some(Boolean) ? ` (${g.rotationVotes.join('/')})` : ''}` : ''}`));
      const grid = document.createElement('div');
      grid.className = 'sc-g';
      for (let k = 0; k < 9; k++) {
        const i = fi * 9 + k;
        const c = document.createElement('div');
        c.className = 'sc-c' + (k === 4 ? ' sc-mid' : '');
        const lab = sol.slotLab[i];
        if (lab) { const rgb = labToSrgb(lab); c.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; }
        else c.style.background = '#2a2f3a';
        const letter = sol.slotLetter[i];
        const tag = document.createElement('span');
        const margin = sol.decode?.margins[i] ?? 0;
        const low = !letter || margin < DEFAULT_PARAMS.marginMin || sol.nEff[i]! < DEFAULT_PARAMS.nMin;
        tag.className = 'sc-tag' + (low ? ' sc-low' : '');
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
    note.className = 'sc-hd';
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
      const fresh = peakEma === 255;
      peakEma = fresh ? peaks[peaks.length >> 1]! : 0.8 * peakEma + 0.2 * peaks[peaks.length >> 1]!;
      peakLowEma = fresh ? peaks[Math.floor(peaks.length / 10)]! : 0.8 * peakLowEma + 0.2 * peaks[Math.floor(peaks.length / 10)]!;
      clipEma = 0.8 * clipEma + 0.2 * clip;
    }
    for (const q of r.refined) lastOffset.set(q.track, q.offset);
    // mirror to the worker before trimming so both logs trim identically
    solver.sync(log);
    // solve mode keeps the whole log (every epoch of a solve is evidence)
    const dropped = keepWholeLog() ? { quads: 0, pairings: 0, events: 0 } : trimLog(log);
    solver.trimmed(dropped.quads, dropped.pairings, dropped.events);
    logVersion++;
  };

  /** Live solver table: the palette, the face groups, and the certificates. */
  function renderSolver(): void {
    const sol = locked ?? solution;
    if (!sol) { solverEl.textContent = 'no solution yet'; return; }
    const pal = sol.palette.lab.map((l, c) => `colour ${c} ${(sol.colourLetter[c] ? DEFAULT_SCHEME_NAMES[sol.colourLetter[c]!] : '?').padEnd(7)} `
      + (l ? `L ${l.L.toFixed(0).padStart(3)} a ${l.a.toFixed(0).padStart(4)} b ${l.b.toFixed(0).padStart(4)}` : 'empty') + `  sigma ${sol.palette.sigma[c]!.toFixed(1)}`);
    const groups = sol.groups.map((g) => `group ${g.id} ${(g.letter ?? '-').padEnd(2)} evidence ${g.nEff.toFixed(0).padStart(4)}  rot ${g.absRotation ?? '?'}  tracks ${g.tracks.map((t) => `#${t}${g.rotation.get(t) ? `+${g.rotation.get(t)}` : ''}`).join(' ')}`);
    const naming = sol.naming ? `names ${sol.naming.names.map((n, c) => `${c}:${n ?? '-'}`).join(' ')}${sol.naming.hinted ? ' (from decoded centres)' : ''}\n`
      + `letter maps ${sol.naming.top.map((t) => `${t.letters} pen ${t.penalty} mis ${t.mismatches}`).join(' | ')}` : '';
    solverEl.textContent = [...pal, '', ...groups, '', naming, '', `${sol.reason} - ${sol.embedding} - solve ${sol.ms.toFixed(0)} ms - frames ${log.frames} quads ${log.quads.length} pairings ${log.pairings.length}`].join('\n');
  }

  let renderedSolution: Solution | null = null;

  function updateFillUI(): void {
    const sol = locked ?? solution;
    for (const f of FACE_ORDER) {
      const fi = FACE_ORDER.indexOf(f);
      const n = sol ? Math.min(...sol.nEff.slice(fi * 9, fi * 9 + 9)) : 0;
      const frac = Math.min(1, n / DEFAULT_PARAMS.nMin);
      const chip = root.querySelector<HTMLElement>(`.sc-chip[data-face="${f}"]`)!;
      chip.style.setProperty('--fc', cssOfLetter(f));
      chip.classList.toggle('sc-done', frac >= 1);
      chip.querySelector<HTMLElement>('.sc-chip-bar i')!.style.width = `${frac * 100}%`;
      chip.querySelector('.sc-chip-pct')!.textContent = `${Math.round(frac * 100)}%`;
    }
    $('unbound').textContent = solverError && !locked ? `solver failed: ${solverError.split('\n')[0]}` : sol && !locked ? `${sol.centresSeen}/6 faces - ${sol.reason}` : '';
    if (locked && !solved) {
      solved = true;
      const st = locked.facelets!;
      const colourOf = coloursOf(locked);
      // the solution's moves are named by centre: U is the face whose centre
      // is the U colour, F the F colour - say so, or the moves are meaningless
      const hold = `Hold the cube with the ${colourOf[st[4] as FaceId]} centre on top and the ${colourOf[st[22] as FaceId]} centre facing you.`;
      const chk = checkExpected(locked, st.split(''));
      const match = !chk || chk.note ? '' : chk.wrong.length === 0 ? '<div class="sc-match sc-ok">This is the scramble ✓</div>' : `<div class="sc-match sc-bad">Not the scramble: ${chk.wrong.length} sticker${chk.wrong.length === 1 ? '' : 's'} differ</div>`;
      const cert = `${locked.decode!.changed} sticker(s) moved by the cube's constraints; runner-up state ${locked.decode!.delta === Infinity ? 'none' : `${locked.decode!.delta.toFixed(1)} worse`}`;
      // facelets and moves are letters from the solver, never user text
      resultEl.innerHTML = `<div class="sc-rt">Locked ✓</div>${match}<div class="sc-st">${st}</div><div class="sc-cert">${cert}</div><div class="sc-hold">${hold}</div><div class="sc-sol">solving…</div><div class="sc-use" hidden></div><div class="sc-read" hidden><div class="sc-mh">Moves read</div><div class="sc-mv"></div></div>`;
      const solEl = resultEl.querySelector('.sc-sol')!;
      void solveState(st)
        .then((s) => {
          solEl.textContent = s.trim() === '' ? 'Already solved!' : s;
          const use = opts.onUseInTrainer;
          if (!use) return;
          const scan: ScannedCube = { facelets: st, colourOf, solution: s };
          const btn = document.createElement('button');
          btn.textContent = 'Practice in the EO trainer';
          btn.addEventListener('click', () => use(scan));
          const useEl = resultEl.querySelector<HTMLElement>('.sc-use')!;
          useEl.replaceChildren(btn);
          useEl.hidden = false;
          // a live scan is for the trainer: hand it over as soon as it is read (following: every lock, a clip too)
          if (following()) followScan = scan;
          if (following() || (!clipUrl && !rec.active())) use(scan);
          renderFollow();
        })
        .catch((e) => { solEl.textContent = `solver failed: ${e}`; });
      // The cube is read: freeze the view on the frame that locked it (the
      // overlay stays up) rather than keep streaming a feed nothing reads any
      // more. A clip must play to its end so the autocapture hook fires.
      // (not while recording a solve: the moves come after the lock)
      if (!clipUrl && !rec.active() && !following() && pauseOnLockChk.checked) setPaused(true);
      epochFromT = Date.now();
      followEl.hidden = !following();
    }
    if (sol !== renderedSolution) { renderedSolution = sol; renderSolution(); }
  }

  /** The colour each letter's centre carries, from the solver's naming (the standard scheme where it left a letter unnamed). */
  function coloursOf(sol: Solution): Record<FaceId, ColorName> {
    const out = { ...DEFAULT_SCHEME_NAMES };
    sol.colourLetter.forEach((letter, c) => {
      const name = sol.naming.names[c];
      if (letter && name && (COLOR_NAMES as readonly string[]).includes(name)) out[letter] = name as ColorName;
    });
    return out;
  }
  /** coloursOf, but only once the solver has named every face - a partial naming would check against the wrong frame. */
  function coloursOfStrict(sol: Solution): Record<FaceId, ColorName> | null {
    const named = sol.colourLetter.filter((l, c) => l && sol.naming.names[c]).length;
    return named === 6 ? coloursOf(sol) : null;
  }

  // ---- the host's scramble: is the cube in view the one the trainer thinks it is? ----
  const expectEl = $('expect');
  /** The check against the host's scramble for a (partial) reading; null when there is nothing to check. */
  function checkExpected(sol: Solution, letters: readonly (string | null)[]): { scramble: string; read: number; wrong: number[]; note?: string } | null {
    const exp = opts.expected?.();
    if (!exp) return null;
    const colourOf = coloursOfStrict(sol);
    if (!colourOf) return { scramble: exp.scramble, read: 0, wrong: [], note: 'waiting for all six centres' };
    try {
      const want = expectedFacelets(exp.scramble, exp.hold, colourOf);
      return { scramble: exp.scramble, ...diffFacelets(want, letters) };
    } catch (err) {
      return { scramble: exp.scramble, read: 0, wrong: [], note: err instanceof Error ? err.message : String(err) };
    }
  }
  function renderExpected(sol: Solution | null): void {
    const exp = opts.expected?.();
    expectEl.hidden = !exp;
    $('scramble').hidden = !!exp; // the scanner's own random scramble is a fixture tool; a stage's scramble replaces it
    if (!exp) return;
    $('expectAlg').textContent = exp.shown ?? exp.scramble;
    const st = $('expectState');
    const chk = sol ? checkExpected(sol, sol.slotLetter) : null;
    if (!chk) { st.textContent = 'scan to compare'; st.className = 'sc-expectState'; return; }
    if (chk.note) { st.textContent = chk.note; st.className = 'sc-expectState'; return; }
    const w = chk.wrong.length;
    st.textContent = chk.read === 0 ? 'no stickers read yet' : w === 0 ? `${chk.read} of 54 stickers read, all match ✓` : `${chk.read} read, ${w} differ${w <= 3 ? ' (close)' : ''}`;
    st.className = 'sc-expectState ' + (chk.read === 0 ? '' : w === 0 ? 'sc-ok' : w <= 3 ? 'sc-near' : 'sc-bad');
  }
  renderExpected(null);
  $('expectNew').hidden = !opts.onNewScramble;
  $('expectNew').addEventListener('click', () => { opts.onNewScramble?.(); $('reset').click(); renderExpected(null); });

  /** The ticker: turns the reader is sure of in full, the rest dimmed with a '?', plus the reader's trace in the debug panel. */
  function renderMoves(): void {
    const r = movesResult;
    const box = resultEl.querySelector<HTMLElement>('.sc-read');
    if (!r || !box) return;
    box.hidden = false;
    const mv = box.querySelector('.sc-mv')!;
    mv.textContent = '';
    const committed = new Set(r.committed.map((m, i) => `${i}:${m}`));
    let i = 0;
    for (const it of r.record.items) {
      const span = document.createElement('span');
      if (it.kind === 'gap') { span.className = 'sc-gap'; span.textContent = `(${it.minMoves}+ unread)`; mv.append(span, ' '); continue; }
      const moves = it.kind === 'move' ? [it.move] : it.moves;
      const sure = it.sure && moves.every((m, j) => committed.has(`${i + j}:${m}`));
      i += moves.length;
      span.className = sure ? 'sc-sure' : 'sc-unsure';
      span.textContent = it.kind === 'move' ? it.move : it.ordered ? `(${moves.join(' ')})` : `[${moves.join(' ')}]`;
      if (!sure) span.textContent += '?';
      span.title = `${it.kind === 'burst' && !it.ordered ? 'order unknown; ' : ''}margin ${it.margin === Infinity ? 'inf' : it.margin.toFixed(1)}; ${((it.t1 - it.t0) / 1000).toFixed(2)} s window`;
      mv.append(span, ' ');
    }
    if (!r.record.items.length) mv.textContent = 'no turns yet';
    renderFollow();
    setDiag('moves', `${r.frames} frames · ${(r.msPerFrame + r.anchorMsPerFrame).toFixed(1)} ms/frame · margin ${r.record.margin === Infinity ? 'inf' : r.record.margin.toFixed(1)}`);
    movesTraceEl.textContent = `${r.tracks.map((t) => `#${t.track}: ${t.face}, rotation ${t.k}, ${t.gain}`).join('\n')}\n${formatTrace(r.trace, { from: r.record.t0 })}\n${formatItems(r.record)}`;
  }

  // ---- follow mode: the strip under the camera, and the host ----
  const followEl = $('follow');
  const followNet = $('followNet') as unknown as SVGSVGElement;
  $('followStop').addEventListener('click', () => opts.onStopFollow?.());
  /** The turns read so far along the reader's leading path (the solver's letters). */
  const readMovesSoFar = (): Move[] => (movesResult ? recordMoves(movesResult.record) : []);
  /** The cube the app believes is in your hands, in the lock's letters. */
  const believed = (): string | null => (locked?.facelets ? applySeq(locked.facelets, readMovesSoFar()) : null);
  /** The follow strip: the believed cube as a net in its own colours, the turns read, the last re-lock's verdict; and the host hears the progress. */
  function renderFollow(): void {
    if (!following() || !locked?.facelets) return;
    const state = believed()!;
    const colourOf = coloursOf(locked);
    const hexOfColour = (c: ColorName): string => DEFAULT_SCHEME_HEX[FACE_ORDER.find((f) => DEFAULT_SCHEME_NAMES[f] === c) ?? 'U'];
    renderNet(followNet, state.split('').map((l) => ({ fill: hexOfColour(colourOf[l as FaceId]) })));
    const r = movesResult;
    const moves = readMovesSoFar();
    const alg = r ? r.record.items.map((it) => (it.kind === 'gap' ? `(${it.minMoves}+?)` : it.kind === 'move' ? it.move + (it.sure ? '' : '?') : `(${it.moves.join(' ')})${it.sure ? '' : '?'}`)).join(' ') : '';
    $('followAlg').textContent = alg || 'no turns read yet';
    $('followState').textContent = relockNote || (r ? `${moves.length} turn${moves.length === 1 ? '' : 's'} read` : 'watching');
    if (followScan && r && opts.onFollow) opts.onFollow(followScan, moves, r.record);
  }
  /**
   * A solve of the current epoch came back while following. Lockable and the
   * same cube (by colour, so the letters need not match) as the reader
   * believes: confirmation. Lockable and different: the reader lost the
   * cube; this lock is the truth from here - the reader restarts from it and
   * the host is handed it like a first lock. Not lockable: nothing (a pause
   * with the cube in view is what makes an epoch lockable).
   */
  function onRelock(sol: Solution): void {
    if (!locked?.facelets) return;
    if (!sol.lockable || !sol.facelets) return;
    const same = colourString(sol.facelets, coloursOf(sol)) === colourString(believed()!, coloursOf(locked));
    if (same) { relockNote = 're-read ✓ agrees'; renderFollow(); return; }
    relockNote = 're-read: the cube was not where the reader thought - following from this lock';
    locked = sol;
    solution = sol;
    tracking = false;      // the reader restarts from the new commitments (loop)
    movesResult = null;
    followScan = null;
    solved = false;        // renderSolution hands the new lock to the host and redraws the result panel
    epochFromT = Date.now();
    renderExpected(sol);
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
      if ((!locked || following()) && !solver.busy && logVersion !== solvedVersion && ts - lastSolveTs >= Math.max(SOLVE_MIN_MS, 1.5 * solveEma)) {
        lastSolveTs = ts;
        solvedVersion = logVersion;
        const relock = locked !== null;
        void solver.requestSolve(relock ? epochFromT : undefined).then((sol) => {
          if (relock) { solveEma = 0.2 * sol.ms + 0.8 * solveEma; onRelock(sol); return; }
          if (locked) return;
          solverError = null;
          solution = sol;
          solveEma = solveEma === 0 ? sol.ms : 0.2 * sol.ms + 0.8 * solveEma;
          renderExpected(sol);
          if (sol.lockable) locked = sol;
        }).catch((err: unknown) => {
          solverError = err instanceof Error ? err.message : String(err);
          console.error('solver failed', err);
        });
      }

      // Solve mode after the lock: the worker reads the moves as the frames
      // land; poll its record a few times a second for the ticker
      if (locked && solveMode() && !tracking) {
        const commit = commitmentsFrom(locked);
        if (commit) { tracking = true; solver.track(commit, Date.now()); }
      }
      if (tracking && !solver.movesBusy && ts - lastMovesTs >= MOVES_POLL_MS) {
        lastMovesTs = ts;
        void solver.requestMoves().then((r) => {
          if (!r) return;
          movesResult = r;
          // the evidence up to the last turn read is a cube that no longer exists: the epoch starts after it
          const last = r.record.items[r.record.items.length - 1];
          if (last) epochFromT = Math.max(epochFromT, last.t1);
          renderMoves();
        });
      }

      if (!confident.length || locked) sampledQuads = [];
      drawTracks(ctx, lastTick, tracks, { heat: heatChk.checked, stage: stageChk.checked, refused: refusedChk.checked, labels: labelsChk.checked },
        SAMPLE_CONF, faceOfTrack, cssOfLetter);
      if (samplesChk.checked) drawSamplePatches(ctx, sampledQuads, (track) => { const f = faceOfTrack(track); return f ? cssOfLetter(f) : null; });
      // Banner for refusals the user can fix (too far, too dark, glare).
      const reasons = lastTick?.result?.refused.map((u) => u.reason) ?? [];
      const dark = confident.length > 0 && !locked && peakEma < DARK_PEAK;
      const hint = hintState.update(hintFor(reasons, confident.length > 0, cubeTooSmall, noCube, dark), ts);
      // Cube-metered exposure: the camera's own metering weighs the whole
      // frame; when the stickers being read are dark (or blown out) ask the
      // camera for one step more (less), where it offers exposure
      // compensation at all - a no-op elsewhere.
      if (!clipUrl && exposureSel.value === 'loop' && !locked && !exposureGaveUp && ts - exposureAt >= EXPOSURE_HOLD_MS) {
        if (confident.length > 0) {
          exposureAt = ts;
          void steerExposure();
        } else if (exposureStep && ts - exposureAt >= 2 * EXPOSURE_HOLD_MS) {
          // the step cost us the cube itself (the detector lost it in the
          // dark, or in the glare): nothing will ever come to check it, so
          // undo it now rather than sit there
          exposureAt = ts;
          void undoExposureStep('cube lost');
        }
      }
      hintEl.hidden = !hint;
      if (hint) hintEl.textContent = hint.text;
      fps.tick();
      if (ts - lastUiTs >= UI_EVERY_MS) {
        lastUiTs = ts;
        if (exChk.checked) renderSolver();
        updateFillUI();
        const sol = locked ?? solution;
        setDiag('frame', `${v.videoWidth}×${v.videoHeight} · ${fps.fps.toFixed(1)} fps`);
        setDiag('exposure', exposureSel.value === 'loop' ? `app-controlled${exposureComp !== null ? ` → ${exposureComp}` : ''}` : (exposureComp ?? exposureSel.value));
        setDiag('peak', peakEma === 255 && !log.quads.length ? 'no readings yet' : `${peakEma.toFixed(0)} / 255 (darkest tenth ${peakLowEma.toFixed(0)}) · ${(clipEma * 100).toFixed(0)}% clipped${peakEma < DARK_PEAK ? ' · too dark' : peakEma > BRIGHT_PEAK || clipEma > BRIGHT_CLIP ? (peakLowEma / 2 > DARK_PEAK ? ' · too bright' : ' · whites clip, darkening would lose the blues') : ''}`);
        setDiag('backend', m ? `${m.detector.ep}${m.detector.threads > 1 ? ` × ${m.detector.threads} threads` : ''}${m.detector.proxied ? ' · worker' : ''}` : 'loading');
        setDiag('stage1', lastTick ? `${locateEma.toFixed(1)} ms · obj ${lastTick.obj.toFixed(2)} · no cube on ${stage1Misses} of ${ticks} ticks` : '–');
        setDiag('stage2', lastTick ? (lastTick.result ? `${inferEma.toFixed(1)} ms · ${lastTick.result.quads.length} quad${lastTick.result.quads.length === 1 ? '' : 's'}` : stage2Off.checked ? 'off' : 'skipped (no cube)') : '–');
        setDiag('latency', `${lagEma.toFixed(1)} frames · view ${delay ? `−${delay}` : 'live'} · late ${lateTicks} of ${ticks}`);
        setDiag('tracks', `${tracks.length}${confident.length !== tracks.length ? ` (${confident.length} confident)` : ''}`);
        setDiag('sampling', `${sampler.msEma.toFixed(0)} ms · dropped ${sampler.dropped}`);
        setDiag('log', `${log.frames} frames · ${log.quads.length} quads · ${log.pairings.length} pairings`);
        setDiag('solve', sol ? `${solveEma.toFixed(0)} ms · ${sol.embedding}` : solveEma ? `${solveEma.toFixed(0)} ms` : '–');
        setDiag('faces', sol ? `${sol.centresSeen} of 6 · ${sol.groups.length} groups` : '–');
        setDiag('verdict', locked ? 'locked ✓' : solverError ? `solver failed: ${solverError.split('\n')[0]} (Capture debug and file it)` : sol ? sol.reason : '–');
      }
      shown = frame;
    }
    again();
  }

  /**
   * One controller tick: aim the cube's brightness between DARK_PEAK and
   * BRIGHT_PEAK/BRIGHT_CLIP with the shortest exposure that gets there (a
   * shorter time is a higher frame rate and less motion blur). Phones with
   * exposure compensation get a step of that; other cameras step through
   * the manual times the camera offers. Every step is checked one hold-off
   * later against what the cube then reads: a step that did not move it the
   * right way is undone and the loop stops for the session - the LifeCam's
   * auto mode brightens with gain that a manual time resets, so "brighter"
   * turned the picture black once (2026-09-13 evening).
   */
  async function steerExposure(): Promise<void> {
    const tooDark = peakEma < DARK_PEAK;
    // A cube spans ~3 stops from white to blue and a darkening step halves
    // everything: the whites clipping is only worth fixing while the darkest
    // tenth of the readings would still clear the dark floor afterwards -
    // else the step trades blown whites for blues in the noise, where the
    // solver's brightness normalisation has nothing to work with.
    const tooBright = (peakEma > BRIGHT_PEAK || clipEma > BRIGHT_CLIP) && peakLowEma / 2 > DARK_PEAK;
    if (exposureStep) {
      const st = exposureStep;
      const moved = st.dir > 0 ? peakEma > st.peakBefore * 1.15 + 3 : peakEma < st.peakBefore * 0.9 || clipEma < st.clipBefore * 0.7;
      if (!moved) { await undoExposureStep('step did not help'); return; }
      exposureStep = null;
    }
    const dir: 1 | -1 | 0 = tooDark ? 1 : tooBright ? -1 : 0;
    if (!dir) return;
    if (camera.hasExposureCompensation()) {
      const v = await camera.nudgeCompensation(dir);
      if (v !== null) exposureComp = v;
      return;
    }
    if (!exposureLevels.length) return;
    let next: number;
    if (exposureIdx < 0) {
      if (dir > 0) next = 0; // the longest time: only a gain-free camera gets brighter than auto here - the check decides
      else {
        // DECISION: auto's own time is unknowable (the driver reports its last
        // manual register), but the frame rate bounds it: the first darkening
        // step is the longest level clearly under the frame period, so it is
        // darker than auto whatever gain auto was adding
        const period = 1000 / Math.max(1, fps.fps);
        next = exposureLevels.findIndex((ms) => ms < period / 1.6);
        if (next < 0) next = exposureLevels.length - 1;
      }
    } else {
      next = exposureIdx - dir;
      if (next < 0) {
        // brighter than the longest time is auto (with its gain)
        const before = { fromIdx: exposureIdx, dir, peakBefore: peakEma, clipBefore: clipEma };
        const v = await camera.resetExposure();
        if (v !== null) { exposureComp = v; exposureIdx = -1; exposureStep = before; }
        return;
      }
      if (next >= exposureLevels.length) return; // as short as it goes
    }
    const before = { fromIdx: exposureIdx, dir, peakBefore: peakEma, clipBefore: clipEma };
    const v = await camera.setExposureTime(exposureLevels[next]!);
    if (v !== null) { exposureComp = v; exposureIdx = next; exposureStep = before; }
  }

  /** Put the camera back where it was before the pending step, and leave it alone for the rest of the session. */
  async function undoExposureStep(why: string): Promise<void> {
    const st = exposureStep;
    exposureStep = null;
    if (!st) return;
    exposureGaveUp = true;
    const back = st.fromIdx < 0 ? await camera.resetExposure() : await camera.setExposureTime(exposureLevels[st.fromIdx]!);
    exposureIdx = st.fromIdx;
    exposureComp = `${back ?? exposureComp ?? '?'} (${why})`;
  }

  /** The debug panel's exposure select: app-controlled, camera auto, or one of the camera's manual times. */
  function fillExposureSelect(): void {
    exposureLevels = camera.exposureLevelsMs();
    for (const o of [...exposureSel.options]) if (o.value !== 'loop' && o.value !== 'auto') o.remove();
    for (const ms of exposureLevels) {
      const o = document.createElement('option');
      o.value = String(ms);
      o.textContent = `exposure: ${ms.toFixed(1)} ms manual`;
      exposureSel.append(o);
    }
    exposureSel.value = 'loop';
    exposureIdx = -1;
    exposureStep = null;
    exposureGaveUp = false;
  }
  exposureSel.addEventListener('change', () => {
    exposureStep = null;
    exposureGaveUp = false;
    const v = exposureSel.value;
    if (v === 'loop') return;
    const ms = v === 'auto' ? null : Number(v);
    exposureIdx = ms === null ? -1 : exposureLevels.indexOf(ms);
    void camera.setExposureTime(ms).then((r) => { if (r !== null) exposureComp = r; });
  });

  function stopAuto(): void {
    running = false;
    loopGen++;
    setPaused(false);
    camera.stop();
    startBtn.textContent = 'Start camera';
    saveBtn.disabled = true;
    captureBtn.disabled = true;
    pauseBtn.disabled = true;
    rec.stop(); // the stream is about to end; keep what was recorded
    recBtn.disabled = true;
  }

  function setPaused(on: boolean): void {
    paused = on;
    pauseBtn.textContent = on ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('sc-on', on);
    $('lockbadge').hidden = !(on && locked);
    const v = camera.video;
    if (on) v.pause(); else void v.play().catch(() => undefined);
  }

  pauseBtn.addEventListener('click', () => { if (running) setPaused(!paused); });

  // Solve recording (ui/recorder.ts): the video and the debug capture download
  // together, aligned on the same clock; the moves typed are the take's truth.
  const recBtn = $<HTMLButtonElement>('rec');
  const movesInput = $<HTMLInputElement>('moves');
  const recStateEl = $('recState');
  const MOVES_RE = /^(\s*[URFDLBurfdlbMESxyz][2']?)*\s*$/;
  function movesText(): string { return movesInput.value.trim().replace(/\s+/g, ' '); }
  /** The state after scramble + moves from solved, when both are trustworthy. */
  function endTruth(): string | null {
    const m = movesText();
    if (!appliedChk.checked || !MOVES_RE.test(m)) return null;
    try { return scrambleState(m ? `${scramble} ${m}` : scramble); } catch { return null; }
  }
  const rec = new SolveRecorder({
    onRecordStart: opts.onRecordStart,
    onActive: (on) => {
      recBtn.textContent = on ? 'Stop recording' : 'Record';
      recBtn.classList.toggle('sc-on', on);
      movesInput.disabled = on; // the moves are the truth for this take - fix them before pressing Record
    },
    onState: (text) => { recStateEl.textContent = text; },
    onStopped: () => {
      // the paired evidence log: into the session, or a second download (a second prompt on Android is expected)
      captureOwed = true;
      setTimeout(() => captureBtn.click(), 800);
    },
  });
  async function startRecording(): Promise<void> {
    const stream = camera.stream;
    if (!running || !stream || !SolveRecorder.supported()) { msgEl.textContent = 'recording needs the live camera'; return; }
    await rec.start(stream);
  }
  recBtn.addEventListener('click', () => {
    if (rec.active()) rec.stop(); else void startRecording();
  });

  // Clip replay: ?clip=/clips/x.mp4[&autostart=1][&autocapture=1] feeds a
  // recording through the live pipeline (camera.ts startClip); with
  // autocapture the debug capture downloads when the clip ends, so a clip
  // becomes an evidence-log fixture with no hands on the cube.
  if (clipUrl) startBtn.textContent = 'Play clip';

  /** Open the camera (or the clip) and run the loop; the Start button and the host's start() both land here. */
  let starting: Promise<void> | null = null; // the camera coming up: a second caller waits for the same start
  function startCapture(): Promise<void> {
    if (running) return Promise.resolve();
    if (starting) return starting;
    starting = (async () => {
      msgEl.textContent = '';
      try {
        if (clipUrl) {
          await camera.startClip(clipUrl, () => {
            if (rec.recording) rec.recording.stoppedAt = Date.now();
            const sol = locked ?? solution;
            msgEl.textContent = `clip ended - ${locked ? 'LOCKED' : (sol?.reason ?? 'no solution')}`;
            // the line tools/solve/replay_clips.py reads off the headless console
            console.log(`CLIP ENDED locked=${!!locked} reason="${sol?.reason ?? ''}" facelets=${sol?.facelets ?? ''} frames=${log.frames} quads=${log.quads.length}`);
            if (params.get('autocapture')) setTimeout(() => captureBtn.click(), 1500);
          });
          // a replayed clip is stamped like a live recording: video time = t - startedAt
          rec.recording = { startedAt: Date.now(), stoppedAt: null, file: clipUrl, mime: 'clip' };
        } else await camera.start();
        running = true;
        startBtn.textContent = 'Stop camera';
        saveBtn.disabled = false;
        captureBtn.disabled = false;
        pauseBtn.disabled = false;
        recBtn.disabled = !!clipUrl;
        if (!clipUrl) fillExposureSelect();
        const gen = ++loopGen;
        vfcSeen = vfcFresh = false;
        armFrameSignal(camera.video, gen);
        requestAnimationFrame((t) => loop(t, gen));
      } catch (err) {
        msgEl.textContent = String(err instanceof Error ? err.message : err);
      } finally { starting = null; }
    })();
    return starting;
  }
  startBtn.addEventListener('click', () => { if (running) stopAuto(); else void startCapture(); });

  $('reset').addEventListener('click', () => {
    newScramble();
    tracker.reset();
    arrivals.length = 0;
    log = emptyLog();
    captureOwed = false;
    detFrame = 0;
    lastCorners.clear();
    lastOffset.clear();
    nthOf.clear();
    knownTracks = new Set();
    solution = null;
    solverError = null;
    locked = null;
    tracking = false;
    movesResult = null;
    lastMovesTs = -Infinity;
    movesTraceEl.textContent = '';
    epochFromT = -Infinity;
    followScan = null;
    relockNote = '';
    followEl.hidden = true;
    logVersion = 0;
    solvedVersion = -1;
    solver.reset();
    pendingPairings.clear();
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
    peakLowEma = 255;
    clipEma = 0;
    exposureStep = null;
    exposureGaveUp = false;
    if (exposureSel.value === 'loop') {
      exposureIdx = -1;
      void camera.resetExposure().then((v) => { if (v !== null) exposureComp = v; });
    }
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
      // the host stage's scramble and hold, what the Check line compared the scan against
      // (null when the sheet was opened without a stage): a replay can redo the comparison
      expected: opts.expected?.() ?? null,
      // solve recording (null when none): the .webm's name and wall-clock span
      // (video time = QuadObs.t - startedAt), the moves the user said they
      // turned, and the resulting state when scramble and moves are both truth
      recording: rec.recording,
      movesApplied: movesText() || null,
      endTruth: endTruth(),
      // the move reader's record and last trace lines, when it ran
      moves: movesResult,
      evidenceLog: log,
      solution: sol ? { ...sol, groups: sol.groups.map((g) => ({ ...g, rotation: [...g.rotation] })), gains: [...sol.gains] } : null,
      params: DEFAULT_PARAMS,
      locked: !!locked,
      stats: diagText(),
      timing: { fps: +fps.fps.toFixed(1), viewDelayFrames: syncSel.value === 'sync' ? Math.ceil(lagMax) : 0, latencyFrames: +lagEma.toFixed(2), lateTicks, samplingMs: +sampler.msEma.toFixed(1), samplingDropped: sampler.dropped, sampleMinMs: SAMPLE_MIN_MS, peak: +peakEma.toFixed(0), clip: +clipEma.toFixed(2), exposureComp, detectEvery: everySel.value, solveMs: +solveEma.toFixed(1), locateMs: +locateEma.toFixed(1), inferMs: +inferEma.toFixed(1), stage1Misses, ticks, ep: models.detector.ep, threads: models.detector.threads, worker: models.detector.proxied, bench: models.detector.benchMs ?? null },
    };
    const post = params.get('post');
    const session = rec.takeSession();
    const sink = session
      // a recording streamed to the rig: the evidence log is the session's, and that closes it
      ? async (json: string) => { await session.evidence(json); await opts.onRecordStop?.(); }
      : post
        ? async (json: string, name: string) => { await fetch(`/__capture?name=${encodeURIComponent(post === '1' ? name : post)}`, { method: 'POST', body: json }); }
        : undefined;
    void captureDebug(lastTick?.result ?? null, models.detector, exportFrame(), 'scan-debug', tickHistory, extra, sink)
      .then((stem) => { msgEl.textContent = `captured ${stem}.{json,png}`; console.log(`CAPTURED ${stem}`); })
      .finally(() => { captureOwed = false; }); // the log is written out: trimming may resume
  });
  exChk.addEventListener('change', () => { solverEl.hidden = !exChk.checked; });

  // Restored settings take effect through the same listeners a click would
  // use; the EP was already honoured by the initial load() above.
  for (const el of restoredControls) if (el !== epSel && !(el instanceof HTMLDetailsElement)) el.dispatchEvent(new Event('change'));

  if (clipUrl && params.get('autostart')) {
    // a muted <video> may autoplay without a gesture; the models must be up first
    const kick = () => { if (models) startCapture(); else setTimeout(kick, 200); };
    setTimeout(kick, 500);
  }

  return {
    // a clip replay is driven by its URL (and the Play clip button), not by the host's tab
    start: () => { renderExpected(locked ?? solution); if (!clipUrl) startCapture(); }, // the host's scramble may have changed
    stop: () => { if (running) stopAuto(); },
    reset: () => { if (!clipUrl) $('reset').click(); },
    following,
    setDocked: (on) => root.classList.toggle('sc-docked', on),
    record: async () => {
      if (rec.active()) return;
      await startCapture();
      if (!running) throw new Error(msgEl.textContent || 'the camera did not start');
      await startRecording();
      if (!rec.active()) throw new Error(msgEl.textContent || 'recording did not start');
    },
    stopRecording: () => rec.stop(),
    recording: () => rec.seconds(),
    popOut: async () => {
      const v = camera.video;
      if (typeof v.requestPictureInPicture !== 'function' || !document.pictureInPictureEnabled) throw new Error('this browser has no Picture-in-Picture');
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    },
  };
}

// The trainer page: mounts every stage into index.html's panels, wires the
// shell, and bridges the scanner - the camera runs only while the scan
// sheet is up, and a locked scan is routed to the stage the cube is at
// (stage.ts) as a scramble in the trainer's own frame (handoff.ts).

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { toWca } from './cube/frame';
import { faceColorName } from './cube/scheme';
import { SOLVED } from './cube/state';
import { mountEO } from './eo/trainer';
import { mountF2L } from './f2l/trainer';
import { followReport, followScramble, relabelTurns, StageFollower } from './follow';
import { invertMap } from './cube/frame';
import { diffFacelets, expectedFacelets, frameMap, relabelMoves, trainerScramble, type Hold, type ScannedCube } from './handoff';
import { mountLL } from './ll/trainer';
import { DrillDriver } from './moves/drive';
import { applySeq, type Move } from './moves/moves';
import type { MoveRecord } from './moves/record';
import { activeTab, closeScan, dockScan, expectedScramble, initShell, scanHooks, scanStarted, showTab, stages, toast } from './shell';
import { bluetoothAvailable, connectCube, type CubeLink } from './smart/adapter';
import { Capture, replay } from './smart/capture';
import { CubeSource } from './smart/source';
import { stageOf, type Stage, type StageReport } from './stage';
import { solveState } from './state';
import { COLOR_NAMES, DEFAULT_SCHEME_NAMES, FACE_ORDER, type ColorName } from './types';
import { mountCubeView } from './ui/cubeview';
import { mountScanner, type ScannerHandle } from './ui/scanner';

const panel = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`index.html is missing #${id}`);
  return e;
};

// the stages: PLL before OCLL (whose Continue button needs it), F2L, then EO
stages.pll = mountLL(panel('pll-panel'), 'pll');
stages.ocll = mountLL(panel('ocll-panel'), 'ocll');
stages.f2l = mountF2L(panel('f2l-panel'));
stages.eo = mountEO(panel('eo-panel'));
initShell();

// ---- the scanner bridge ----
/** The colour the trainer shows in front, as the scanner names colours. */
function frontColour(): ColorName {
  const name = faceColorName('F');
  return (COLOR_NAMES as readonly string[]).includes(name) ? (name as ColorName) : 'blue';
}

/** The current scramble as the scanner should expect it: trainer frame for the check, WCA form to show. */
function expected(): { scramble: string; hold: { down: 'white'; front: ColorName }; shown: string } | null {
  const s = expectedScramble();
  return s ? { scramble: s, hold: { down: 'white', front: frontColour() }, shown: toWca(s) } : null;
}

/** What a stage report says in words, for the toast: the stage to solve, no hints about the state. */
function describe(r: StageReport): string {
  if (r.stage === 'solved') return 'Your cube is solved.';
  if (r.stage === 'eo') return 'EOCross to solve → EO trainer';
  if (r.stage === 'f2l') return 'EOCross done → F2L';
  if (r.stage === 'ocll') return 'F2L done → OCLL';
  return 'Corners oriented → PLL';
}

/** Does the locked scan match the expected scramble? '' when there is nothing to compare. */
function matchText(scan: ScannedCube): string {
  const exp = expected();
  if (!exp) return '';
  try {
    const wrong = diffFacelets(expectedFacelets(exp.scramble, exp.hold, scan.colourOf), scan.facelets.split('')).wrong.length;
    return wrong === 0 ? 'This is the scramble ✓' : `Not the scramble (${wrong} sticker${wrong === 1 ? '' : 's'} differ)`;
  } catch { return ''; }
}

function useInTrainer(scan: ScannedCube): void {
  lastScan = scan;
  let scramble: string;
  try {
    scramble = trainerScramble(scan, { down: 'white', front: frontColour() });
  } catch (err) {
    // a scheme the trainer cannot hold (white and the front colour not adjacent)
    alert(`Cannot show this cube in the trainer: ${err instanceof Error ? err.message : err}`);
    return;
  }
  // was it the scramble the stage asked for? decided before the stage is given the new one; while
  // following, only the first lock is (later ones are re-reads of a cube we have moved the stage along with)
  const match = followLocks++ === 0 ? matchText(scan) : '';
  // the scramble reproduces the scan from solved in the trainer's frame, so the state it reaches
  // is the scanned cube with white as D - what stage.ts reads
  const report = stageOf(new Cube().move(scramble).asString());
  const target = report.stage === 'solved' ? null : report.stage;
  if (target) { stages[target]?.load(scramble); showTab(target); }
  // following: the camera keeps watching from a corner and every lock (this one, or a re-read that
  // corrected the reader) restarts the follow from here; otherwise the scan is done
  if (scanner?.following()) { follower.reset(report.stage); dockScan(true); console.log(`FOLLOW lock ${followLocks} stage=${report.stage}`); } else closeScan();
  toast((match ? `${match} · ` : '') + describe(report));
  window.scrollTo({ top: 0 });
}

// ---- following a solve: the reader's turns move the trainer along ----
const follower = new StageFollower();
let followLocks = 0; // locks since the scan sheet was last opened fresh
let solvedToldFor: string | null = null;
/**
 * The scanner's follow poll: the lock plus the turns read since, as the cube in your hands. When that
 * cube has settled into another stage, that stage opens with it loaded (a stage's picture is the case
 * at hand, so it is loaded once, at the boundary, not on every turn). A solved cube is announced once.
 */
function onFollow(scan: ScannedCube, moves: readonly Move[], record: MoveRecord): void {
  // the live view shows the camera's belief unless a smart cube is connected
  if (!cube) {
    const last = record.items[record.items.length - 1];
    cubeView.setBelief({ facelets: applySeq(scan.facelets, moves), colourOf: scan.colourOf, source: 'camera', lastMove: moves[moves.length - 1] ?? null, lastMoveT: last ? last.t1 : null });
  }
  let scramble: string;
  try { scramble = followScramble(scan, moves, { down: 'white', front: frontColour() }); } catch { return; }
  const report = followReport(scramble);
  const next: Stage | null = follower.update(report.stage);
  if (!next) return;
  if (next === 'solved') {
    const key = `${scan.facelets}:${moves.length}`;
    if (solvedToldFor === key) return;
    solvedToldFor = key;
    const first = record.items[0], last = record.items[record.items.length - 1];
    const secs = first && last ? ((last.t1 - first.t0) / 1000).toFixed(1) : null;
    console.log(`FOLLOW solved after ${moves.length} turns`);
    toast(`Solved ✓ ${moves.length} turns${secs ? ` in ${secs} s` : ''}`);
    return;
  }
  console.log(`FOLLOW stage=${next} after ${moves.length} turns: ${moves.join(' ')}`);
  stages[next]?.load(scramble);
  showTab(next);
  toast(describe(report));
  window.scrollTo({ top: 0 });
}

// For the console and the headless checks: hand a facelet string (the solver's letters, as the lock
// panel prints it) to the trainer as if the scanner had just locked it, standard scheme unless told.
(window.ZZ as { handoff?: unknown }).handoff = (facelets: string, colourOf: Record<string, ColorName> = DEFAULT_SCHEME_NAMES) =>
  solveState(facelets).then((solution) => useInTrainer({ facelets, colourOf: colourOf as ScannedCube['colourOf'], solution }));

let scanner: ScannerHandle | null = null;
let scanned = false; // a scan has been started since the last reset
function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel('scan-panel'), { onUseInTrainer: useInTrainer, expected, onNewScramble: () => stages[activeTab()]?.newScramble(), onFollow, onStopFollow: () => closeScan() });
  return scanner;
}
// the camera runs only while the scan sheet is up. Opening starts a fresh scan unless asked to keep the
// one in progress (the Resume button, which appears once there is something to come back to).
scanHooks.onOpen = (opts) => {
  const s = ensureScanner();
  if (scanned && !opts?.keep) { s.reset(); followLocks = 0; solvedToldFor = null; }
  s.start();
  scanned = true;
  scanStarted();
  panel('scan-dock').hidden = !s.following();
};
scanHooks.onClose = () => { scanner?.stop(); scanner?.setDocked(false); };
scanHooks.onDock = (on) => scanner?.setDocked(on);

// Mount at page load so the detector is loaded by the time the sheet opens; the camera still waits for
// start(). initShell may already have opened the sheet (?tab=scan, the replay tooling's URL).
ensureScanner();
const sheet = panel('scan-sheet');
if (!sheet.hidden) { scanner!.start(); scanned = true; scanStarted(); }

// Free the camera when the page is hidden; take it back when it shows again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner?.stop();
  else if (!sheet.hidden) scanner?.start();
});

// ---- the smart cube and the live view (docs/smart-cube-design.md 3) ----
// DECISION: a smart cube's letters are its colours on the standard scheme (white up, green front,
// red right), which is what a GAN reports; a differently coloured smart cube would need a setting.
const CUBE_COLOURS = DEFAULT_SCHEME_NAMES;
const hold = (): Hold => ({ down: 'white', front: frontColour() });
let cubeLink: CubeLink | null = null;
let cube: CubeSource | null = null;     // the connected cube, or a replayed capture; kept after a disconnect for Save
let lastScan: ScannedCube | null = null;
const driver = new DrillDriver();

function downloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const cubeView = mountCubeView(panel('cube-panel'), {
  bluetooth: bluetoothAvailable(),
  connect: connectSmartCube,
  disconnect: async () => { await cubeLink?.disconnect().catch(() => undefined); },
  resync(how) {
    if (!cube) return;
    if (how === 'solved') cube.resync(SOLVED, 'solved');
    else if (how === 'report') { const r = cube.status().reported; if (r) cube.resync(r, 'report'); }
    else if (lastScan) {
      // the scanned cube, in the smart cube's letters: its trainer scramble read back in those letters
      try { cube.resync(expectedFacelets(trainerScramble(lastScan, hold()), hold(), cube.colourOf), 'scan'); }
      catch (err) { toast(`Cannot use the scan: ${err instanceof Error ? err.message : err}`); }
    }
    refreshCubeView();
  },
  hasScan: () => lastScan !== null,
  save() { if (cube) downloadText(`smart-${cube.capture.header.startedAt}.jsonl`, cube.capture.toJSONL()); },
  hold,
});

function refreshCubeView(): void {
  if (!cube) return;
  const s = cube.status();
  cubeView.setStatus(s, cube.clock.n ? { skew: cube.clock.skewPercent(), n: cube.clock.n } : undefined);
  cubeView.setBelief(s.belief ? { facelets: s.belief, colourOf: cube.colourOf, source: cube.kind, lastMove: s.lastMove, lastMoveT: s.lastMoveT } : null);
}

/**
 * A cube item (a turn, a resync): the live view, then the drill on the open tab - the stage's
 * scramble in the cube's letters is what arms the driver, and the turns after it go into the moves
 * box in the trainer's letters until the stage says they are done.
 */
function onCubeItem(): void {
  if (!cube) return;
  refreshCubeView();
  const tab = activeTab();
  const stage = stages[tab];
  const scr = stage?.scramble() ?? null;
  let expected: string | null = null;
  if (scr !== null) { try { expected = expectedFacelets(scr, hold(), cube.colourOf); } catch { expected = null; } }
  for (const f of driver.step(cube, expected, scr === null ? null : `${tab}:${scr}`)) {
    if (!stage?.feed) break;
    let text: string;
    try { text = relabelTurns(cube.colourOf, f.moves, hold()); } catch { break; }
    if (stage.feed(text, f.t)) { driver.finish(); break; }
  }
}

function useSource(src: CubeSource): void {
  cube?.dispose();
  cube = src;
  src.subscribe(onCubeItem);
  refreshCubeView();
}

async function connectSmartCube(): Promise<void> {
  if (cubeLink) return;
  const src = new CubeSource(CUBE_COLOURS);
  cubeView.setBusy('Pick your cube in the browser dialog…');
  try {
    cubeLink = await connectCube({
      onEvent: (e) => { src.feed(e); if (e.kind === 'disconnect') { cubeLink = null; refreshCubeView(); toast('Smart cube disconnected'); } },
      askMac: async (name) => {
        const v = window.prompt(`The browser could not read the MAC address of ${name}. Type it as the GAN app shows it (like AB:12:34:56:78:9A); it is remembered for this cube.`);
        const mac = v?.trim().toUpperCase().replace(/-/g, ':') ?? '';
        return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
      },
      onStatus: (m) => cubeView.setBusy(m),
    });
  } catch (err) {
    cubeView.setBusy(null);
    toast(`No cube connected: ${err instanceof Error ? err.message : err}`);
    return;
  }
  cubeView.setBusy(null);
  useSource(src);
  toast(`${cubeLink.name} connected`);
}

// while connected: the status line every second, and, once the turns have settled, the cube's own
// report every few seconds so a missed turn shows up as drift instead of a wrong lock later
setInterval(() => { if (cube && cubeLink) refreshCubeView(); }, 1000);
// DECISION: a report every 4 s while idle for 2 s; every turn packet already carries the cube's
// state on GAN cubes, so this only covers turns the app never received.
setInterval(() => {
  if (!cube || !cubeLink) return;
  const s = cube.status();
  if (s.lastMoveT !== null && performance.now() - s.lastMoveT < 2000) return;
  cubeLink.requestFacelets().catch(() => undefined);
}, 4000);

// For the headless checks and the console: play a capture (JSONL text) as if the cube were sending
// it, at `speed` times real time (Infinity = all at once), through the same path as a live cube.
(window.ZZ as { smart?: unknown }).smart = {
  replay(text: string, speed = Infinity) {
    const cap = Capture.parse(text);
    const src = new CubeSource(cap.header.scheme, { kind: 'replay' });
    useSource(src);
    // the capture's clock becomes this page's: its first event lands now
    const offset = performance.now() - (cap.events[0]?.t ?? 0);
    return replay(cap.events, (e) => src.feed({ ...e, t: e.t + offset }), { speed }).done;
  },
  status: () => cube?.status() ?? null,
  items: () => cube?.items() ?? [],
  /** a trainer-frame alg as the smart cube would report its turns (its own letters) */
  cubeAlg: (alg: string): string => {
    const letter = (c: ColorName) => FACE_ORDER.find((f) => CUBE_COLOURS[f] === c)!;
    return relabelMoves(alg, invertMap(frameMap(letter(hold().down), letter(hold().front))));
  },
};

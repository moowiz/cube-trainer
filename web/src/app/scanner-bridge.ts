// The scanner on the page: the camera runs only while the scan sheet is
// up; a locked scan is routed to the stage the cube is at (stage.ts) as a
// scramble in the trainer's own frame (handoff.ts); while a solve is
// followed, the reader's turns move the trainer along and, as a
// MoveSource, feed the open stage whenever no smart cube is connected;
// Record streams to the recording rig when the dev server's sink exists.

/// <reference path="../cubejs.d.ts" />
import Cube from 'cubejs';
import { toWca } from '../cube/frame';
import { followReport, followScramble, StageFollower } from '../follow';
import { diffFacelets, expectedFacelets, trainerScramble, type ScannedCube } from '../handoff';
import type { Move } from '../moves/moves';
import { ReaderSource } from '../moves/readersource';
import type { MoveRecord } from '../moves/record';
import { activeTab, closeScan, dockScan, expectedScramble, scanHooks, scanStarted, showTab, stages, toast } from '../shell';
import { stageOf, type Stage, type StageReport } from '../stage';
import { solveState } from '../state';
import { DEFAULT_SCHEME_NAMES, type ColorName } from '../types';
import { mountScanner, type ScannerHandle } from '../ui/scanner';
import { frontColour, hold, panel, scans } from './context';
import { rig } from './rig';
import { cubeActive } from './smart';
import { setFallback, useSource } from './sources';

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

let scanner: ScannerHandle | null = null;
let scanned = false; // a scan has been started since the last reset
const follower = new StageFollower();
let followLocks = 0; // locks since the scan sheet was last opened fresh
let solvedToldFor: string | null = null;
let reader: ReaderSource | null = null;

function useInTrainer(scan: ScannedCube): void {
  scans.set(scan);
  let scramble: string;
  try {
    scramble = trainerScramble(scan, hold());
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
  if (scanner?.following()) {
    follower.reset(report.stage);
    dockScan(true);
    console.log(`FOLLOW lock ${followLocks} stage=${report.stage}`);
    // the reader as a source: the fallback behind a connected cube, the active source otherwise
    reader ??= new ReaderSource(scan);
    setFallback(reader);
    if (!cubeActive()) useSource(reader);
  } else closeScan();
  toast((match ? `${match} · ` : '') + describe(report));
  window.scrollTo({ top: 0 });
}

/**
 * The scanner's follow poll: the lock plus the turns read since, as the cube in your hands. The reader
 * source hears it first (the live view and the open stage), then the stage change: when the cube
 * has settled into another stage, that stage opens with it loaded (a stage's picture is the case at
 * hand, so it is loaded once, at the boundary, not on every turn). A solved cube is announced once.
 */
function onFollow(scan: ScannedCube, moves: readonly Move[], record: MoveRecord): void {
  reader ??= new ReaderSource(scan);
  setFallback(reader);
  if (!cubeActive()) useSource(reader);
  reader.update(scan, record);
  let scramble: string;
  try { scramble = followScramble(scan, moves, hold()); } catch { return; }
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

function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel('scan-panel'), {
    onUseInTrainer: useInTrainer,
    expected,
    onNewScramble: () => stages[activeTab()]?.newScramble(),
    onFollow,
    onStopFollow: () => closeScan(),
    onRecordStart: () => rig.start(),
    onRecordStop: () => rig.stop(),
  });
  return scanner;
}

export function initScannerBridge(): void {
  // For the console and the headless checks: hand a facelet string (the solver's letters, as the lock
  // panel prints it) to the trainer as if the scanner had just locked it, standard scheme unless told.
  (window.ZZ as { handoff?: unknown }).handoff = (facelets: string, colourOf: Record<string, ColorName> = DEFAULT_SCHEME_NAMES) =>
    solveState(facelets).then((solution) => useInTrainer({ facelets, colourOf: colourOf as ScannedCube['colourOf'], solution }));

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
}

// Bridges the scanner into the trainer page (index.html). The page's inline
// scripts own window.ZZ, the stage tabs and the sheets; we mount the scanner
// in the scan sheet, run the camera only while that sheet is up, and route a
// locked scan to the stage the cube is at (stage.ts), as a scramble in the
// trainer's own frame (white down, its chosen colour in front - handoff.ts).

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { diffFacelets, expectedFacelets, trainerScramble, type ScannedCube } from './handoff';
import { mountLL } from './ll/trainer';
import { stageOf, type StageReport } from './stage';
import { COLOR_NAMES, type ColorName } from './types';
import { mountScanner, type ScannerHandle } from './ui/scanner';

interface ZZBus {
  showTab(t: string): void;
  openScan(opts?: { keep?: boolean }): void;
  closeScan(): void;
  sheetOpen(): boolean;
  expectedScramble?(): string | null;
  toast(msg: string): void;
  eo?: { load(scramble: string): void };
  f2l?: { start(scramble: string, pre: string): void };
  ocll?: { load(scramble: string): void; render(): void };
  pll?: { load(scramble: string): void; render(): void };
  /** The colour scheme setting: which colour a face letter shows (white is always D). */
  faceColorName?(face: 'F' | 'R' | 'B' | 'L'): string;
  faceHex?(face: string): string;
}

declare global {
  interface Window {
    ZZ: ZZBus;
  }
}

// the last-layer stages: PLL first so OCLL's "continue" button has somewhere to go
window.ZZ.pll = mountLL(document.getElementById('pll-panel')!, 'pll', window.ZZ);
window.ZZ.ocll = mountLL(document.getElementById('ocll-panel')!, 'ocll', window.ZZ);

const panel = document.getElementById('scan-panel');
const sheet = document.getElementById('scan-sheet');
if (!panel || !sheet) throw new Error('index.html is missing the scan sheet');

/** The colour the trainer currently shows in front (blue until the setting says otherwise). */
function frontColour(): ColorName {
  const name = window.ZZ.faceColorName?.('F');
  return (COLOR_NAMES as readonly string[]).includes(name ?? '') ? (name as ColorName) : 'blue';
}

/** What a stage report says in words, for the toast: the stage to solve, no hints about the state. */
function describe(r: StageReport): string {
  if (r.stage === 'solved') return 'Your cube is solved.';
  if (r.stage === 'eo') return 'EOCross to solve → EO trainer';
  if (r.stage === 'f2l') return 'EOCross done → F2L';
  if (r.stage === 'ocll') return 'F2L done → OCLL';
  return 'Corners oriented → PLL';
}

/** The current scramble as the scanner should expect it, or null when the open stage has none. */
function expected(): { scramble: string; hold: { down: 'white'; front: ColorName } } | null {
  const s = window.ZZ.expectedScramble?.();
  return s ? { scramble: s, hold: { down: 'white', front: frontColour() } } : null;
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
  const ZZ = window.ZZ;
  let scramble: string;
  try {
    scramble = trainerScramble(scan, { down: 'white', front: frontColour() });
  } catch (err) {
    // a scheme the trainer cannot hold (white and the front colour not adjacent)
    alert(`Cannot show this cube in the trainer: ${err instanceof Error ? err.message : err}`);
    return;
  }
  // was it the scramble the stage asked for? decided before the stage is given the new one
  const match = matchText(scan);
  // the scramble reproduces the scan from solved in the trainer's frame, so the state it reaches
  // is the scanned cube with white as D - what stage.ts reads
  const report = stageOf(new Cube().move(scramble).asString());
  switch (report.stage) {
    case 'eo': ZZ.eo?.load(scramble); ZZ.showTab('eo'); break;
    case 'f2l': ZZ.f2l?.start(scramble, ''); break; // start() shows its own tab
    case 'ocll': ZZ.ocll?.load(scramble); ZZ.showTab('ocll'); break;
    case 'pll': ZZ.pll?.load(scramble); ZZ.showTab('pll'); break;
    case 'solved': break;
  }
  ZZ.closeScan();
  ZZ.toast((match ? match + ' · ' : '') + describe(report));
  window.scrollTo({ top: 0 });
}

let scanner: ScannerHandle | null = null;
let scanned = false; // a scan has been started since the last reset

function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel!, { onUseInTrainer: useInTrainer, expected });
  return scanner;
}

// the camera runs only while the scan sheet is up. Opening starts a fresh scan unless asked to keep the
// one in progress (the Resume button, which appears once there is something to come back to).
const origOpen = window.ZZ.openScan;
const origClose = window.ZZ.closeScan;
function scanStarted(): void {
  scanned = true;
  const resume = document.getElementById('scan-resume');
  if (resume) resume.hidden = false;
}
window.ZZ.openScan = (opts) => {
  origOpen(opts);
  const s = ensureScanner();
  if (scanned && !opts?.keep) s.reset();
  s.start();
  scanStarted();
};
window.ZZ.closeScan = () => { origClose(); scanner?.stop(); };

// Mount at page load so the detector is loaded by the time the sheet opens;
// the camera still waits for start(). The page's startup script may already
// have opened the sheet (?tab=scan, the replay tooling's URL).
ensureScanner();
if (!sheet.hidden) { scanner!.start(); scanStarted(); }

// Free the camera when the page is hidden; take it back when it shows again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner?.stop();
  else if (!sheet.hidden) scanner?.start();
});

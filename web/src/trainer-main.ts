// Bridges the scanner into the trainer page (index.html). The page's inline
// scripts own window.ZZ, the stage tabs and the sheets; we mount the scanner
// in the scan sheet, run the camera only while that sheet is up, and route a
// locked scan to the stage the cube is at (stage.ts), as a scramble in the
// trainer's own frame (white down, its chosen colour in front - handoff.ts).

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { trainerScramble, type ScannedCube } from './handoff';
import { stageOf, type StageReport } from './stage';
import { COLOR_NAMES, type ColorName } from './types';
import { mountScanner, type ScannerHandle } from './ui/scanner';

interface ZZBus {
  showTab(t: string): void;
  openScan(): void;
  closeScan(): void;
  toast(msg: string): void;
  eo?: { load(scramble: string): void };
  f2l?: { start(scramble: string, pre: string): void };
  ocll?: { load(scramble: string): void };
  pll?: { load(scramble: string): void };
  /** The colour scheme setting: which colour a face letter shows (white is always D). */
  faceColorName?(face: 'F' | 'R' | 'B' | 'L'): string;
}

declare global {
  interface Window {
    ZZ: ZZBus;
  }
}

const panel = document.getElementById('scan-panel');
const sheet = document.getElementById('scan-sheet');
if (!panel || !sheet) throw new Error('index.html is missing the scan sheet');

/** The colour the trainer currently shows in front (blue until the setting says otherwise). */
function frontColour(): ColorName {
  const name = window.ZZ.faceColorName?.('F');
  return (COLOR_NAMES as readonly string[]).includes(name ?? '') ? (name as ColorName) : 'blue';
}

/** What a stage report says in words, for the toast. */
function describe(r: StageReport): string {
  if (r.stage === 'solved') return 'Your cube is solved.';
  if (r.stage === 'eo') return r.eoBad ? `${r.eoBad} bad edge${r.eoBad === 1 ? '' : 's'}, cross ${r.cross}/4 → EO trainer` : `EO solved, cross ${r.cross}/4 → EO trainer`;
  if (r.stage === 'f2l') return `EOCross done, ${r.pairs}/4 pairs → F2L`;
  if (r.stage === 'ocll') return 'F2L done → OCLL';
  return 'Corners oriented → PLL';
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
  ZZ.toast(describe(report));
  window.scrollTo({ top: 0 });
}

let scanner: ScannerHandle | null = null;

function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel!, { onUseInTrainer: useInTrainer });
  return scanner;
}

// the camera runs only while the scan sheet is up
const origOpen = window.ZZ.openScan;
const origClose = window.ZZ.closeScan;
window.ZZ.openScan = () => { origOpen(); ensureScanner().start(); };
window.ZZ.closeScan = () => { origClose(); scanner?.stop(); };

// The page's startup script may already have opened the sheet (?tab=scan,
// the replay tooling's URL) before this module ran.
if (!sheet.hidden) ensureScanner().start();

// Free the camera when the page is hidden; take it back when it shows again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner?.stop();
  else if (!sheet.hidden) scanner?.start();
});

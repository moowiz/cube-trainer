// The trainer page: mounts every stage into index.html's panels, wires the
// shell, and bridges the scanner - the camera runs only while the scan
// sheet is up, and a locked scan is routed to the stage the cube is at
// (stage.ts) as a scramble in the trainer's own frame (handoff.ts).

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import { toWca } from './cube/frame';
import { faceColorName } from './cube/scheme';
import { mountEO } from './eo/trainer';
import { mountF2L } from './f2l/trainer';
import { diffFacelets, expectedFacelets, trainerScramble, type ScannedCube } from './handoff';
import { mountLL } from './ll/trainer';
import { activeTab, closeScan, expectedScramble, initShell, scanHooks, scanStarted, showTab, stages, toast } from './shell';
import { stageOf, type StageReport } from './stage';
import { COLOR_NAMES, type ColorName } from './types';
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
  const target = report.stage === 'solved' ? null : report.stage;
  if (target) { stages[target]?.load(scramble); showTab(target); }
  closeScan();
  toast((match ? `${match} · ` : '') + describe(report));
  window.scrollTo({ top: 0 });
}

let scanner: ScannerHandle | null = null;
let scanned = false; // a scan has been started since the last reset
function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel('scan-panel'), { onUseInTrainer: useInTrainer, expected, onNewScramble: () => stages[activeTab()]?.newScramble() });
  return scanner;
}
// the camera runs only while the scan sheet is up. Opening starts a fresh scan unless asked to keep the
// one in progress (the Resume button, which appears once there is something to come back to).
scanHooks.onOpen = (opts) => {
  const s = ensureScanner();
  if (scanned && !opts?.keep) s.reset();
  s.start();
  scanned = true;
  scanStarted();
};
scanHooks.onClose = () => scanner?.stop();

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

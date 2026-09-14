// Bridges the scanner into the ZZ trainer page (index.html). The trainer's
// inline scripts own window.ZZ and the tab nav; we wrap ZZ.showTab so the
// camera only runs while the Scan tab is visible, and hand a locked scan to
// the EO trainer as a scramble in the trainer's own frame (white down, its
// chosen colour in front - handoff.ts).

import { trainerScramble, type ScannedCube } from './handoff';
import { COLOR_NAMES, type ColorName } from './types';
import { mountScanner, type ScannerHandle } from './ui/scanner';

interface ZZBus {
  showTab(t: string): void;
  eo?: { load(scramble: string): void };
  /** The F2L colour scheme: which colour a face letter shows (white is always D). */
  faceColorName?(face: 'F' | 'R' | 'B' | 'L'): string;
}

declare global {
  interface Window {
    ZZ: ZZBus;
  }
}

const panel = document.getElementById('scan-panel');
if (!panel) throw new Error('index.html is missing #scan-panel');

/** The colour the trainer currently shows in front (its F2L setting; blue until it says otherwise). */
function frontColour(): ColorName {
  const name = window.ZZ.faceColorName?.('F');
  return (COLOR_NAMES as readonly string[]).includes(name ?? '') ? (name as ColorName) : 'blue';
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
  window.ZZ.eo?.load(scramble);
  window.ZZ.showTab('eo');
  window.scrollTo({ top: 0 });
}

let scanner: ScannerHandle | null = null;

function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel!, { onUseInTrainer: useInTrainer });
  return scanner;
}

const origShowTab = window.ZZ.showTab.bind(window.ZZ);
window.ZZ.showTab = (t: string) => {
  origShowTab(t);
  if (t === 'scan') {
    ensureScanner().start();
  } else {
    scanner?.stop();
  }
};

// The trainer's startup script may already have shown the Scan tab (from
// the URL or localStorage) before this module ran.
if (!panel.hidden) ensureScanner().start();

// Free the camera when the page is hidden; take it back when it shows again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner?.stop();
  else if (!panel.hidden) scanner?.start();
});

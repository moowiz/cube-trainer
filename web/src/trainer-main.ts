// Bridges the scanner into the ZZ trainer page (index.html). The trainer's
// inline scripts own window.ZZ and the tab nav; we wrap ZZ.showTab so the
// camera only runs while the Scan tab is visible, and hand a locked scan to
// the EO trainer as a scramble (inverse of the solution).

import { mountScanner, type ScannerHandle } from './ui/scanner';

interface ZZBus {
  showTab(t: string): void;
  eo?: { load(scramble: string): void };
}

declare global {
  interface Window {
    ZZ: ZZBus;
  }
}

const panel = document.getElementById('scan-panel');
if (!panel) throw new Error('index.html is missing #scan-panel');

let scanner: ScannerHandle | null = null;

function ensureScanner(): ScannerHandle {
  scanner ??= mountScanner(panel!, {
    onUseInTrainer: (scramble) => {
      // Load the scanned state into the EO trainer: applying the inverse of
      // the solution to a solved cube reproduces the scanned cube.
      window.ZZ.eo?.load(scramble);
      window.ZZ.showTab('eo');
      window.scrollTo({ top: 0 });
    },
  });
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

// The trainer's startup script may already have restored the Scan tab from
// localStorage before this module ran.
if (!panel.hidden) ensureScanner().start();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner?.stop();
  else if (!panel.hidden) scanner?.start();
});

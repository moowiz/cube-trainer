// The trainer page: mounts every stage into index.html's panels, wires the
// shell, and starts the app modules - the sync row, the smart cube and the
// live view, the scanner bridge (docs/housekeeping-plan.md 3). Everything
// with a decision in it lives in src/app/.

import { hold, panel, store } from './app/context';
import { rig } from './app/rig';
import { initRecordButton } from './app/record';
import { initCubeFollow } from './app/cubefollow';
import { initScannerBridge } from './app/scanner-bridge';
import { initSmart } from './app/smart';
import { initSyncUi } from './app/sync-ui';
import { initWake } from './app/wake';
import { initAlgs } from './algs/sheet';
import { mountEO } from './eo/trainer';
import { mountF2L } from './f2l/trainer';
import { mountLL } from './ll/trainer';
import { initShell, stages } from './shell';
import { mountTimer } from './timer/trainer';
import { setAttemptSink } from './ui/drill';

// the stages: PLL before OCLL (whose Continue button needs it), F2L, EO, and the timer
stages.pll = mountLL(panel('pll-panel'), 'pll');
stages.ocll = mountLL(panel('ocll-panel'), 'ocll');
stages.f2l = mountF2L(panel('f2l-panel'));
stages.eo = mountEO(panel('eo-panel'));
stages.solve = mountTimer(panel('solve-panel'), { store, hold, onSolve: (s) => { void rig.current()?.solve(s); } });
initShell();

// the drills' finished attempts go to the store (per-case memory, M11)
setAttemptSink((a) => { void store.then((st) => st.putAttempt(a)); });

initSyncUi();
initSmart();
initScannerBridge();
initCubeFollow();
initRecordButton();
initWake();
initAlgs();

// For the headless checks and the console: what the store holds.
(window.ZZ as { store?: unknown }).store = {
  attempts: () => store.then((st) => st.allAttempts()),
  solves: () => store.then((st) => st.allSolves()),
  sessions: () => store.then((st) => st.allSessions()),
};

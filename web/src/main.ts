// The trainer page: mounts every stage into index.html's panels, wires the
// shell, and starts the app modules - the sync row, the smart cube and the
// live view, the scanner bridge (docs/housekeeping-plan.md 3). Everything
// with a decision in it lives in src/app/.

import { initBootLog, mark } from './debug/boot';
import { hold, panel, store } from './app/context';
import { rig } from './app/rig';
import { initRecordButton } from './app/record';
import { initCubeFollow } from './app/cubefollow';
import { initScannerBridge } from './app/scanner-bridge';
import { initSmart } from './app/smart';
import { initSyncUi } from './app/sync-ui';
import { initWake } from './app/wake';
import { mountEO } from './eo/trainer';
import { mountF2L } from './f2l/trainer';
import { initFavs } from './ll/favs';
import { initNotes } from './ll/notes';
import { mountLL } from './ll/trainer';
import { algsHooks, initShell, stages } from './shell';
import { mountTimer } from './timer/trainer';
import { setAttemptReader, setAttemptSink } from './ui/drill';

initBootLog();
// the favourite algs from the store onto the case table (async: the drills hear it and re-derive their case)
void initFavs(store).then(() => mark('favs read from the store'));
// and what you have written about each alg (shown in the case sheet and under the alg on show)
void initNotes(store).then(() => mark('notes read from the store'));
void store.then(() => mark('store open'));
// the stages: PLL before OCLL (whose Continue button needs it), F2L, EO, and the timer
stages.pll = mountLL(panel('pll-panel'), 'pll'); mark('PLL drill mounted');
stages.ocll = mountLL(panel('ocll-panel'), 'ocll'); mark('OCLL drill mounted');
stages.f2l = mountF2L(panel('f2l-panel')); mark('F2L finder mounted');
stages.eo = mountEO(panel('eo-panel')); mark('EO trainer mounted');
// a solve or a drill attempt done: a good moment for nav.js to look for a new deploy (the chip offers the reload)
const solved = () => document.dispatchEvent(new Event('zz-solved'));
stages.solve = mountTimer(panel('solve-panel'), { store, hold, onSolve: (s) => { void rig.current()?.solve(s); solved(); } }); mark('Solve tab mounted');
// the Algs sheet (the other puzzles' data and the FTO player with it) loads on first open: a phone
// on the Solve tab never needs it (maintenance plan 2.5). Before initShell: ?tab=algs opens it there.
algsHooks.onOpen = () => { void import('./algs/sheet').then((m) => { m.initAlgs(); algsHooks.onOpen(); }); };
initShell(); mark('shell wired');

// the drills' finished attempts go to the store (per-case memory, M11)
setAttemptSink((a) => { void store.then((st) => st.putAttempt(a)); solved(); });
setAttemptReader((stage) => store.then((st) => st.listAttempts(stage)));

initSyncUi(); mark('sync row');
initSmart(); mark('smart cube (the Cube sheet, the auto-connect started)');
initScannerBridge(); mark('scanner bridge (the scan sheet mounted: model load and service worker started)');
initCubeFollow(); mark('cube follow');
initRecordButton(); mark('record button');
initWake(); mark('wake lock');
setTimeout(() => mark('first idle tick after main.ts (the timeouts queued at mount ran: the drills\' first scrambles)'), 0);

// For the headless checks and the console: what the store holds.
(window.ZZ as { store?: unknown }).store = {
  attempts: () => store.then((st) => st.allAttempts()),
  solves: () => store.then((st) => st.allSolves()),
  sessions: () => store.then((st) => st.allSessions()),
  favs: () => store.then((st) => st.listFavs()),
  notes: () => store.then((st) => st.listNotes()),
  putFav: (f: unknown) => store.then((st) => st.putFav(f as Parameters<typeof st.putFav>[0])),
  dirty: () => store.then((st) => st.dirty()),
};

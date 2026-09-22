// Runs cubejs's solve() off the main thread — Cube.initSolver() blocks for
// ~1s on a phone, and solve() itself is only fast once that table is built.
//
// No "webworker" lib in tsconfig, so worker globals are typed loosely via
// `self as any` rather than fighting the DOM `Window` types tsc infers here.

import Cube from './vendor/cubejs';

let solverReady = false;
function ensureSolver(): void {
  if (!solverReady) {
    Cube.initSolver();
    solverReady = true;
  }
}

interface SolveRequest {
  id: number;
  facelets?: string;
  warm?: boolean;
}

const ctx = self as any;  

ctx.onmessage = (ev: MessageEvent) => {
  const { id, facelets, warm } = ev.data as SolveRequest;
  try {
    ensureSolver();
    if (warm) {
      ctx.postMessage({ id, warm: true });
      return;
    }
    const solution = Cube.fromString(facelets!).solve();
    ctx.postMessage({ id, solution });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

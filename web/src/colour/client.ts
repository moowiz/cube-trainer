// Main-thread side of the solver worker. The page keeps its own log (for
// Capture debug) and mirrors every append to the worker; `requestSolve`
// resolves with the worker's Solution and never overlaps two solves. After
// a lock in solve mode, `track` starts the move reader in the worker and
// `requestMoves` reads its record.

import type { MovesResult, SolverRequest, SolverResponse } from './solve.worker';
import type { EvidenceLog, Solution } from './types';
import type { Commitments } from '../moves/anchor';

export class SolverClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (s: Solution) => void } | null = null;
  private pendingMoves: { id: number; resolve: (r: MovesResult | null) => void } | null = null;
  private sent = { quads: 0, pairings: 0, events: 0 };

  private get w(): Worker {
    if (!this.worker) {
      // Vite worker pattern: the URL must be written literally like this.
      this.worker = new Worker(new URL('./solve.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<SolverResponse>) => {
        const msg = ev.data;
        if (msg.type === 'solution') {
          const p = this.pending;
          if (p && msg.id === p.id) { this.pending = null; p.resolve(msg.solution); }
        } else if (msg.type === 'moves') {
          const p = this.pendingMoves;
          if (p && msg.id === p.id) { this.pendingMoves = null; p.resolve(msg.result); }
        }
      };
    }
    return this.worker;
  }

  /** Mirror what the page appended since the last sync. `log` must only ever grow between syncs (trim after). */
  sync(log: EvidenceLog): void {
    const msg: SolverRequest = {
      type: 'append',
      quads: log.quads.slice(this.sent.quads),
      pairings: log.pairings.slice(this.sent.pairings),
      events: log.events.slice(this.sent.events),
      frames: log.frames,
    };
    this.sent = { quads: log.quads.length, pairings: log.pairings.length, events: log.events.length };
    this.w.postMessage(msg);
  }

  /** Account for a trim on the page's log: the worker trims identically, only the sent counters move. */
  trimmed(droppedQuads: number, droppedPairings: number, droppedEvents: number): void {
    this.sent = { quads: this.sent.quads - droppedQuads, pairings: this.sent.pairings - droppedPairings, events: this.sent.events - droppedEvents };
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  requestSolve(): Promise<Solution> {
    if (this.pending) throw new Error('SolverClient: a solve is already pending');
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      const msg: SolverRequest = { type: 'solve', id };
      this.w.postMessage(msg);
    });
  }

  /** Start reading moves from the locked state, over every frame from `fromT` on. */
  track(commit: Commitments, fromT: number): void {
    const msg: SolverRequest = { type: 'track', commit, fromT };
    this.w.postMessage(msg);
  }

  get movesBusy(): boolean {
    return this.pendingMoves !== null;
  }

  /** The reader's current record (null when no tracking is running). */
  requestMoves(): Promise<MovesResult | null> {
    if (this.pendingMoves) throw new Error('SolverClient: a moves request is already pending');
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingMoves = { id, resolve };
      const msg: SolverRequest = { type: 'moves', id };
      this.w.postMessage(msg);
    });
  }

  reset(): void {
    this.sent = { quads: 0, pairings: 0, events: 0 };
    this.pending = null;
    this.pendingMoves = null;
    const msg: SolverRequest = { type: 'reset' };
    this.w.postMessage(msg);
  }
}

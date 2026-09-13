// The solver off the main thread. The worker owns a copy of the evidence
// log (appended incrementally, so a 700 KB log is never re-sent) and runs
// `solve` on request; a failing legality search can take a second on a
// phone, and the frame pump must keep painting through it.

import { emptyLog, trimLog } from './evidence';
import { solve } from './solve';
import type { EvidenceLog, Pairing, QuadObs, Solution, TrackEvent } from './types';

export type SolverRequest =
  | { type: 'append'; quads: QuadObs[]; pairings: Pairing[]; events: TrackEvent[]; frames: number }
  | { type: 'solve'; id: number }
  | { type: 'reset' };

export type SolverResponse = { type: 'solution'; id: number; solution: Solution };

let log: EvidenceLog = emptyLog();

self.onmessage = (ev: MessageEvent<SolverRequest>) => {
  const msg = ev.data;
  if (msg.type === 'reset') {
    log = emptyLog();
  } else if (msg.type === 'append') {
    log.quads.push(...msg.quads);
    log.pairings.push(...msg.pairings);
    log.events.push(...msg.events);
    log.frames = msg.frames;
    trimLog(log);
  } else {
    const solution = solve(log);
    const out: SolverResponse = { type: 'solution', id: msg.id, solution };
    (self as unknown as Worker).postMessage(out);
  }
};

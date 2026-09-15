// The solver off the main thread. The worker owns a copy of the evidence
// log (appended incrementally, so a 700 KB log is never re-sent) and runs
// `solve` on request; a failing legality search can take a second on a
// phone, and the frame pump must keep painting through it.
//
// After a lock in solve mode the page starts the move reader here too:
// every appended frame is anchored and pushed through the reader as it
// arrives (a few ms), and `moves` requests return the current record.

import { emptyLog, trimLog } from './evidence';
import { solveBest } from './solve';
import type { EvidenceLog, Pairing, QuadObs, Solution, TrackEvent } from './types';
import { Anchorer, type Commitments } from '../moves/anchor';
import type { Move } from '../moves/moves';
import type { MoveRecord } from '../moves/record';
import { MoveReader, type FrameTrace } from '../moves/reader';

export type SolverRequest =
  | { type: 'append'; quads: QuadObs[]; pairings: Pairing[]; events: TrackEvent[]; frames: number }
  | { type: 'solve'; id: number }
  | { type: 'track'; commit: Commitments; fromT: number }
  | { type: 'moves'; id: number }
  | { type: 'reset' };

export interface MovesResult {
  record: MoveRecord;
  /** Turns every path in the beam agrees on. */
  committed: Move[];
  /** The last few frames' trace lines. */
  trace: FrameTrace[];
  /** Per live track: what the anchoring believes about it. */
  tracks: { track: number; face: string; k: string; gain: string }[];
  frames: number;
  /** Mean ms per frame in the reader, and in the anchoring. */
  msPerFrame: number;
  anchorMsPerFrame: number;
}

export type SolverResponse =
  | { type: 'solution'; id: number; solution: Solution }
  | { type: 'moves'; id: number; result: MovesResult | null }
  /** solve threw: the page must hear it, or the client waits forever and the scan looks stuck */
  | { type: 'error'; id: number; message: string };

let log: EvidenceLog = emptyLog();
let tracking: { anchorer: Anchorer; reader: MoveReader; fromT: number; anchorMs: number; lastTracks: Set<number> } | null = null;

function trackFrames(quads: readonly QuadObs[], pairings: readonly Pairing[]): void {
  if (!tracking) return;
  const byFrame = new Map<number, { t: number; quads: QuadObs[]; pairings: Pairing[] }>();
  for (const q of quads) {
    if (q.t < tracking.fromT) continue;
    let b = byFrame.get(q.frame);
    if (!b) byFrame.set(q.frame, (b = { t: q.t, quads: [], pairings: [] }));
    b.quads.push(q);
  }
  for (const p of pairings) byFrame.get(p.frame)?.pairings.push(p);
  for (const [frame, b] of [...byFrame.entries()].sort((x, y) => x[0] - y[0])) {
    const t0 = performance.now();
    const f = tracking.anchorer.anchor(frame, b.t, b.quads, b.pairings, tracking.reader.leader.state);
    tracking.anchorMs += performance.now() - t0;
    tracking.lastTracks = new Set(b.quads.map((q) => q.track));
    tracking.reader.push(f);
  }
}

/** The worker's message handler, exported so the protocol is testable without a Worker. */
export function handle(msg: SolverRequest, post: (out: SolverResponse) => void): void {
  if (msg.type === 'reset') {
    log = emptyLog();
    tracking = null;
  } else if (msg.type === 'append') {
    log.quads.push(...msg.quads);
    log.pairings.push(...msg.pairings);
    log.events.push(...msg.events);
    log.frames = msg.frames;
    trimLog(log);
    trackFrames(msg.quads, msg.pairings);
  } else if (msg.type === 'track') {
    const anchorer = new Anchorer(msg.commit);
    tracking = { anchorer, reader: new MoveReader(msg.commit.start, anchorer.model), fromT: msg.fromT, anchorMs: 0, lastTracks: new Set() };
    // frames already in the log from that moment on
    trackFrames(log.quads, log.pairings);
  } else if (msg.type === 'moves') {
    let result: MovesResult | null = null;
    if (tracking) {
      const r = tracking.reader;
      const n = Math.max(1, r.frames.length);
      result = {
        record: r.record(),
        committed: r.committed(),
        trace: r.trace.slice(-8),
        tracks: [...tracking.lastTracks].map((track) => ({ track, ...(tracking!.anchorer.trackInfo(track) ?? { face: '?', k: '?', gain: '?' }) })),
        frames: r.frames.length,
        msPerFrame: r.ms / n,
        anchorMsPerFrame: tracking.anchorMs / n,
      };
    }
    post({ type: 'moves', id: msg.id, result });
  } else {
    try {
      post({ type: 'solution', id: msg.id, solution: solveBest(log) });
    } catch (err) {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
    }
  }
}

if (typeof self !== 'undefined' && typeof (self as { postMessage?: unknown }).postMessage === 'function') {
  self.onmessage = (ev: MessageEvent<SolverRequest>) => handle(ev.data, (out) => (self as unknown as Worker).postMessage(out));
}

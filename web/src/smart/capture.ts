// A smart-cube session as a capture (docs/smart-cube-design.md 7): every
// event the adapter saw, with the host clock on each and the cube's own on
// the turns, as JSONL - a header line, then one event per line, so a
// crash loses nothing and a session becomes a fixture by copying the
// file. `replay` feeds a capture through the same reducer chain as live
// events (web/test/fixtures/smart/).

import type { Move } from '../moves/moves';
import { MOVES } from '../moves/moves';
import type { ColorName, FaceId } from '../types';

export interface Caps { gyroscope: boolean; battery: boolean; facelets: boolean; hardware: boolean; reset: boolean }

export type CaptureEvent =
  | { kind: 'connect'; t: number; name: string; mac: string; protocol: string; caps: Caps }
  | { kind: 'hardware'; t: number; hardwareName?: string; softwareVersion?: string; hardwareVersion?: string; gyroSupported?: boolean }
  /** the cube's own report of its state, in its letters */
  | { kind: 'facelets'; t: number; facelets: string }
  /** a turn; tRaw = the cube's ms counter, tLocal = the library's host stamp (both null on cubes without one) */
  | { kind: 'move'; t: number; move: Move; tRaw: number | null; tLocal: number | null }
  | { kind: 'battery'; t: number; level: number }
  /** the app told the source what the cube is */
  | { kind: 'resync'; t: number; facelets: string; how: 'solved' | 'scan' | 'report' | 'fix' }
  | { kind: 'disconnect'; t: number }
  /** a free note (the latency measurement, a remark) */
  | { kind: 'note'; t: number; text: string };

export interface CaptureHeader {
  version: 1;
  /** wall clock at t0, ms */
  startedAt: number;
  /** host (performance.now) time at startedAt: t - t0 is time since the capture began */
  t0: number;
  /** the cube's letters as colours */
  scheme: Record<FaceId, ColorName>;
  /** the cube's report latency measured on camera, ms, once known */
  latencyMs?: number;
  note?: string;
}

/** A move string as a smart cube reports it, checked against the 18 face turns. */
export function asMove(s: string): Move | null {
  return (MOVES as readonly string[]).includes(s) ? (s as Move) : null;
}

export class Capture {
  readonly events: CaptureEvent[] = [];
  constructor(readonly header: CaptureHeader) {}

  push(e: CaptureEvent): void { this.events.push(e); }

  toJSONL(): string {
    return [JSON.stringify({ header: this.header }), ...this.events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }

  static parse(text: string): Capture {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new Error('empty capture');
    const first = JSON.parse(lines[0]!) as { header?: CaptureHeader };
    if (!first.header || first.header.version !== 1) throw new Error('not a smart-cube capture (no version-1 header)');
    const cap = new Capture(first.header);
    for (const l of lines.slice(1)) cap.push(JSON.parse(l) as CaptureEvent);
    return cap;
  }
}

/**
 * Feed a capture's events to `sink` in order. `speed` scales the recorded
 * gaps (1 = real time, Infinity = all at once, synchronously); `now` and
 * `wait` are for tests. Returns a stop handle.
 */
export function replay(events: readonly CaptureEvent[], sink: (e: CaptureEvent) => void, opts: { speed?: number; wait?: (ms: number) => Promise<void> } = {}): { stop(): void; done: Promise<void> } {
  const speed = opts.speed ?? Infinity;
  let stopped = false;
  if (!Number.isFinite(speed)) {
    for (const e of events) sink(e);
    return { stop: () => undefined, done: Promise.resolve() };
  }
  const wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const done = (async () => {
    let prev: number | null = null;
    for (const e of events) {
      if (stopped) return;
      if (prev !== null && e.t > prev) await wait((e.t - prev) / speed);
      if (stopped) return;
      prev = e.t;
      sink(e);
    }
  })();
  return { stop: () => { stopped = true; }, done };
}

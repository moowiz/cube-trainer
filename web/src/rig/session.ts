// A recording session (docs/smart-cube-design.md 4.2, capture v2): one
// folder under recordings/ per sitting, holding the webcam video as it is
// recorded, the smart cube's events as they arrive, the timer's solves as
// they finish, the colour pipeline's capture at the end, and a meta file
// written at the start and again at the end. Everything goes through one
// ordered RecordingStream, so the files are consistent with each other and
// a crash keeps all but the last chunk. Offline analysis (the fixture
// tool, the dataset export) reads the folder; nothing here is read back
// by the page.
//
//   <session>/meta.json      { version: 2, session, startedAt, t0, device, scheme?, cube?, note?, endedAt?, chunks, solves }
//   <session>/video.webm     MediaRecorder chunks, appended in order (host time of chunk k's arrival in meta.chunkT[k])
//   <session>/cube.jsonl     the smart cube's capture lines (header first), appended as they happen
//   <session>/solves.jsonl   one line per solve the timer saved: { id, when, t0, t1, scramble, time, moves }
//   <session>/evidence.json  the colour pipeline's capture (the evidence log), written at stop

import { RecordingStream } from './stream';

export interface SessionMeta {
  version: 2;
  session: string;
  /** wall clock at t0, ms */
  startedAt: number;
  /** host clock (performance.now) at startedAt */
  t0: number;
  device: string;
  note?: string;
  /** the smart cube, when one was connected */
  cube?: { name: string; protocol: string; scheme: Record<string, string> };
  /** video: host time at which each appended chunk arrived (the recorder's clock) */
  chunkT: number[];
  chunks: number;
  solves: number;
  endedAt?: number;
  /** requests the sink rejected (see RecordingStream.failed) */
  failed?: number;
}

/** A session name from the wall clock: 2026-09-21-1204 (plus seconds when two start in one minute). */
export function sessionName(when = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
}

export class RecordingSession {
  readonly meta: SessionMeta;
  private cubeHeaderSent = false;

  constructor(readonly stream: RecordingStream, opts: { now?: () => number; device?: string; note?: string } = {}) {
    this.meta = {
      version: 2, session: stream.session, startedAt: Date.now(), t0: (opts.now ?? (() => performance.now()))(),
      device: opts.device ?? (typeof navigator !== 'undefined' ? navigator.userAgent : 'node'), note: opts.note,
      chunkT: [], chunks: 0, solves: 0,
    };
  }

  /** Write the meta file (called at the start, and again by stop()). */
  writeMeta(): Promise<void> { return this.stream.put('meta.json', JSON.stringify(this.meta)); }

  /** A MediaRecorder chunk, in order; `t` = host time it arrived. */
  videoChunk(blob: Blob, t: number): Promise<void> {
    this.meta.chunkT.push(Math.round(t));
    this.meta.chunks++;
    return this.stream.append('video.webm', blob);
  }

  /** The smart cube's capture header (once) and each event line, as JSONL. */
  cubeHeader(header: unknown, cube: SessionMeta['cube']): Promise<void> {
    if (this.cubeHeaderSent) return Promise.resolve();
    this.cubeHeaderSent = true;
    this.meta.cube = cube;
    return this.stream.append('cube.jsonl', JSON.stringify({ header }) + '\n');
  }
  cubeEvent(event: unknown): Promise<void> {
    return this.stream.append('cube.jsonl', JSON.stringify(event) + '\n');
  }

  /** A solve the timer saved: its id and window on the host clock, so the video can be cut. */
  solve(rec: { id: string; when: number; t0: number; t1: number; scramble: string; time: number; moves?: unknown }): Promise<void> {
    this.meta.solves++;
    return this.stream.append('solves.jsonl', JSON.stringify(rec) + '\n');
  }

  /** The colour pipeline's capture, at the end. */
  evidence(json: string): Promise<void> { return this.stream.put('evidence.json', json); }

  /** Close the session: the final meta with the end time and the failure count. */
  async stop(): Promise<SessionMeta> {
    await this.stream.flush();
    this.meta.endedAt = Date.now();
    this.meta.failed = this.stream.failed();
    await this.writeMeta();
    await this.stream.flush();
    return this.meta;
  }
}

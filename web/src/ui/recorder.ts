// The solve recorder: MediaRecorder on the live camera stream, so the .webm
// holds exactly the frames the pipeline saw at app resolution. Stopping it
// downloads the video (or, when the recording rig's session streams it, hands
// the chunks to the session as they come) and tells the scan sheet the paired
// debug capture is owed: the evidence log carries the same wall-clock t as
// `recording.startedAt`, so video time is t - startedAt. The clip replay then
// reproduces the session with no hands. The buttons, the moves input and the
// capture itself stay on the scan sheet (ui/scanner.ts); this file owns the
// recorder, its chunks, the elapsed-time ticker and the rig hand-off.

import { downloadBlob } from './download';
import type { RecordingSession } from '../rig/session';

/** A recording's stamp, as the capture JSON carries it (video time = QuadObs.t - startedAt). A clip replay writes one too, with `mime: 'clip'`. */
export interface Recording {
  startedAt: number;
  stoppedAt: number | null;
  file: string;
  mime: string;
}

export interface SolveRecorderEvents {
  /** Record was pressed: the rig's session to stream the video and the capture into, or null to download instead. */
  onRecordStart?: () => Promise<RecordingSession | null>;
  /** Recording began (true) or ended (false): the sheet restyles its Record button and freezes the moves input. */
  onActive: (on: boolean) => void;
  /** The status line: "REC 3 s" every half second while running, then where the video went. */
  onState: (text: string) => void;
  /** The video is out: the sheet fires the paired capture. */
  onStopped: () => void;
}

/** The recording MIME type this browser can produce, or '' for its default. */
function pickMime(): string {
  // DECISION: webm first (Android Chrome, desktop); mp4 is Safari's only option
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class SolveRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer = 0;
  /** The rig's session while one streams this recording; the capture takes it (`takeSession`) and closes it. */
  private session: RecordingSession | null = null;
  /** The current (or last) recording's stamp; null before the first one. */
  recording: Recording | null = null;

  constructor(private readonly events: SolveRecorderEvents) {}

  static supported(): boolean { return typeof MediaRecorder !== 'undefined'; }

  /** A recording is running. */
  active(): boolean { return this.recorder !== null; }

  /** Seconds recorded so far, or null while not recording. */
  seconds(): number | null {
    return this.recorder && this.recording ? (Date.now() - this.recording.startedAt) / 1000 : null;
  }

  /** The rig session streaming this recording, handed over once (the capture closes it). */
  takeSession(): RecordingSession | null {
    const s = this.session;
    this.session = null;
    return s;
  }

  async start(stream: MediaStream): Promise<void> {
    const mime = pickMime();
    const startedAt = Date.now();
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    this.recording = { startedAt, stoppedAt: null, file: `solve-rec-${startedAt}.${ext}`, mime };
    this.chunks = [];
    // the recording rig, when the dev server's sink is there: chunks stream to disk as they come
    this.session = (await this.events.onRecordStart?.()) ?? null;
    const session = this.session;
    // DECISION: 2.5 Mbps at 640x480 - ~20 MB/min, clean enough to re-run the detector on
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    this.recorder = recorder;
    recorder.addEventListener('dataavailable', (e) => {
      if (!e.data.size) return;
      if (session) void session.videoChunk(e.data, performance.now());
      else this.chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => {
      const rec = this.recording!;
      rec.stoppedAt = Date.now();
      if (!session) downloadBlob(rec.file, new Blob(this.chunks, { type: recorder.mimeType || mime || 'video/webm' }));
      this.chunks = [];
      this.recorder = null;
      clearInterval(this.timer);
      this.events.onActive(false);
      const secs = ((rec.stoppedAt - rec.startedAt) / 1000).toFixed(1);
      this.events.onState(session ? `streamed to recordings/${session.stream.session} (${secs} s)` : `saved ${rec.file} (${secs} s)`);
      this.events.onStopped();
    });
    recorder.start(1000);
    this.events.onActive(true);
    const tick = () => { this.events.onState(`REC ${((Date.now() - startedAt) / 1000).toFixed(0)} s`); };
    tick();
    this.timer = window.setInterval(tick, 500);
  }

  stop(): void { this.recorder?.stop(); }
}

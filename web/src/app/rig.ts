// The recording rig's current session (docs/smart-cube-design.md 4.2):
// started by the scan sheet's Record when the dev server's sink is there,
// fed by the recorder (video), the smart cube (events) and the timer
// (solves), stopped with the recording. On the deployed site there is no
// sink, start() says so, and the scan sheet keeps its downloads.

import { RecordingSession, sessionName } from '../rig/session';
import { RecordingStream } from '../rig/stream';

let current: RecordingSession | null = null;
const starts = new Set<(s: RecordingSession) => void>();

export const rig = {
  current: (): RecordingSession | null => current,
  /** Hear every session start (the smart cube writes its capture header then). */
  onStart(cb: (s: RecordingSession) => void): () => void {
    starts.add(cb);
    return () => { starts.delete(cb); };
  },
  /** Start a session if a sink exists; null when there is none. */
  async start(note?: string): Promise<RecordingSession | null> {
    if (current) return current;
    if (!(await RecordingStream.available())) return null;
    const s = new RecordingSession(new RecordingStream(sessionName()), { note });
    current = s;
    await s.writeMeta();
    for (const cb of starts) cb(s);
    return s;
  },
  async stop(): Promise<void> {
    const s = current;
    current = null;
    if (s) await s.stop();
  },
};

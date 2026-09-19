// The header's Record button (docs/smart-cube-design.md 4.2): one press
// records a sitting without the scan sheet - the webcam to video.webm, the
// smart cube's events to cube.jsonl (app/smart.ts hears the session start)
// and the timer's solves to solves.jsonl (main.ts), all on the page's clock.
// The button exists only where the dev server's recording sink answers, so
// the deployed site never shows it. No colour evidence is logged on this
// path: the raw video and the cube's turns are the training material, and
// the scanner's pipeline can be re-run on the video offline.

import { Camera } from '../camera';
import { RecordingStream } from '../rig/stream';
import { toast } from '../shell';
import { rig } from './rig';

// DECISION: the scan sheet's settings - webm/vp9 at 2.5 Mbps, 640x480, one-second chunks
const BITRATE = 2_500_000;
const CHUNK_MS = 1000;

function pickMime(): string {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function initRecordButton(): void {
  const btnEl = document.getElementById('rec-open') as HTMLButtonElement | null;
  const previewEl = document.getElementById('rec-preview');
  if (!btnEl || !previewEl) return;
  const btn = btnEl, preview = previewEl;
  const label = btn.querySelector<HTMLElement>('.txt')!;

  let recorder: MediaRecorder | null = null;
  let startedAt = 0;
  let timer = 0;
  let busy = false;

  const idle = (): void => {
    btn.classList.remove('rec-on');
    label.textContent = ' Record';
    btn.title = 'Record this sitting to recordings/ on the dev server: webcam video, the smart cube\'s turns and the timer\'s solves on one clock';
    preview.hidden = true;
    preview.replaceChildren();
    clearInterval(timer);
  };
  const tick = (): void => { label.textContent = ` REC ${((Date.now() - startedAt) / 1000).toFixed(0)} s`; };

  async function start(): Promise<void> {
    if (rig.current()) { toast('A recording is already running from the scan sheet: stop it there'); return; }
    const cam = new Camera();
    try { await cam.start(); } catch (err) { toast(`No camera: ${err instanceof Error ? err.message : err}`); return; }
    const stream = cam.stream;
    if (!stream || typeof MediaRecorder === 'undefined') { cam.stop(); toast('This browser cannot record video'); return; }
    const session = await rig.start('header Record button: no scanner, no colour evidence');
    if (!session) { cam.stop(); toast('The recording sink is gone: is the dev server still running?'); return; }
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: BITRATE } : undefined);
    rec.addEventListener('dataavailable', (e) => { if (e.data.size) void session.videoChunk(e.data, performance.now()); });
    rec.addEventListener('stop', () => {
      void (async () => {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
        await rig.stop();
        cam.stop();
        recorder = null;
        idle();
        toast(`Recorded ${secs} s to recordings/${session.stream.session}${session.stream.failed() ? ` (${session.stream.failed()} uploads failed)` : ''}`);
        busy = false;
      })();
    });
    rec.start(CHUNK_MS);
    recorder = rec;
    startedAt = Date.now();
    btn.classList.add('rec-on');
    btn.title = 'Stop recording';
    // the live view, so the cube can be kept in frame: a click makes it large, the pop-out button
    // floats it in its own window (Picture-in-Picture) to see the framing clearly
    preview.replaceChildren(cam.video);
    if (typeof cam.video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
      const pip = document.createElement('button');
      pip.type = 'button'; pip.className = 'pip'; pip.textContent = '⧉ pop out'; pip.title = 'Float the live view in its own window';
      pip.addEventListener('click', (e) => {
        e.stopPropagation();
        void (document.pictureInPictureElement ? document.exitPictureInPicture() : cam.video.requestPictureInPicture()).catch((err) => toast(`Cannot pop out: ${err instanceof Error ? err.message : err}`));
      });
      preview.append(pip);
    }
    preview.hidden = false;
    tick();
    timer = window.setInterval(tick, 500);
  }

  btn.addEventListener('click', () => {
    if (busy) return;
    if (recorder) { busy = true; recorder.stop(); return; }
    busy = true;
    void start().finally(() => { busy = false; });
  });

  preview.addEventListener('click', () => preview.classList.toggle('big'));

  idle();
  // only where the sink answers (the dev server); the deployed site never shows the button
  void RecordingStream.available().then((ok) => { btn.hidden = !ok; });
}

// The header's Record button (docs/smart-cube-design.md 4.2): one press
// records a sitting - the webcam to video.webm, the scanner's evidence log
// to evidence.json, the smart cube's events to cube.jsonl (app/smart.ts
// hears the session start) and the timer's solves to solves.jsonl
// (main.ts), all on the page's clock. It records THROUGH the scanner
// (scanner-bridge's `sitting`): the scan sheet comes up docked in the
// corner as the live view, so a recording is always a move-reader fixture
// too, and the same button on the scan sheet does the same thing. The
// button exists only where the dev server's recording sink answers, so the
// deployed site never shows it.

import { RecordingStream } from '../rig/stream';
import { toast } from '../shell';
import { sitting } from './scanner-bridge';

export function initRecordButton(): void {
  const btnEl = document.getElementById('rec-open') as HTMLButtonElement | null;
  const popEl = document.getElementById('rec-pop') as HTMLButtonElement | null;
  if (!btnEl || !popEl) return;
  const btn = btnEl, pop = popEl;
  const label = btn.querySelector<HTMLElement>('.txt')!;
  let busy = false;

  // the label follows the scanner's recorder, whichever button started it
  const paint = (): void => {
    const secs = sitting.seconds();
    btn.classList.toggle('rec-on', secs !== null);
    label.textContent = secs === null ? ' Record' : ` REC ${secs.toFixed(0)} s`;
    btn.title = secs === null
      ? 'Record this sitting to recordings/ on the dev server: webcam video and the scanner\'s evidence, the smart cube\'s turns and the timer\'s solves on one clock. The camera docks in the corner.'
      : 'Stop recording';
    pop.hidden = secs === null;
  };
  setInterval(paint, 500);
  paint();

  btn.addEventListener('click', () => {
    if (busy) return;
    if (sitting.seconds() !== null) { sitting.stop(); paint(); return; }
    busy = true;
    sitting.start().then(paint).catch((err) => toast(`Cannot record: ${err instanceof Error ? err.message : err}`)).finally(() => { busy = false; });
  });
  pop.addEventListener('click', () => { sitting.popOut().catch((err) => toast(`Cannot pop out: ${err instanceof Error ? err.message : err}`)); });

  // only where the sink answers (the dev server); the deployed site never shows the button
  void RecordingStream.available().then((ok) => { btn.hidden = !ok; });
}

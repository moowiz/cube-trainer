// Main-thread side of the sampling worker. Frames are transferred (the
// pixel buffer moves, it is not copied); at most `maxInFlight` frames are
// in the worker at once and further frames are dropped rather than queued,
// so a slow machine loses evidence but never stalls the pump. Responses
// come back in order.

import type { SampleRequest, SampleResponse, SampleTrack } from './sample.worker';

export class SamplerClient {
  private worker: Worker | null = null;
  private inFlight = 0;
  private readonly maxInFlight: number;
  /** Called with each frame's result, in order. */
  onSampled: ((r: SampleResponse) => void) | null = null;
  /** EMA of the worker's per-frame sampling time. */
  msEma = 0;
  dropped = 0;

  constructor(maxInFlight = 2) {
    this.maxInFlight = maxInFlight;
  }

  private get w(): Worker {
    if (!this.worker) {
      // Vite worker pattern: the URL must be written literally like this.
      this.worker = new Worker(new URL('./sample.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<SampleResponse>) => {
        this.inFlight--;
        this.msEma = this.msEma === 0 ? ev.data.ms : 0.2 * ev.data.ms + 0.8 * this.msEma;
        this.onSampled?.(ev.data);
      };
    }
    return this.worker;
  }

  get busy(): boolean {
    return this.inFlight >= this.maxInFlight;
  }

  /** Returns false (and drops the frame) when the worker is saturated. `pixels` is transferred. */
  sample(frame: number, t: number, width: number, height: number, pixels: ArrayBuffer, tracks: SampleTrack[], refine: boolean): boolean {
    if (this.busy) { this.dropped++; return false; }
    this.inFlight++;
    const msg: SampleRequest = { type: 'sample', frame, t, width, height, pixels, tracks, refine };
    this.w.postMessage(msg, [pixels]);
    return true;
  }
}

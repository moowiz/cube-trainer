// A short ring of recent camera frames, each frozen into its own canvas at
// the moment it arrived, with a running index and a timestamp.
//
// Why: the detector takes one inference latency to answer (~30 ms on a
// desktop, ~100 ms on a phone). Drawn over the LIVE video its corners are
// always that much stale, and no filter can hide it. Drawn over the frame
// they were computed on they are exact, so the scan page keeps the last
// few frames here, hands the detector a frozen one, and displays that same
// frame (delayed by the latency) when the answer comes back. The colour
// sampler reads the same frozen pixels, so its patches sit on the stickers
// the corners were found on rather than on wherever the cube has moved to
// since.
//
// Slots are GPU-backed canvases: a frame arrives with one drawImage(video)
// per frame (exactly what drawing the live video to the view cost before),
// and a readback happens only when the sampler asks for pixels.

export interface RingFrame {
  /** Frame counter, monotonic from 0 for the life of the ring. */
  readonly index: number;
  /** The loop timestamp the frame was captured at (performance.now() ms). */
  readonly ts: number;
  readonly canvas: HTMLCanvasElement;
}

interface Slot {
  index: number;
  ts: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class FrameRing {
  private slots: Slot[] = [];
  private _head = -1;

  constructor(readonly size: number) {}

  /** Index of the newest frame, -1 before the first push. */
  get head(): number {
    return this._head;
  }

  /** Freeze the video's current frame into the next slot. */
  push(video: HTMLVideoElement, ts: number): RingFrame {
    const index = ++this._head;
    const at = index % this.size;
    let slot = this.slots[at];
    if (!slot) {
      const canvas = document.createElement('canvas');
      slot = { index, ts, canvas, ctx: canvas.getContext('2d')! };
      this.slots[at] = slot;
    }
    if (slot.canvas.width !== video.videoWidth || slot.canvas.height !== video.videoHeight) {
      slot.canvas.width = video.videoWidth;
      slot.canvas.height = video.videoHeight;
    }
    slot.ctx.drawImage(video, 0, 0);
    slot.index = index;
    slot.ts = ts;
    return slot;
  }

  /** The frame with this index, or null once it has been overwritten (or never existed). */
  get(index: number): RingFrame | null {
    if (index < 0 || index > this._head || this._head - index >= this.size) return null;
    const slot = this.slots[index % this.size];
    return slot && slot.index === index ? slot : null;
  }

  reset(): void {
    this._head = -1;
    for (const s of this.slots) s.index = -1;
  }
}

// getUserMedia setup and frame pump. Rear camera at ~640x480 into a
// <video> element the caller draws onto a canvas; grabFrame() hands back
// the latest frame as ImageData for the rest of the pipeline to consume.
//
// This module never touches the DOM tree — the caller decides whether/where
// to mount `video` (the scanner draws it onto its own canvas instead).

export interface CameraInfo {
  width: number;
  height: number;
}

export class Camera {
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  readonly video: HTMLVideoElement;

  private stream: MediaStream | null = null;
  private _running = false;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', ''); // iOS Safari wants the attribute form too
    this.video.muted = true;
    this.video.autoplay = true;
  }

  get running(): boolean {
    return this._running;
  }

  /** Open the rear camera at ideally 640x480. Resolves once frames are flowing. */
  async start(): Promise<CameraInfo> {
    if (this._running) this.stop();

    if (!Camera.isSupported()) {
      // DECISION: treat "no getUserMedia" as either an insecure context (the
      // overwhelmingly common cause on a phone) or an unsupported browser;
      // both get the same actionable message per spec.
      throw new Error('Camera needs HTTPS — open the https:// dev URL.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
    } catch (err) {
      if (errorName(err) === 'OverconstrainedError') {
        // Retry with the loosest possible constraints.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (err2) {
          throw this.mapError(err2);
        }
      } else {
        throw this.mapError(err);
      }
    }

    this.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        this._running = false;
      });
    }

    this.video.srcObject = stream;

    await new Promise<void>((resolve) => {
      if (this.video.videoWidth > 0) {
        resolve();
        return;
      }
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
    });

    await this.video.play();
    this._running = true;

    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  /** Stop all tracks and detach the stream. Safe to call twice. */
  stop(): void {
    this._running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  /** Latest frame as ImageData at capture resolution, or null before the first frame. */
  grabFrame(): ImageData | null {
    if (!this._running || this.video.videoWidth === 0) return null;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;

    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.ctx) return null;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  private mapError(err: unknown): unknown {
    switch (errorName(err)) {
      case 'NotAllowedError':
        return new Error('Camera permission was denied — allow camera access and reload.');
      case 'NotFoundError':
        return new Error('No camera found on this device.');
      default:
        // Rethrow others as-is (DOMException, Error, or whatever else) —
        // getUserMedia rejects with a DOMException, which callers should see
        // unmodified rather than repackaged into a generic Error.
        return err;
    }
  }
}

// getUserMedia rejects with a DOMException, which — unlike a regular Error —
// does not reliably satisfy `instanceof Error` across browsers, so name
// checks go through this instead of an `instanceof Error` guard.
function errorName(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : undefined;
}

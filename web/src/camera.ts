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

  private stream_: MediaStream | null = null;
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

  /** The live camera stream (null for a clip or before start) - for MediaRecorder. */
  get stream(): MediaStream | null {
    return this.stream_;
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

    this.stream_ = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        this._running = false;
      });
      await requestAutoModes(track);
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

  /**
   * Play a recorded clip through the same <video> instead of the camera:
   * the whole pipeline runs on it exactly as on live frames, which turns a
   * phone recording into an end-to-end test that needs no hands. Resolves
   * once metadata is loaded and playback has started; `onEnded` fires when
   * the clip runs out (no loop - a wrap would teleport the tracker).
   */
  async startClip(url: string, onEnded?: () => void): Promise<CameraInfo> {
    if (this._running) this.stop();
    this.video.srcObject = null;
    this.video.loop = false;
    this.video.src = url;
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(`clip failed to load: ${url}`)); };
      const cleanup = () => { this.video.removeEventListener('loadedmetadata', onLoaded); this.video.removeEventListener('error', onError); };
      this.video.addEventListener('loadedmetadata', onLoaded);
      this.video.addEventListener('error', onError);
    });
    if (onEnded) this.video.addEventListener('ended', onEnded, { once: true });
    await this.video.play();
    this._running = true;
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  /** Stop all tracks and detach the stream. Safe to call twice. */
  stop(): void {
    this._running = false;
    if (this.stream_) {
      for (const track of this.stream_.getTracks()) track.stop();
      this.stream_ = null;
    }
    this.video.srcObject = null;
    if (this.video.src) { this.video.removeAttribute('src'); this.video.load(); }
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

// Ask the camera for continuous auto exposure / white balance / focus.
// getUserMedia leaves the track in whatever mode the driver is sitting in —
// on a desktop webcam that can be a manual exposure left behind by another
// app, which shows up here as a blown-out frame until something (Meet, say)
// explicitly requests auto again. Only modes the track advertises are
// requested; anything unsupported is skipped and failures are non-fatal.
// DECISION: 'continuous' rather than 'single-shot' — the cube moves through
// the frame and each capture needs the metering to follow it.
type AutoMode = 'exposureMode' | 'whiteBalanceMode' | 'focusMode';
const AUTO_MODES: AutoMode[] = ['exposureMode', 'whiteBalanceMode', 'focusMode'];

async function requestAutoModes(track: MediaStreamTrack): Promise<void> {
  if (typeof track.getCapabilities !== 'function') return;
  let caps: Partial<Record<AutoMode, string[]>>;
  try {
    caps = track.getCapabilities() as Partial<Record<AutoMode, string[]>>;
  } catch {
    return;
  }
  const wanted: Partial<Record<AutoMode, string>> = {};
  for (const mode of AUTO_MODES) {
    if (caps[mode]?.includes('continuous')) wanted[mode] = 'continuous';
  }
  if (Object.keys(wanted).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [wanted as MediaTrackConstraintSet] });
  } catch {
    // Some drivers reject the batch; retry one at a time so a single
    // unsupported key doesn't cost us the others.
    for (const [mode, value] of Object.entries(wanted)) {
      try {
        await track.applyConstraints({ advanced: [{ [mode]: value } as MediaTrackConstraintSet] });
      } catch {
        /* leave the driver's mode alone */
      }
    }
  }
}

// getUserMedia rejects with a DOMException, which — unlike a regular Error —
// does not reliably satisfy `instanceof Error` across browsers, so name
// checks go through this instead of an `instanceof Error` guard.
function errorName(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : undefined;
}

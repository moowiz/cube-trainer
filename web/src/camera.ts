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

  /**
   * Step the camera's exposure by `dir` (+1 brighter, -1 darker). Resolves
   * to a description of what was applied, or null when the camera offers
   * no control (a clip, a driver without one) or the value is already at
   * the end of its range. Why: a webcam's metering sees the whole room -
   * an evening session with a ceiling lamp in the frame read the cube at
   * RGB (40, 27, 14) while the lamp was correctly exposed
   * (scan-debug-1789348371807); the cube is the only thing this app cares
   * about, so its brightness drives the exposure.
   *
   * Two controls, in order of preference: `exposureCompensation` (phones:
   * the camera's own metering keeps running, offset by one advertised
   * step); else manual `exposureTime`, ONE level. MEASURED on a LifeCam
   * HD-3000 (no compensation offered): manual times are immediate and
   * stable, the driver rounds a request UP to its power-of-two grid (66 ms
   * became 125 ms and 8 fps), getSettings().exposureTime under auto
   * reports the last manual register, not what auto is using - and auto
   * brightens a dark room mostly with GAIN, which a manual time resets:
   * manual 31 ms read luma 57 where auto read 109 in a lit room, and in
   * the evening room the first version of this ladder turned the picture
   * black. So the only manual level is the longest time that keeps ~15
   * fps (EXPOSURE_TIME_MANUAL), the caller must check that the cube got
   * brighter and call resetExposure() if not, and stepping down goes
   * straight back to auto. Auto is also restored when the camera stops: a
   * manual exposure persists in the driver for the next app otherwise.
   */
  async nudgeExposure(dir: 1 | -1): Promise<string | null> {
    const track = this.stream_?.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return null;
    let caps: ExposureCaps;
    try {
      caps = track.getCapabilities() as ExposureCaps;
    } catch {
      return null;
    }
    const settings = track.getSettings() as ExposureSettings;
    const apply = async (c: Record<string, unknown>): Promise<boolean> => {
      try {
        await track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });
        return true;
      } catch {
        return false;
      }
    };
    const comp = caps.exposureCompensation;
    if (comp && comp.min !== undefined && comp.max !== undefined && comp.max > comp.min) {
      const step = comp.step && comp.step > 0 ? comp.step : (comp.max - comp.min) / 6;
      const current = settings.exposureCompensation ?? 0;
      const next = Math.min(comp.max, Math.max(comp.min, current + dir * step));
      if (Math.abs(next - current) < step / 2) return null;
      return (await apply({ exposureCompensation: next })) ? `ev ${next > 0 ? '+' : ''}${+next.toFixed(2)}` : null;
    }
    const time = caps.exposureTime;
    if (time && time.min !== undefined && time.max !== undefined && caps.exposureMode?.includes('manual')) {
      if (dir < 0) return this.manualExposure ? this.resetExposure() : null;
      if (this.manualExposure) return null; // the one manual level is already in
      if (settings.exposureMode !== 'continuous') return null; // someone else's manual setting: leave it
      const want = Math.max(time.min, Math.min(time.max, EXPOSURE_TIME_MANUAL));
      if (!(await apply({ exposureMode: 'manual', exposureTime: want }))) return null;
      this.manualExposure = true;
      const got = (track.getSettings() as ExposureSettings).exposureTime ?? want;
      if (got > EXPOSURE_TIME_CAP) return this.resetExposure(); // rounded past ~15 fps: not usable
      return `${(got / 10).toFixed(1)} ms`;
    }
    return null;
  }

  private manualExposure = false;

  /** Hand exposure back to the camera's own control. Resolves to 'auto' when it did something. */
  async resetExposure(): Promise<string | null> {
    if (!this.manualExposure) return null;
    this.manualExposure = false;
    const track = this.stream_?.getVideoTracks()[0];
    if (!track) return null;
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] });
      return 'auto';
    } catch {
      return null;
    }
  }

  /** Stop all tracks and detach the stream. Safe to call twice. */
  stop(): void {
    this._running = false;
    if (this.stream_) {
      for (const track of this.stream_.getTracks()) {
        // a manual exposure left behind here would greet the next app as a blown-out frame
        if (this.manualExposure && typeof track.applyConstraints === 'function') {
          track.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
        }
        track.stop();
      }
      this.stream_ = null;
    }
    this.manualExposure = false;
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

interface ExposureCaps {
  exposureCompensation?: { min?: number; max?: number; step?: number };
  exposureTime?: { min?: number; max?: number; step?: number };
  exposureMode?: string[];
}
interface ExposureSettings { exposureCompensation?: number; exposureTime?: number; exposureMode?: string }
// DECISION: manual exposure times are in 100 us units (the spec). The one
// manual level asks for 60 ms: a frame cannot be shorter than its exposure,
// so this holds ~15 fps, the floor the detector needs (a power-of-two
// driver rounds it to 62.5 ms; 66 would round to 125 and 8 fps). Anything
// the driver returns above the cap is refused.
const EXPOSURE_TIME_MANUAL = 600;
const EXPOSURE_TIME_CAP = 660;

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

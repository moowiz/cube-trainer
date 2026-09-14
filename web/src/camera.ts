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
   * Exposure control. Why: a webcam's metering sees the whole room. An
   * evening session with a ceiling lamp in the frame read the cube at RGB
   * (40, 27, 14) (scan-debug-1789348371807); a lit session read the
   * stickers at 228-255 with 17% of their pixels clipped, at 15 fps and
   * motion-blurred, because auto sat at 62.5 ms (solve 1789360518933).
   * The cube is the only thing this app cares about, so its brightness
   * drives the exposure - from scan-main's controller, or by hand from
   * the debug panel.
   *
   * Two controls: `exposureCompensation` where offered (phones: the
   * camera's own metering keeps running, offset by a step) and manual
   * `exposureTime` otherwise. MEASURED on a LifeCam HD-3000 (no
   * compensation): manual times are immediate and stable; the driver
   * rounds a request UP to its power-of-two grid (66 ms became 125 ms and
   * 8 fps); getSettings().exposureTime under auto reports the last manual
   * register, not what auto uses; and auto brightens a dark room with
   * GAIN that a manual time resets - manual 62.5 ms read luma 63 where
   * auto read 105 in the same room. So manual time is a DARKENING lever on
   * such a camera (and a frame-rate one: 31 ms is 30 fps), and any
   * brightening step has to be checked by the caller against what the
   * cube actually reads. Auto is restored when the camera stops: a manual
   * exposure persists in the driver for the next app otherwise.
   */

  /** Manual exposure times this camera can be set to, in ms, longest first (empty: no manual control). */
  exposureLevelsMs(): number[] {
    const caps = this.exposureCaps();
    const time = caps?.exposureTime;
    if (!caps || !time || time.min === undefined || time.max === undefined || !caps.exposureMode?.includes('manual')) return [];
    const out: number[] = [];
    // DECISION: halving steps from the ~15 fps cap down to the camera's
    // floor - the grid the LifeCam rounds to, and a sane ladder elsewhere
    for (let t = Math.min(time.max, EXPOSURE_TIME_CAP); t >= Math.max(time.min, EXPOSURE_TIME_FLOOR); t /= 2) out.push(t / 10);
    return out;
  }

  /** Whether the camera offers exposure compensation (the phone-style control). */
  hasExposureCompensation(): boolean {
    const comp = this.exposureCaps()?.exposureCompensation;
    return !!comp && comp.min !== undefined && comp.max !== undefined && comp.max > comp.min;
  }

  /**
   * Set a manual exposure time (ms), or hand control back to auto with
   * null. Resolves to what the driver reports it took ('31.3 ms',
   * 'auto'), or null when unsupported or refused. A time the driver
   * rounds past the ~15 fps cap is not kept.
   */
  async setExposureTime(ms: number | null): Promise<string | null> {
    const track = this.stream_?.getVideoTracks()[0];
    const caps = this.exposureCaps();
    if (!track || !caps) return null;
    if (ms === null) {
      if (!this.manualExposure) return null;
      this.manualExposure = false;
      return (await this.applyAdvanced(track, { exposureMode: 'continuous' })) ? 'auto' : null;
    }
    const time = caps.exposureTime;
    if (!time || time.min === undefined || time.max === undefined || !caps.exposureMode?.includes('manual')) return null;
    const want = Math.max(time.min, Math.min(time.max, ms * 10));
    if (!(await this.applyAdvanced(track, { exposureMode: 'manual', exposureTime: want }))) return null;
    this.manualExposure = true;
    const got = (track.getSettings() as ExposureSettings).exposureTime ?? want;
    if (got > EXPOSURE_TIME_CAP * 1.05) {
      await this.setExposureTime(null);
      return null;
    }
    return `${(got / 10).toFixed(1)} ms`;
  }

  /** Step exposure compensation by `dir` (+1 brighter); null when unsupported or at the end of the range. */
  async nudgeCompensation(dir: 1 | -1): Promise<string | null> {
    const track = this.stream_?.getVideoTracks()[0];
    const comp = this.exposureCaps()?.exposureCompensation;
    if (!track || !comp || comp.min === undefined || comp.max === undefined || comp.max <= comp.min) return null;
    const step = comp.step && comp.step > 0 ? comp.step : (comp.max - comp.min) / 6;
    const current = (track.getSettings() as ExposureSettings).exposureCompensation ?? 0;
    const next = Math.min(comp.max, Math.max(comp.min, current + dir * step));
    if (Math.abs(next - current) < step / 2) return null;
    return (await this.applyAdvanced(track, { exposureCompensation: next })) ? `ev ${next > 0 ? '+' : ''}${+next.toFixed(2)}` : null;
  }

  /** Hand exposure back to the camera's own control. Resolves to 'auto' when it did something. */
  resetExposure(): Promise<string | null> {
    return this.setExposureTime(null);
  }

  private manualExposure = false;

  private exposureCaps(): ExposureCaps | null {
    const track = this.stream_?.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return null;
    try {
      return track.getCapabilities() as ExposureCaps;
    } catch {
      return null;
    }
  }

  private async applyAdvanced(track: MediaStreamTrack, c: Record<string, unknown>): Promise<boolean> {
    try {
      await track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
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
// DECISION: exposure times are in 100 us units (the spec). The longest
// manual level is 62.5 ms: a frame cannot be shorter than its exposure, so
// this holds ~15 fps, the floor the detector needs (a power-of-two driver
// rounds 66 to 125 ms and 8 fps, so the cap is a grid value and anything
// the driver reports above it is refused). The floor, 3.9 ms, is four
// halvings down - shorter than that a lit room is black.
const EXPOSURE_TIME_CAP = 625;
const EXPOSURE_TIME_FLOOR = 39;

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

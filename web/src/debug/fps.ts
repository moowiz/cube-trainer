// Lightweight fps counter for the debug panel. No DOM, no timers — the
// caller ticks it once per rendered frame and reads back a smoothed value.

export class FpsCounter {
  private lastTime: number | null = null;
  private smoothed = 0;
  private ticks = 0;

  // DECISION: exponential moving average with alpha = 0.1. Small enough that
  // the on-screen number doesn't jitter frame-to-frame, responsive enough to
  // reflect a real fps drop (e.g. the detector kicking in) within ~1s at 30fps.
  private static readonly ALPHA = 0.1;

  /** Call once per rendered frame; `now` defaults to performance.now(). */
  tick(now: number = performance.now()): void {
    if (this.lastTime !== null) {
      const dt = now - this.lastTime;
      if (dt > 0) {
        const instantFps = 1000 / dt;
        this.smoothed =
          this.ticks === 1 ? instantFps : FpsCounter.ALPHA * instantFps + (1 - FpsCounter.ALPHA) * this.smoothed;
      }
    }
    this.lastTime = now;
    this.ticks++;
  }

  /** Smoothed frames-per-second (exponential moving average). 0 until 2 ticks. */
  get fps(): number {
    return this.ticks < 2 ? 0 : this.smoothed;
  }
}

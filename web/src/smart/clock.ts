// The two-clock fit (docs/smart-cube-design.md 3.1): a smart cube stamps
// each turn with its own millisecond counter, which runs visibly fast or
// slow against the host and arrives late by a jittery BLE interval. The
// fix, csTimer's: keep both clocks for every turn and fit a line through
// the last window of pairs, so per-turn timing reads off the cube's clock
// (steady, sub-ms) placed on the host's (comparable with the camera).
//
// Pure; the record keeps raw and host times, so a later refit is possible.
//
// Two things a plain least-squares line gets wrong, seen on the i Carry E
// (2026-09-19): arrivals are only ever LATE (p50 ~20 ms, p90 ~80, max
// ~250, and packets carry two or three turns at once), so the line's
// offset sits a mean lateness behind the send times - the offset is taken
// from the lower envelope of the residuals instead; and over a short burst
// (fifty turns in 30 s) that jitter swings the fitted slope by 0.3%, ten
// times the cube's real skew (0.02%), which is 100 ms at the window's
// ends - so the slope is 1 until the window spans a minute of cube time.

export class ClockFit {
  private xs: number[] = []; // cube ms, unwrapped
  private ys: number[] = []; // host ms
  private lastRaw: number | null = null;
  private wraps = 0;
  private a = 0; // host = a + b * cube
  private b = 1;

  /**
   * @param window how many recent pairs the line is fitted through
   * @param modulus the cube counter's wrap (GAN Gen2 sends 16 bits); 0 for a counter that never wraps
   * @param minSpanMs the slope is fitted only once the window spans this much cube time (1 before)
   */
  constructor(private readonly window = 64, private readonly modulus = 65536, private readonly minSpanMs = 60_000) {}

  get n(): number { return this.xs.length; }

  /** Unwrap a raw counter value against the ones seen so far. */
  private unwrap(raw: number): number {
    if (this.modulus > 0 && this.lastRaw !== null && raw < this.lastRaw - this.modulus / 2) this.wraps++;
    this.lastRaw = raw;
    return raw + this.wraps * this.modulus;
  }

  /** A turn stamped `raw` by the cube arrived at host time `host`. */
  add(raw: number, host: number): void {
    const x = this.unwrap(raw);
    this.xs.push(x); this.ys.push(host);
    if (this.xs.length > this.window) { this.xs.shift(); this.ys.shift(); }
    this.refit();
  }

  private refit(): void {
    const n = this.xs.length;
    if (n === 0) return;
    if (n === 1) { this.b = 1; this.a = this.ys[0]! - this.xs[0]!; return; }
    let sx = 0, sy = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { sx += this.xs[i]!; sy += this.ys[i]!; lo = Math.min(lo, this.xs[i]!); hi = Math.max(hi, this.xs[i]!); }
    const mx = sx / n, my = sy / n;
    if (hi - lo >= this.minSpanMs) {
      let sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { const dx = this.xs[i]! - mx; sxx += dx * dx; sxy += dx * (this.ys[i]! - my); }
      // two turns at the same cube ms: keep the previous slope
      if (sxx > 0) this.b = sxy / sxx;
    } else this.b = 1;
    // DECISION: the offset from the lower envelope of the residuals (their 10th percentile; the
    // minimum with fewer than ten pairs): arrivals are late, never early, so the earliest ones
    // are the send times. The 10th rather than the minimum so one freak early stamp cannot pull it.
    const r = this.xs.map((x, i) => this.ys[i]! - this.b * x).sort((p, q) => p - q);
    this.a = r[n < 10 ? 0 : Math.floor(n * 0.1)]!;
  }

  /** Host time for a raw cube stamp already seen through add() (unwrapped the same way). Null before any pair. */
  fit(raw: number): number | null {
    if (this.n === 0) return null;
    // the stamp was unwrapped when added; redo it against the same wrap count
    const x = raw + this.wraps * this.modulus - (this.lastRaw !== null && raw > this.lastRaw + this.modulus / 2 ? this.modulus : 0);
    return this.a + this.b * x;
  }

  /** How fast the cube's clock runs against the host's, in percent (+ = fast). Zero until two pairs. */
  skewPercent(): number { return this.n < 2 ? 0 : (1 / this.b - 1) * 100; }

  /** The fitted line, for the capture header and the debug panel. */
  line(): { offset: number; slope: number; n: number } { return { offset: this.a, slope: this.b, n: this.n }; }
}

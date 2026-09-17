// The two-clock fit (docs/smart-cube-design.md 3.1): a smart cube stamps
// each turn with its own millisecond counter, which runs visibly fast or
// slow against the host and arrives late by a jittery BLE interval. The
// fix, csTimer's: keep both clocks for every turn and fit a line through
// the last window of pairs, so per-turn timing reads off the cube's clock
// (steady, sub-ms) placed on the host's (comparable with the camera).
//
// Pure; the record keeps raw and host times, so a later refit is possible.

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
   */
  constructor(private readonly window = 64, private readonly modulus = 65536) {}

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
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += this.xs[i]!; sy += this.ys[i]!; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = this.xs[i]! - mx; sxx += dx * dx; sxy += dx * (this.ys[i]! - my); }
    // two turns at the same cube ms: keep the previous slope
    if (sxx > 0) this.b = sxy / sxx;
    this.a = my - this.b * mx;
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

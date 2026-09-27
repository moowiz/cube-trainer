// The one attempt clock every timed mode uses (the Solve tab, the EOCross / OCLL / PLL drills, F2L): armed when
// the cube reaches the scramble (inspection counts from here), started by the first turn or by a press's release,
// stopped by the mode's own end (solved, EOCross done, the four pairs in) or by a press. It keeps the stamps -
// on the host clock the source stamps its turns with (performance.now for a press) - and hands the rail its view;
// what an attempt means (a stored solve, a drill attempt) stays with the mode.
//
// The press rule (the Solve tab's, user 2026-09-17): down on a running clock stops it and its release does
// nothing; otherwise down holds (the digits go green) and the release starts it, so a thumb resting on the
// phone never starts a solve.

import type { RailClock } from '../shell';
import { inspectOn } from './inspect';

export interface ClockOpts {
  /** the mode shows the inspection counting up while armed (the Solve tab, EOCross); the inspection setting has the last word */
  inspection?: boolean;
  /** a press may hold / start now (the Solve tab: only with a scramble on show) */
  canStart?(): boolean;
}

export class AttemptClock {
  /** the cube reached the scramble, host ms */
  armedAt: number | null = null;
  /** the same moment on this page's clock (a replayed cube stamps its turns on its own), for the count shown */
  private armedShown: number | null = null;
  startAt: number | null = null;
  endAt: number | null = null;
  held = false;
  private swallow = false;

  constructor(private readonly opts: ClockOpts = {}) {}

  /** Everything cleared: a new case, Escape. */
  reset(): void { this.armedAt = this.armedShown = this.startAt = this.endAt = null; this.held = this.swallow = false; }
  /** The cube reached the scramble at `t`: ready, the inspection counting. */
  arm(t: number): void { this.reset(); this.armedAt = t; this.armedShown = performance.now(); }
  /** Back at the scramble mid-attempt: the attempt starts over, still armed (from the first time it got there). */
  back(t: number): void { this.startAt = this.endAt = null; this.armedAt ??= t; this.armedShown ??= performance.now(); }
  /** A turn at `t`: the first one starts the clock (true when this one did). */
  turn(t: number): boolean {
    if (this.startAt !== null) return false;
    this.startAt = t; this.endAt = null;
    return true;
  }
  start(t = performance.now()): void { this.startAt = t; this.endAt = null; }
  stop(t = performance.now()): void { if (this.running()) this.endAt = t; }
  /** Start when stopped, stop when running (a Start / Stop button). */
  toggle(): void { if (this.running()) this.stop(); else this.start(); }

  armed(): boolean { return this.armedAt !== null && this.startAt === null; }
  running(): boolean { return this.startAt !== null && this.endAt === null; }
  /** ms from the start to the end (or to now while running); null never started */
  elapsed(now = performance.now()): number | null { return this.startAt === null ? null : (this.endAt ?? now) - this.startAt; }
  /** ms from the scramble on the cube to the first turn, when both happened */
  inspection(): number | undefined { return this.armedAt !== null && this.startAt !== null ? Math.max(0, Math.round(this.startAt - this.armedAt)) : undefined; }
  /** ms from the first turn to the end, when it ended */
  execution(): number | undefined { return this.startAt !== null && this.endAt !== null ? Math.max(0, Math.round(this.endAt - this.startAt)) : undefined; }
  /** the inspection is being shown right now */
  inspecting(): boolean { return !!this.opts.inspection && inspectOn() && this.armed() && this.armedShown !== null; }
  /** ms of inspection so far, as shown */
  inspectingMs(): number { return this.armedShown === null ? 0 : performance.now() - this.armedShown; }

  /**
   * Space or a press, down or up. Returns what it did: 'stop' (down on a running clock: the mode ends the attempt),
   * 'start' (the release after a hold), 'hold', or null.
   */
  press(down: boolean): 'stop' | 'start' | 'hold' | null {
    if (down) {
      if (this.running()) { this.stop(); this.swallow = true; return 'stop'; }
      if (this.held || (this.opts.canStart && !this.opts.canStart())) return null;
      this.held = true;
      return 'hold';
    }
    if (this.swallow) { this.swallow = false; return null; }
    if (!this.held) return null;
    this.held = false;
    if (this.opts.canStart && !this.opts.canStart()) return null;
    this.start();
    return 'start';
  }
  /** A press lost (the pointer cancelled). */
  cancelPress(): void { this.held = this.swallow = false; }

  /** What the rail draws: held, running, ready (with the inspection when shown), or the last time. */
  view(): RailClock {
    if (this.held) return { ms: 0, phase: 'held' };
    if (this.running()) return { ms: this.elapsed(), phase: 'running' };
    if (this.armed()) return this.inspecting() ? { ms: this.inspectingMs(), phase: 'ready', inspecting: true } : { ms: 0, phase: 'ready' };
    return { ms: this.elapsed(), phase: 'idle' };
  }
}

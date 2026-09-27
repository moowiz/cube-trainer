// The one attempt clock (src/ui/clock.ts) the Solve tab, the drills and F2L share: armed at the scramble,
// the first turn starts it, the mode or a press stops it, and the press rule (release starts, a press stops
// and its release does nothing).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptClock } from '../src/ui/clock';
import { setInspect } from '../src/ui/inspect';

describe('AttemptClock', () => {
  let now = 0;
  beforeEach(() => { now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now); setInspect(true); });

  it('armed, the first turn, the end: inspection and execution from the source stamps', () => {
    const c = new AttemptClock();
    c.arm(5000);
    expect(c.view().phase).toBe('ready');
    expect(c.turn(8200)).toBe(true);
    expect(c.turn(8400)).toBe(false); // only the first turn starts it
    c.stop(12200);
    expect(c.inspection()).toBe(3200);
    expect(c.execution()).toBe(4000);
    expect(c.view()).toEqual({ ms: 4000, phase: 'idle' });
  });

  it('back at the scramble: the attempt starts over, the inspection still from the first arming', () => {
    const c = new AttemptClock();
    c.arm(1000); c.turn(2000); c.back(3000);
    expect(c.armed()).toBe(true);
    c.turn(4000);
    expect(c.inspection()).toBe(3000);
  });

  it('the inspection shows counting only when the mode asks for it and the switch is on', () => {
    const c = new AttemptClock({ inspection: true });
    c.arm(0);
    now = 3500;
    expect(c.view()).toEqual({ ms: 2500, phase: 'ready', inspecting: true });
    setInspect(false);
    expect(c.view()).toEqual({ ms: 0, phase: 'ready' });
    setInspect(true);
    expect(new AttemptClock().view().inspecting).toBeUndefined();
  });

  it('the press rule: down holds, the release starts, a press stops and its release does nothing', () => {
    const c = new AttemptClock();
    expect(c.press(true)).toBe('hold');
    expect(c.view().phase).toBe('held');
    now = 2000;
    expect(c.press(false)).toBe('start');
    now = 5000;
    expect(c.press(true)).toBe('stop');
    expect(c.press(false)).toBeNull();
    expect(c.elapsed()).toBe(3000);
  });

  it('a press cannot start with nothing to solve', () => {
    let can = false;
    const c = new AttemptClock({ canStart: () => can });
    expect(c.press(true)).toBeNull();
    can = true;
    expect(c.press(true)).toBe('hold');
    can = false;
    expect(c.press(false)).toBeNull();
    expect(c.running()).toBe(false);
  });
});

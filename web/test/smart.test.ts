// The smart cube half that needs no cube (src/smart/): the two-clock fit,
// the belief reducer, the capture round trip, and a capture replayed
// through the same code a live session runs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySeq, parseAlg } from '../src/moves/moves';
import { movesOf } from '../src/moves/source';
import { Capture, replay, type CaptureEvent } from '../src/smart/capture';
import { ClockFit } from '../src/smart/clock';
import { CubeSource } from '../src/smart/source';
import { EMPTY_STATUS, reduce, REPORT_SETTLE_MS, statusAfter } from '../src/smart/belief';
import { DEFAULT_SCHEME_NAMES } from '../src/types';
import { SOLVED } from '../src/cube/state';
import { fixture as fixturePath } from './helpers';

const FIXTURE = fixturePath('smart', 'synthetic-session.jsonl');
const fixture = () => Capture.parse(readFileSync(FIXTURE, 'utf8'));

describe('ClockFit', () => {
  it('recovers a cube clock that runs fast against the host, through BLE jitter, once the window spans a minute', () => {
    // true turn times on the host over two minutes, the cube's stamps at 2% fast from an offset, arrivals late by a jittery interval
    const truth = [2000, 12180, 22350, 32500, 42700, 52900, 63050, 73200, 83400, 93550, 103700, 123900];
    const late = [12, 25, 8, 30, 15, 20, 10, 18, 22, 9, 27, 14];
    const fit = new ClockFit();
    truth.forEach((t, i) => fit.add(Math.round((t - 1500) * 1.02), t + late[i]!));
    expect(fit.skewPercent()).toBeCloseTo(2, 0);
    // fitted times sit on the truth plus the least lateness (arrivals are only ever late), not on the jittery arrivals
    const least = Math.min(...late);
    truth.forEach((t) => {
      const f = fit.fit(Math.round((t - 1500) * 1.02))!;
      expect(Math.abs(f - (t + least))).toBeLessThan(15);
    });
  });

  it('over a short burst the slope stays 1: BLE jitter would swing it by more than the cube ever drifts', () => {
    const truth = [2000, 2180, 2350, 2500, 2700, 2900, 3050, 3200, 3400, 3550, 3700, 3900];
    const late = [12, 225, 8, 30, 15, 120, 10, 18, 22, 9, 27, 14];
    const fit = new ClockFit();
    truth.forEach((t, i) => fit.add(t - 1500, t + late[i]!));
    expect(fit.line().slope).toBe(1);
    expect(fit.skewPercent()).toBe(0);
    truth.forEach((t) => expect(Math.abs(fit.fit(t - 1500)! - (t + 8))).toBeLessThan(2));
  });

  it('unwraps a 16-bit counter', () => {
    const fit = new ClockFit(64, 65536);
    // 65500 -> 300 is +336 ms through the wrap
    fit.add(65000, 100_000); fit.add(65500, 100_500); fit.add(300, 100_836); fit.add(800, 101_336);
    expect(fit.line().slope).toBeCloseTo(1, 2);
    expect(fit.fit(800)!).toBeCloseTo(101_336, -1);
  });

  it('is null before any pair and identity-ish after one', () => {
    const fit = new ClockFit();
    expect(fit.fit(10)).toBeNull();
    fit.add(1000, 5000);
    expect(fit.fit(1100)).toBe(5100);
    expect(fit.skewPercent()).toBe(0);
  });
});

describe('the belief reducer', () => {
  const connect: CaptureEvent = { kind: 'connect', t: 0, name: 'x', mac: 'm', protocol: 'p', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } };
  const moves = parseAlg("R U R' U'");

  it('starts from the first report and follows the turns', () => {
    let s = reduce(EMPTY_STATUS, connect);
    expect(s.belief).toBeNull();
    s = reduce(s, { kind: 'facelets', t: 10, facelets: SOLVED });
    expect(s.belief).toBe(SOLVED);
    moves.forEach((m, i) => { s = reduce(s, { kind: 'move', t: 100 + i * 100, move: m, tRaw: null, tLocal: null }); });
    expect(s.belief).toBe(applySeq(SOLVED, moves));
    expect(s.moves).toBe(4);
    expect(s.movesSinceSync).toBe(4);
    expect(s.lastMove).toBe("U'");
  });

  it('a matching report confirms; a mismatch after the turns settle is drift; a mismatch right after a turn is inconclusive', () => {
    let s = reduce(reduce(EMPTY_STATUS, connect), { kind: 'facelets', t: 10, facelets: SOLVED });
    s = reduce(s, { kind: 'move', t: 1000, move: 'R', tRaw: null, tLocal: null });
    // the cube's report from before the R reached us: not drift yet
    const early = reduce(s, { kind: 'facelets', t: 1000 + REPORT_SETTLE_MS - 50, facelets: SOLVED });
    expect(early.agree).toBeNull();
    const late = reduce(s, { kind: 'facelets', t: 1000 + REPORT_SETTLE_MS + 50, facelets: SOLVED });
    expect(late.agree).toBe(false);
    const ok = reduce(s, { kind: 'facelets', t: 1100, facelets: applySeq(SOLVED, ['R']) });
    expect(ok.agree).toBe(true);
    expect(ok.movesSinceSync).toBe(0);
  });

  it('a resync replaces the belief', () => {
    let s = reduce(reduce(EMPTY_STATUS, connect), { kind: 'facelets', t: 10, facelets: SOLVED });
    s = reduce(s, { kind: 'move', t: 100, move: 'F', tRaw: null, tLocal: null });
    s = reduce(s, { kind: 'resync', t: 200, facelets: SOLVED, how: 'solved' });
    expect(s.belief).toBe(SOLVED);
    expect(s.movesSinceSync).toBe(0);
    expect(s.moves).toBe(1);
  });
});

describe('a capture', () => {
  it('round-trips through JSONL', () => {
    const cap = fixture();
    expect(cap.header.version).toBe(1);
    expect(cap.events).toHaveLength(13);
    const again = Capture.parse(cap.toJSONL());
    expect(again.header).toEqual(cap.header);
    expect(again.events).toEqual(cap.events);
  });

  it('replayed all at once reaches the state the cube reported, in agreement', () => {
    const cap = fixture();
    const s = statusAfter(cap.events);
    expect(s.connected).toBe(false);
    expect(s.battery).toBe(87);
    expect(s.moves).toBe(8);
    expect(s.belief).toBe(applySeq(SOLVED, parseAlg("R U R' U' R U R' U'")));
    expect(s.agree).toBe(true);
  });

  it('replayed at speed keeps the recorded gaps', async () => {
    const cap = fixture();
    const waits: number[] = [];
    const seen: CaptureEvent[] = [];
    const r = replay(cap.events, (e) => seen.push(e), { speed: 10, wait: async (ms) => { waits.push(ms); } });
    await r.done;
    expect(seen).toEqual(cap.events);
    expect(waits[0]).toBeCloseTo(20, 5); // 1000 -> 1200 at 10x
    expect(waits.reduce((a, b) => a + b)).toBeCloseTo(400, 5);
  });
});

describe('CubeSource', () => {
  it('turns capture events into MoveSource items, keeps the fit, and knows its state', () => {
    const cap = fixture();
    const src = new CubeSource(DEFAULT_SCHEME_NAMES, { kind: 'replay', now: () => 0 });
    const heard: string[] = [];
    src.subscribe((it) => heard.push(it.kind));
    replay(cap.events, (e) => src.feed(e));
    expect(heard[0]).toBe('resync'); // the first report is where everything starts
    expect(movesOf(src.items())).toEqual(parseAlg("R U R' U' R U R' U'"));
    expect(src.state()).toBe(src.status().reported);
    expect(src.status().agree).toBe(true);
    expect(src.clock.n).toBe(8);
    expect(src.clock.skewPercent()).toBe(0); // the fixture's 2% is invisible over its two seconds
    const first = src.items().find((it) => it.kind === 'move');
    expect(first && first.kind === 'move' ? first.tRaw : null).toBe(540);
    // what it recorded is what it was fed, plus nothing
    expect(src.capture.events).toEqual(cap.events);
  });

  it('a resync from the app goes into the capture and out as an item', () => {
    const src = new CubeSource(DEFAULT_SCHEME_NAMES, { now: () => 42 });
    src.resync(SOLVED, 'scan');
    expect(src.state()).toBe(SOLVED);
    expect(src.items()).toEqual([{ kind: 'resync', t: 42, facelets: SOLVED, how: 'scan' }]);
    expect(src.capture.events[0]).toEqual({ kind: 'resync', t: 42, facelets: SOLVED, how: 'scan' });
  });
});

// The first real capture (GAN356 i Carry E on desktop Chrome, 2026-09-19):
// 240 turns, 220 of the cube's own reports, two timed solves from the Solve
// tab. What a healthy session looks like, so a regression in the adapter,
// the reducer or the clock fit shows up against real events.
describe('the first real capture', () => {
  const REAL = fixturePath('smart', 'icarrye-first.jsonl');
  const SOLVES = fixturePath('smart', 'icarrye-first.solves.jsonl');
  const real = () => Capture.parse(readFileSync(REAL, 'utf8'));
  interface Solve { id: string; t0: number; t1: number; scramble: string; moves: { m: string; t: number }[] }
  const solves = (): Solve[] => readFileSync(SOLVES, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Solve);

  it('every report the cube sent agrees with the belief, and the session ends solved', () => {
    const cap = real();
    let s = EMPTY_STATUS;
    let reports = 0;
    for (const e of cap.events) {
      s = reduce(s, e);
      if (e.kind === 'facelets') { reports++; expect(s.agree, `report ${reports} at ${e.t}`).toBe(true); }
    }
    expect(reports).toBe(220);
    expect(s.moves).toBe(240);
    expect(s.belief).toBe(SOLVED);
  });

  it("the cube's clock fits the host's within a percent", () => {
    const src = new CubeSource(DEFAULT_SCHEME_NAMES, { kind: 'replay', now: () => 0 });
    replay(real().events, (e) => src.feed(e));
    expect(src.status().agree).toBe(true);
    expect(src.clock.n).toBeGreaterThan(30);
    expect(Math.abs(src.clock.skewPercent())).toBeLessThan(1);
  });

  it('each timed solve starts at its scramble, is exactly the turns the cube sent in its window, and ends solved', () => {
    const cap = real();
    const turns = cap.events.filter((e): e is Extract<CaptureEvent, { kind: 'move' }> => e.kind === 'move');
    const all = solves();
    expect(all).toHaveLength(2);
    for (const so of all) {
      let s = EMPTY_STATUS;
      for (const e of cap.events) { if (e.t >= so.t0) break; s = reduce(s, e); }
      expect(s.belief).toBe(applySeq(SOLVED, parseAlg(so.scramble)));
      const window = turns.filter((m) => m.t >= so.t0 && m.t <= so.t1).map((m) => m.move);
      expect(window).toEqual(so.moves.map((m) => m.m));
      expect(applySeq(s.belief!, window)).toBe(SOLVED);
    }
  });
});

// Fifty-odd turns as fast as they go (design doc 8 item 4): 98 turns in 29 s, arriving two or
// three to a BLE packet. Nothing missed: the reports agree all the way and the cube ends where
// it began (every block is an identity).
describe('the fast-turn capture', () => {
  const FAST = fixturePath('smart', 'icarrye-fast.jsonl');

  it('loses no turn at speed: every report agrees and the cube is back at its start', () => {
    const cap = Capture.parse(readFileSync(FAST, 'utf8'));
    const reports = cap.events.filter((e): e is Extract<CaptureEvent, { kind: 'facelets' }> => e.kind === 'facelets');
    let s = EMPTY_STATUS;
    for (const e of cap.events) { s = reduce(s, e); if (e.kind === 'facelets') expect(s.agree).toBe(true); }
    expect(s.moves).toBe(98);
    expect(reports.length).toBe(31);
    expect(s.belief).toBe(reports[0]!.facelets);
    // the turns as recorded: four blocks of six sexy moves, one with an overshoot put right
    const turns = cap.events.filter((e) => e.kind === 'move').map((e) => (e as { move: string }).move).join(' ');
    expect(turns).toBe([
      "R U R' U' ".repeat(6).trim(), "L' U L U' ".repeat(6).trim(),
      "R U R' U' R U R' U' R U U U' R' U' R U R' U' R U R' U' R U R' U'", "L B L' B' ".repeat(6).trim(),
    ].join(' '));
  });

  it('packets carrying several turns still fit the cube clock', () => {
    const src = new CubeSource(DEFAULT_SCHEME_NAMES, { kind: 'replay', now: () => 0 });
    replay(Capture.parse(readFileSync(FAST, 'utf8')).events, (e) => src.feed(e));
    expect(Math.abs(src.clock.skewPercent())).toBeLessThan(1);
    // arrivals sit at or after the fitted send time, never far ahead of it
    const turns = src.items().filter((it): it is Extract<typeof it, { kind: 'move' }> => it.kind === 'move');
    const ahead = turns.map((m) => src.clock.fit(m.tRaw!)! - m.t);
    expect(Math.max(...ahead)).toBeLessThan(100);
  });
});

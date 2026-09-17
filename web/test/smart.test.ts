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
import { EMPTY_STATUS, reduce, REPORT_SETTLE_MS, statusAfter } from '../src/smart/sync';
import { DEFAULT_SCHEME_NAMES } from '../src/types';
import { SOLVED } from '../src/cube/state';

const FIXTURE = new URL('./fixtures/smart/synthetic-session.jsonl', import.meta.url);
const fixture = () => Capture.parse(readFileSync(FIXTURE, 'utf8'));

describe('ClockFit', () => {
  it('recovers a cube clock that runs fast against the host, through BLE jitter', () => {
    // true turn times on the host, the cube's stamps at 2% fast from an offset, arrivals late by a jittery interval
    const truth = [2000, 2180, 2350, 2500, 2700, 2900, 3050, 3200, 3400, 3550, 3700, 3900];
    const late = [12, 25, 8, 30, 15, 20, 10, 18, 22, 9, 27, 14];
    const fit = new ClockFit();
    truth.forEach((t, i) => fit.add(Math.round((t - 1500) * 1.02), t + late[i]!));
    expect(fit.skewPercent()).toBeCloseTo(2, 0);
    // fitted times sit on the truth plus the mean lateness, not on the jittery arrivals
    const mean = late.reduce((a, b) => a + b) / late.length;
    truth.forEach((t) => {
      const f = fit.fit(Math.round((t - 1500) * 1.02))!;
      expect(Math.abs(f - (t + mean))).toBeLessThan(12);
    });
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
    expect(src.clock.skewPercent()).toBeCloseTo(2, 0);
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

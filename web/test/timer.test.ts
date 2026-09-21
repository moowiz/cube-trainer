// The timer's pure parts (src/timer/) and the local store (src/store/local.ts
// on fake-indexeddb): averages the way timers count them, csTimer's file
// both ways, scramble following, and records that survive a reopen and
// merge by the later edit.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { tokens } from '../src/cube/alg';
import { fromWca, toWca } from '../src/cube/frame';
import { faceColorName } from '../src/cube/scheme';
import { SOLVED, state } from '../src/cube/state';
import { relabelTurns, type Hold } from '../src/handoff';
import type { Move } from '../src/moves/moves';
import { solveState } from '../src/state';
import { applySeq, parseAlg } from '../src/moves/moves';
import { openStore } from '../src/store/local';
import { effectiveTime, newId, type SessionRecord, type SolveRecord } from '../src/store/types';
import { exportCsTimer, importCsTimer } from '../src/timer/cstimer';
import { syncChip, syncWarning } from '../src/store/sync';
import { averageOf, bestAverageOf, formatTime, meanOf, sessionStats, trimOf } from '../src/timer/stats';
import { WINDOWS, countStep, graphSvg, layoutGraph, percentile, rolling, secondsLabel, secondsStep } from '../src/timer/graph';
import { ScrambleTracker } from '../src/timer/track';
import { SESSION_GAP_MS } from '../src/timer/trainer';
import { autoSessionName, fullOf, gapOf, spanOf, stampOf } from '../src/timer/when';

describe('averages', () => {
  it('ao5 drops the best and the worst', () => {
    expect(averageOf([10_000, 12_000, 11_000, 20_000, 9_000], 5)).toBe(11_000);
    expect(averageOf([10_000, 12_000, 11_000, 20_000], 5)).toBeUndefined();
  });
  it('a DNF is the worst; two in an ao5 is a DNF', () => {
    expect(averageOf([10_000, 12_000, 11_000, null, 9_000], 5)).toBe(11_000);
    expect(averageOf([10_000, null, 11_000, null, 9_000], 5)).toBeNull();
  });
  it('big averages trim 5% each end', () => {
    expect(trimOf(5)).toBe(1); expect(trimOf(12)).toBe(1); expect(trimOf(50)).toBe(3); expect(trimOf(100)).toBe(5);
    const fifty = Array.from({ length: 50 }, (_, i) => 10_000 + i * 100);
    // drop the 3 lowest and 3 highest of 10000..14900: mean of 10300..14600
    expect(averageOf(fifty, 50)).toBeCloseTo((10_300 + 14_600) / 2, 6);
  });
  it('mo3 is a plain mean and any DNF makes it DNF', () => {
    expect(meanOf([9_000, 10_000, 11_000], 3)).toBe(10_000);
    expect(meanOf([9_000, null, 11_000], 3)).toBeNull();
  });
  it('the best ao5 in a session is the lowest window', () => {
    const t = [20_000, 20_000, 20_000, 20_000, 20_000, 10_000, 10_000, 10_000, 10_000, 30_000];
    expect(bestAverageOf(t, 5)).toBe(10_000);
    const s = sessionStats(t);
    expect(s.n).toBe(10); expect(s.best).toBe(10_000); expect(s.worst).toBe(30_000); expect(s.bestAo5).toBe(10_000);
    expect(s.ao12).toBeUndefined();
  });
  it('formats', () => {
    expect(formatTime(12_345)).toBe('12.35');
    expect(formatTime(62_345)).toBe('1:02.35');
    expect(formatTime(null)).toBe('DNF');
    expect(formatTime(undefined)).toBe('-');
  });
  it('a +2 adds two seconds; a DNF has no time', () => {
    expect(effectiveTime({ time: 10_000, penalty: 2 })).toBe(12_000);
    expect(effectiveTime({ time: 10_000, penalty: -1 })).toBeNull();
  });
});

describe('the graph', () => {
  const ramp = Array.from({ length: 20 }, (_, i) => 20_000 - i * 500); // 20.0 down to 10.5
  it('a running average starts once there are n and follows the list', () => {
    const r = rolling(ramp, 5);
    expect(r.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(r[4]).toBe(averageOf(ramp.slice(0, 5), 5));
    expect(r[19]).toBe(averageOf(ramp, 5));
    expect(rolling([null, null, 10_000, 11_000, 12_000], 5)[4]).toBeNull();
  });
  it('ticks are clean numbers with a cap on how many', () => {
    expect(secondsStep(10, 5)).toBe(2); expect(secondsStep(200, 6)).toBe(60); expect(secondsStep(0.4, 6)).toBe(0.1);
    expect(countStep(20, 8)).toBe(5); expect(countStep(1000, 8)).toBe(200);
    expect(secondsLabel(12)).toBe('12'); expect(secondsLabel(65)).toBe('1:05'); expect(secondsLabel(12.5)).toBe('12.5');
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3); expect(percentile([], 0.5)).toBeUndefined();
  });
  it('lays every solve out inside the plot and draws the lines that are on', () => {
    const g = layoutGraph(ramp, { width: 400, height: 280, shown: ['ao5', 'ao12'] });
    expect(g.points).toHaveLength(20);
    for (const p of g.points) { expect(p.x).toBeGreaterThanOrEqual(g.x0); expect(p.x).toBeLessThanOrEqual(g.x1); expect(p.y).toBeGreaterThanOrEqual(g.y0); expect(p.y).toBeLessThanOrEqual(g.y1); }
    expect(g.lines.map((l) => l.key)).toEqual(['ao5', 'ao12']);
    expect(g.best?.t).toBe(10_500);
    expect(g.lo).toBeLessThanOrEqual(10_500); expect(g.hi).toBeGreaterThanOrEqual(20_000);
    // later solves are further right, faster ones lower
    expect(g.points[19]!.x).toBeGreaterThan(g.points[0]!.x);
    expect(g.points[19]!.y).toBeGreaterThan(g.points[0]!.y);
    expect(Object.keys(g.series)).toEqual(WINDOWS.map((w) => w.key));
    expect(g.series.ao50![19]).toBeUndefined();
  });
  it('one huge solve is pinned at the top, not the scale', () => {
    const times = [...Array.from({ length: 60 }, () => 15_000), 120_000];
    const g = layoutGraph(times, { width: 400, height: 280, shown: ['ao5'] });
    expect(g.hi).toBeLessThan(60_000);
    const last = g.points[g.points.length - 1]!;
    expect(last.clipped).toBe(true); expect(last.y).toBe(g.y0);
    // the ao5 with the outlier in it is still on the scale
    expect(g.hi).toBeGreaterThanOrEqual(g.series.ao5![60] as number);
  });
  it('DNFs are left out of the dots and break a line', () => {
    const ten = Array.from({ length: 5 }, () => 10_000);
    const times: (number | null)[] = [...ten, null, null, ...ten];
    const g = layoutGraph(times, { width: 400, height: 280, shown: ['ao5'] });
    expect(g.points).toHaveLength(10);
    // one DNF in an ao5 is the trimmed worst; two make it a DNF and the line stops until they are out of the window
    expect(g.lines[0]!.d.split('M')).toHaveLength(3);
  });
  it('end labels never sit on each other and the svg names each line', () => {
    const flat = Array.from({ length: 120 }, () => 12_000);
    const g = layoutGraph(flat, { width: 500, height: 280, shown: WINDOWS.map((w) => w.key) });
    const ys = g.endLabels.map((l) => l.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(13);
    const svg = graphSvg(g);
    for (const w of WINDOWS) expect(svg).toContain(`>${w.key}</text>`);
    expect(svg).toContain('best 12.00');
    expect(layoutGraph([], { width: 300, height: 200, shown: [] }).points).toEqual([]);
  });
  it('x ticks can be the days, one where the day changes and none on top of another', () => {
    const days = ramp.map((_, i) => (i < 8 ? '1 Sep' : i < 9 ? '2 Sep' : i < 14 ? '3 Sep' : '4 Sep'));
    const g = layoutGraph(ramp, { width: 400, height: 280, shown: [], days });
    expect(g.xTicks.map((t) => t.label)).toEqual(['1 Sep', '2 Sep', '4 Sep']); // 3 Sep would sit on 2 Sep
    for (let i = 1; i < g.xTicks.length; i++) expect(g.xTicks[i]!.x - g.xTicks[i - 1]!.x).toBeGreaterThanOrEqual(76);
    expect(graphSvg(g)).toContain('text-anchor="start">1 Sep');
  });
});

describe('csTimer files', () => {
  const file = JSON.stringify({
    session1: [[[0, 12345], "R U R' U'", '', 1700000000], [[2000, 15000], 'F2 B2', 'slow', 1700000100], [[-1, 9000], 'L', '', 1700000200]],
    session3: [[[0, 20000], 'D', '', 1700001000]],
    properties: { sessionData: JSON.stringify({ '1': { name: 'main', rank: 1 }, '3': { name: 'OH', rank: 2 } }) },
  });
  it('imports sessions by name with penalties and dates', () => {
    const { sessions, solves } = importCsTimer(file, 5);
    expect(sessions.map((s) => s.name)).toEqual(['main', 'OH']);
    expect(solves).toHaveLength(4);
    expect(solves[0]).toMatchObject({ scramble: "R U R' U'", time: 12345, penalty: 0, when: 1700000000_000, source: 'import' });
    expect(solves[1]).toMatchObject({ time: 15000, penalty: 2, comment: 'slow' });
    expect(solves[2]).toMatchObject({ penalty: -1 });
    expect(solves[3].session).toBe(sessions[1].id);
  });
  it('exports what it imported', () => {
    const { sessions, solves } = importCsTimer(file, 5);
    const back = JSON.parse(exportCsTimer(sessions, solves));
    expect(back.session1).toEqual([[[0, 12345], "R U R' U'", '', 1700000000], [[2000, 15000], 'F2 B2', 'slow', 1700000100], [[-1, 9000], 'L', '', 1700000200]]);
    expect(back.session2).toEqual([[[0, 20000], 'D', '', 1700001000]]);
    expect(JSON.parse(back.properties.sessionData)).toEqual({ '1': { name: 'main', rank: 1 }, '2': { name: 'OH', rank: 2 } });
  });
});

describe('ScrambleTracker', () => {
  it('follows the prefixes, notices a wrong turn, and the undo', () => {
    const tr = new ScrambleTracker("R U2 F'");
    expect(tr.status(SOLVED)).toEqual({ applied: 0, total: 3, off: false, matched: false, half: false });
    expect(tr.status(applySeq(SOLVED, ['R']))).toMatchObject({ applied: 1, off: false, half: false });
    // U2 done as two quarter turns, either way round: halfway is still on the scramble
    expect(tr.status(applySeq(SOLVED, parseAlg('R U')))).toMatchObject({ applied: 1, off: false, half: true });
    expect(tr.status(applySeq(SOLVED, parseAlg("R U'")))).toMatchObject({ applied: 1, off: false, half: true });
    // a different face is a wrong turn, halfway or not: undo back to the last prefix
    expect(tr.status(applySeq(SOLVED, parseAlg('R F')))).toMatchObject({ applied: 1, off: true, half: false });
    expect(tr.status(applySeq(SOLVED, parseAlg('R U U')))).toMatchObject({ applied: 2, off: false, half: false });
    expect(tr.status(applySeq(SOLVED, parseAlg('R U2 F')))).toMatchObject({ applied: 2, off: true, half: false });
    expect(tr.status(applySeq(SOLVED, parseAlg("R U2 F'")))).toEqual({ applied: 3, total: 3, off: false, matched: true, half: false });
    expect(tr.target()).toBe(applySeq(SOLVED, parseAlg("R U2 F'")));
  });
});

describe('the local store', () => {
  const solve = (over: Partial<SolveRecord> = {}): SolveRecord => ({ id: newId(), puzzle: '333', session: 's1', when: Date.now(), scramble: 'R', time: 10_000, penalty: 0, source: 'keyboard', editedAt: 1, ...over });
  const session: SessionRecord = { id: 's1', puzzle: '333', name: 'main', createdAt: 1, editedAt: 1 };

  it('keeps solves per session, marks them dirty, survives a reopen', async () => {
    const name = `t-${Math.random()}`;
    let st = await openStore(name);
    await st.putSession(session);
    const a = solve({ when: 100 }), b = solve({ when: 50 }), gone = solve({ when: 75, deleted: true });
    await st.putSolve(a); await st.putSolve(b); await st.putSolve(gone);
    expect((await st.listSolves('s1')).map((s) => s.id)).toEqual([b.id, a.id]);
    expect((await st.allSolves())).toHaveLength(3);
    expect((await st.dirty()).length).toBe(4);
    await st.clearDirty('solves', a.id);
    expect((await st.dirty()).length).toBe(3);
    st.close();
    st = await openStore(name);
    expect((await st.listSessions()).map((s) => s.name)).toEqual(['main']);
    expect((await st.getSolve(a.id))?.time).toBe(10_000);
    st.close();
  });

  it('a remote record wins only when it was edited later, and never marks dirty', async () => {
    const st = await openStore(`t-${Math.random()}`);
    const a = solve({ editedAt: 10 });
    await st.putSolve(a);
    await st.clearDirty('solves', a.id);
    expect(await st.applyRemote('solves', { ...a, penalty: 2, editedAt: 5 })).toBe('kept');
    expect((await st.getSolve(a.id))?.penalty).toBe(0);
    expect(await st.applyRemote('solves', { ...a, penalty: 2, editedAt: 20 })).toBe('applied');
    expect((await st.getSolve(a.id))?.penalty).toBe(2);
    expect(await st.dirty()).toEqual([]);
    let heard = 0;
    st.onChange(() => heard++);
    await st.setMeta('lastPulled/solves', 123);
    expect(await st.getMeta('lastPulled/solves')).toBe(123);
    await st.putSolve(solve());
    expect(heard).toBe(1);
    st.close();
  });
});

// The Solve tab's "Show a solution": cubejs solves the state in its own letters; the moves are
// shown in WCA notation like the scramble. Two paths: the smart cube's belief (its letters,
// coloured `colourOf`, through the trainer's letters) and, without a cube, the scramble's state.
describe('a solution on demand', () => {
  const hold = { down: 'white', front: faceColorName('F') } as Hold;   // what the app's hold() gives: the scheme's front
  const gan = { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' } as const;
  const applyWca = (wcaAlg: string) => applySeq(SOLVED, parseAlg(wcaAlg));

  it("solves the cube's belief and calls the turns as WCA does", async () => {
    // the GAN's letters are WCA's (white up, red right, green front), so the cube's state is the WCA-frame state
    const belief = applySeq(SOLVED, parseAlg("R U F' L2 B D"));
    const sol = tokens(await solveState(belief)) as Move[];
    const wca = toWca(relabelTurns(gan, sol, hold));
    expect(applySeq(belief, parseAlg(wca))).toBe(SOLVED);
    expect(sol.length).toBeLessThanOrEqual(22);
  });

  it("solves the scramble's state without a cube", async () => {
    const scramble = "D' L2 U F2 D' L2 D2 B2 L2 U2 B2 R' F2 U R' B' F U2 R' D2 B' U'";
    const sol = await solveState(state(fromWca(scramble)));   // trainer letters in, trainer letters out
    const wca = toWca(sol);
    expect(applySeq(applyWca(scramble), parseAlg(wca))).toBe(SOLVED);
  });
});

describe('when a solve was', () => {
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi, 5).getTime();   // local time, so the test is timezone-proof
  const now = at(2026, 9, 20, 16, 0);

  it('stamps today with the clock and other days with the day', () => {
    expect(stampOf(at(2026, 9, 20, 14, 32), now)).toBe('14:32');
    expect(stampOf(at(2026, 9, 19, 14, 32), now)).toBe('19 Sep');
    expect(stampOf(at(2025, 9, 19), now)).toBe('19 Sep 2025');
    expect(fullOf(at(2026, 9, 19, 14, 32))).toBe('Sat 19 Sep 2026, 14:32:05');
  });

  it('spans a session by its first and last solve', () => {
    expect(spanOf(at(2026, 9, 20, 14, 32), at(2026, 9, 20, 16, 5), now)).toBe('20 Sep 14:32–16:05');
    expect(spanOf(at(2026, 9, 19), at(2026, 9, 19), now)).toBe('19 Sep');
    expect(spanOf(at(2026, 9, 17), at(2026, 9, 19), now)).toBe('17–19 Sep');
    expect(spanOf(at(2026, 8, 28), at(2026, 9, 3), now)).toBe('28 Aug – 3 Sep');
  });

  it('names an automatic session by the clock and says how long the gap was', () => {
    expect(autoSessionName(at(2026, 9, 20, 9, 7))).toBe('2026-09-20 09:07');
    expect(gapOf(45 * 60_000)).toBe('45 min');
    expect(gapOf(SESSION_GAP_MS + 15 * 60_000)).toBe('2 h 15 min');
    expect(gapOf(3 * 24 * 3600_000)).toBe('3 days');
  });
});

describe('the sync warning', () => {
  const base = { pushed: 0, pulled: 0, pending: 0 } as const;
  const t = 1_000_000;

  it('is quiet when sync is off, loading, or up to date', () => {
    expect(syncWarning({ ...base, status: 'off' }, t)).toBeNull();
    expect(syncWarning({ ...base, status: 'loading' }, t)).toBeNull();
    expect(syncWarning({ ...base, status: 'synced' }, t)).toBeNull();
    expect(syncWarning({ ...base, status: 'synced', pending: 3, pendingSince: t - 5_000 }, t)).toBeNull();   // a push is in flight
  });

  it('shows syncing while a push is in flight, whatever the time since the last one', () => {
    expect(syncChip({ ...base, status: 'synced', pending: 1, pendingSince: t - 2_000 }, t)).toEqual({ kind: 'syncing', text: '1 record on the way to the cloud' });
    expect(syncChip({ ...base, status: 'synced' }, t)).toBeNull();
    expect(syncChip({ ...base, status: 'synced', pending: 1, pendingSince: t - 90_000 }, t)?.kind).toBe('warn');
    expect(syncChip({ ...base, status: 'off', pending: 1, pendingSince: t - 90_000 }, t)).toBeNull();
  });

  it('warns when signed out, on an error, and when edits sit unacknowledged', () => {
    expect(syncWarning({ ...base, status: 'signed-out' }, t)).toMatch(/signed out/);
    expect(syncWarning({ ...base, status: 'error', error: 'permission-denied' }, t)).toBe('Sync failed: permission-denied');
    expect(syncWarning({ ...base, status: 'synced', pending: 2, pendingSince: t - 90_000 }, t)).toMatch(/^2 records not synced yet\./);
    expect(syncWarning({ ...base, status: 'synced', pending: 1, pendingSince: t - 5_000 }, t, false)).toMatch(/1 record not synced yet \(offline\)/);
  });
});

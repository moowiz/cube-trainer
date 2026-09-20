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

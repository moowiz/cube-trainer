// The timer's pure parts (src/timer/) and the local store (src/store/local.ts
// on fake-indexeddb): averages the way timers count them, csTimer's file
// both ways, scramble following, and records that survive a reopen and
// merge by the later edit.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SOLVED } from '../src/cube/state';
import { applySeq, parseAlg } from '../src/moves/moves';
import { openStore } from '../src/store/local';
import { effectiveTime, newId, type SessionRecord, type SolveRecord } from '../src/store/types';
import { exportCsTimer, importCsTimer } from '../src/timer/cstimer';
import { averageOf, bestAverageOf, formatTime, meanOf, sessionStats, trimOf } from '../src/timer/stats';
import { ScrambleTracker } from '../src/timer/track';

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
    expect(tr.status(SOLVED)).toEqual({ applied: 0, total: 3, off: false, matched: false });
    expect(tr.status(applySeq(SOLVED, ['R']))).toMatchObject({ applied: 1, off: false });
    // U2 done as two quarter turns: half way is off, then back on
    expect(tr.status(applySeq(SOLVED, parseAlg('R U')))).toMatchObject({ applied: 1, off: true });
    expect(tr.status(applySeq(SOLVED, parseAlg('R U U')))).toMatchObject({ applied: 2, off: false });
    expect(tr.status(applySeq(SOLVED, parseAlg('R U2 F')))).toMatchObject({ applied: 2, off: true });
    expect(tr.status(applySeq(SOLVED, parseAlg("R U2 F'")))).toEqual({ applied: 3, total: 3, off: false, matched: true });
    expect(tr.target()).toBe(applySeq(SOLVED, parseAlg("R U2 F'")));
  });
});

describe('the local store', () => {
  const solve = (over: Partial<SolveRecord> = {}): SolveRecord => ({ id: newId(), session: 's1', when: Date.now(), scramble: 'R', time: 10_000, penalty: 0, source: 'keyboard', editedAt: 1, ...over });
  const session: SessionRecord = { id: 's1', name: 'main', createdAt: 1, editedAt: 1 };

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

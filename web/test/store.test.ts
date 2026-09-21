// The local store's puzzle field and attempts collection (docs/housekeeping-plan.md
// item 4, docs/smart-cube-design.md 7): drill attempts persisted like solves, and
// every record - old or new - reads a puzzle id even though only 3x3 exists yet.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/local';
import { newId, type AttemptRecord, type SessionRecord, type SolveRecord } from '../src/store/types';

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  id: newId(), puzzle: '333', stage: 'eo', when: 100, scramble: 'R', moves: "R'",
  time: 900, assisted: false, source: 'typed', editedAt: 1, ...over,
});

describe('attempts', () => {
  it('lists by stage oldest first, filters by since, leaves tombstones out, allAttempts keeps them', async () => {
    const st = await openStore(`t-${Math.random()}`);
    const a = attempt({ id: newId(1), when: 100 });
    const b = attempt({ id: newId(2), when: 200 });
    const c = attempt({ id: newId(3), stage: 'pll', when: 150, source: 'cube', assisted: true });
    const gone = attempt({ id: newId(4), when: 300, deleted: true });
    await st.putAttempt(a); await st.putAttempt(b); await st.putAttempt(c); await st.putAttempt(gone);

    expect((await st.listAttempts('eo')).map((x) => x.id)).toEqual([a.id, b.id]);
    expect((await st.listAttempts()).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
    expect((await st.listAttempts('eo', 150)).map((x) => x.id)).toEqual([b.id]);
    expect((await st.allAttempts()).map((x) => x.id).sort()).toEqual([a.id, b.id, c.id, gone.id].sort());
    st.close();
  });

  it('marks attempts dirty and clearDirty drops them', async () => {
    const st = await openStore(`t-${Math.random()}`);
    const a = attempt();
    await st.putAttempt(a);
    expect(await st.dirty()).toEqual([{ coll: 'attempts', id: a.id }]);
    await st.clearDirty('attempts', a.id);
    expect(await st.dirty()).toEqual([]);
    st.close();
  });

  it('applyRemote on attempts keeps the later edit', async () => {
    const st = await openStore(`t-${Math.random()}`);
    const a = attempt({ editedAt: 10 });
    await st.putAttempt(a);
    await st.clearDirty('attempts', a.id);
    expect(await st.applyRemote('attempts', { ...a, time: 999, editedAt: 5 })).toBe('kept');
    expect((await st.getAttempt(a.id))?.time).toBe(900);
    expect(await st.applyRemote('attempts', { ...a, time: 999, editedAt: 20 })).toBe('applied');
    expect((await st.getAttempt(a.id))?.time).toBe(999);
    st.close();
  });
});

describe('the puzzle field', () => {
  it('a version-1 database upgrades in place: old rows keep their data, gain puzzle, attempts appears', async () => {
    const name = `t-${Math.random()}`;
    // Build a database exactly as the pre-puzzle, pre-attempts schema would have.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        const solves = db.createObjectStore('solves', { keyPath: 'id' });
        solves.createIndex('session', 'session');
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('dirty', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const t = db.transaction(['solves', 'sessions'], 'readwrite');
        t.objectStore('solves').put({
          id: 'old-solve', session: 'old-session', when: 1, scramble: 'R', time: 9000,
          penalty: 0, source: 'keyboard', editedAt: 1,
        } satisfies Omit<SolveRecord, 'puzzle'>);
        t.objectStore('sessions').put({
          id: 'old-session', name: 'legacy', createdAt: 1, editedAt: 1,
        } satisfies Omit<SessionRecord, 'puzzle'>);
        t.oncomplete = () => { db.close(); resolve(); };
        t.onerror = () => reject(t.error);
      };
    });

    const st = await openStore(name);
    const solve = await st.getSolve('old-solve');
    expect(solve).toMatchObject({ puzzle: '333', scramble: 'R', time: 9000 });
    const sessions = await st.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ puzzle: '333', name: 'legacy' });
    expect(await st.allAttempts()).toEqual([]);
    st.close();

    // The upgrade must have stamped the rows on disk, not merely defaulted them at read time.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const o = indexedDB.open(name);
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    const rawSolve = await new Promise<SolveRecord>((resolve, reject) => {
      const r = raw.transaction('solves').objectStore('solves').get('old-solve');
      r.onsuccess = () => resolve(r.result as SolveRecord);
      r.onerror = () => reject(r.error);
    });
    expect(rawSolve.puzzle).toBe('333');
    raw.close();
  });

  it('defaults puzzle on read for a record stored without one', async () => {
    const name = `t-${Math.random()}`;
    const st = await openStore(name);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const o = indexedDB.open(name);
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    await new Promise<void>((resolve, reject) => {
      const t = raw.transaction('solves', 'readwrite');
      t.objectStore('solves').put({
        id: 'no-puzzle', session: 's1', when: 1, scramble: 'R', time: 1000,
        penalty: 0, source: 'keyboard', editedAt: 1,
      } satisfies Omit<SolveRecord, 'puzzle'>);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    raw.close();
    expect((await st.getSolve('no-puzzle'))?.puzzle).toBe('333');
    st.close();
  });
});

describe('favs', () => {
  it('keeps a favourite alg per case, a tombstone puts the standard back, and the later edit wins from remote', async () => {
    const st = await openStore(`t-${Math.random()}`);
    await st.putFav({ id: 'pll/Ja', kind: 'pll', caseId: 'Ja', alg: "x R2 F R F' R U2 r' U r U2 x'", editedAt: 10 });
    expect((await st.listFavs()).map((f) => f.id)).toEqual(['pll/Ja']);
    expect((await st.dirty()).map((d) => d.coll)).toContain('favs');
    // an older remote edit is kept out, a newer one applied
    expect(await st.applyRemote('favs', { id: 'pll/Ja', kind: 'pll', caseId: 'Ja', alg: 'other', editedAt: 5 })).toBe('kept');
    expect(await st.applyRemote('favs', { id: 'pll/Ja', kind: 'pll', caseId: 'Ja', alg: 'other', editedAt: 20, deleted: true })).toBe('applied');
    expect(await st.listFavs()).toEqual([]);
    expect((await st.getFav('pll/Ja'))?.deleted).toBe(true);
    st.close();
  });
});

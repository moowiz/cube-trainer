// The local solve store: IndexedDB, always present, the source of truth
// on this device. Every write marks the record dirty for the optional
// sync (sync.ts) to push; a record arriving from another device goes
// through applyRemote, which keeps the later edit and marks nothing.
// Tests run it on fake-indexeddb.

import type { SessionRecord, SolveRecord } from './types';

export type Coll = 'solves' | 'sessions';
export type RecordOf<C extends Coll> = C extends 'solves' ? SolveRecord : SessionRecord;

export interface Store {
  putSolve(s: SolveRecord): Promise<void>;
  getSolve(id: string): Promise<SolveRecord | undefined>;
  /** a session's solves, deleted ones left out, oldest first */
  listSolves(session: string): Promise<SolveRecord[]>;
  /** every solve, tombstones included (export, sync) */
  allSolves(): Promise<SolveRecord[]>;
  putSession(s: SessionRecord): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  allSessions(): Promise<SessionRecord[]>;
  /** a record from the other side: kept when the local edit is later; returns what happened */
  applyRemote<C extends Coll>(coll: C, r: RecordOf<C>): Promise<'applied' | 'kept'>;
  /** records edited here and not yet pushed */
  dirty(): Promise<{ coll: Coll; id: string }[]>;
  clearDirty(coll: Coll, id: string): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, v: unknown): Promise<void>;
  /** called after every change, local or remote */
  onChange(cb: () => void): () => void;
  close(): void;
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (t: IDBTransaction): Promise<void> => new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });

export function openStore(name = 'cube-coach'): Promise<Store> {
  return new Promise((resolve, reject) => {
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
    open.onsuccess = () => resolve(wrap(open.result));
  });
}

function wrap(db: IDBDatabase): Store {
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };

  async function put(coll: Coll, r: SolveRecord | SessionRecord, markDirty: boolean): Promise<void> {
    const t = db.transaction(markDirty ? [coll, 'dirty'] : [coll], 'readwrite');
    t.objectStore(coll).put(r);
    if (markDirty) t.objectStore('dirty').put({ key: `${coll}/${r.id}`, coll, id: r.id });
    await done(t);
    changed();
  }
  const get = <T>(coll: Coll, id: string): Promise<T | undefined> => req(db.transaction(coll).objectStore(coll).get(id) as IDBRequest<T | undefined>);
  const all = <T>(coll: Coll): Promise<T[]> => req(db.transaction(coll).objectStore(coll).getAll() as IDBRequest<T[]>);

  return {
    putSolve: (s) => put('solves', s, true),
    getSolve: (id) => get<SolveRecord>('solves', id),
    async listSolves(session) {
      const rows = await req(db.transaction('solves').objectStore('solves').index('session').getAll(session) as IDBRequest<SolveRecord[]>);
      return rows.filter((s) => !s.deleted).sort((a, b) => a.when - b.when);
    },
    allSolves: () => all<SolveRecord>('solves'),
    putSession: (s) => put('sessions', s, true),
    async listSessions() { return (await all<SessionRecord>('sessions')).filter((s) => !s.deleted).sort((a, b) => a.createdAt - b.createdAt); },
    allSessions: () => all<SessionRecord>('sessions'),
    async applyRemote(coll, r) {
      const mine = await get<SolveRecord | SessionRecord>(coll, r.id);
      if (mine && mine.editedAt >= r.editedAt) return 'kept';
      await put(coll, r, false);
      return 'applied';
    },
    async dirty() { return (await req(db.transaction('dirty').objectStore('dirty').getAll() as IDBRequest<{ coll: Coll; id: string }[]>)).map(({ coll, id }) => ({ coll, id })); },
    async clearDirty(coll, id) { const t = db.transaction('dirty', 'readwrite'); t.objectStore('dirty').delete(`${coll}/${id}`); await done(t); },
    async getMeta<T>(key: string) { const row = await req(db.transaction('meta').objectStore('meta').get(key) as IDBRequest<{ key: string; v: T } | undefined>); return row?.v; },
    async setMeta(key, v) { const t = db.transaction('meta', 'readwrite'); t.objectStore('meta').put({ key, v }); await done(t); },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    close: () => db.close(),
  };
}

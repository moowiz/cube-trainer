// The local solve store: IndexedDB, always present, the source of truth
// on this device. Every write marks the record dirty for the optional
// sync (sync.ts) to push; a record arriving from another device goes
// through applyRemote, which keeps the later edit and marks nothing.
// Tests run it on fake-indexeddb.

import { DEFAULT_PUZZLE, type AttemptRecord, type AttemptStage, type FavRecord, type SessionRecord, type SolveRecord } from './types';

export type Coll = 'solves' | 'sessions' | 'attempts' | 'favs';
export type RecordOf<C extends Coll> = C extends 'solves' ? SolveRecord : C extends 'sessions' ? SessionRecord : C extends 'attempts' ? AttemptRecord : FavRecord;
type AnyRecord = SolveRecord | SessionRecord | AttemptRecord | FavRecord;

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
  putAttempt(a: AttemptRecord): Promise<void>;
  getAttempt(id: string): Promise<AttemptRecord | undefined>;
  /** attempts for a stage (or every stage), deleted ones left out, oldest first; `since` filters by `when` */
  listAttempts(stage?: AttemptStage, since?: number): Promise<AttemptRecord[]>;
  /** every attempt, tombstones included (export, sync) */
  allAttempts(): Promise<AttemptRecord[]>;
  putFav(f: FavRecord): Promise<void>;
  getFav(id: string): Promise<FavRecord | undefined>;
  /** the favourite algs in force (tombstones left out) */
  listFavs(): Promise<FavRecord[]>;
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

/** Records written before the `puzzle` field existed have none: default them on read. */
function withPuzzle<T extends { puzzle?: unknown }>(r: T): T & { puzzle: typeof DEFAULT_PUZZLE } {
  return r.puzzle ? (r as T & { puzzle: typeof DEFAULT_PUZZLE }) : { ...r, puzzle: DEFAULT_PUZZLE };
}

const DB_VERSION = 3;

export function openStore(name = 'cube-coach'): Promise<Store> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = (ev) => {
      const db = open.result;
      const t = open.transaction!;
      const oldVersion = ev.oldVersion;
      if (oldVersion < 1) {
        const solves = db.createObjectStore('solves', { keyPath: 'id' });
        solves.createIndex('session', 'session');
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('dirty', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        const attempts = db.createObjectStore('attempts', { keyPath: 'id' });
        attempts.createIndex('stage', 'stage');
        attempts.createIndex('when', 'when');
        // Existing rows predate `puzzle`: stamp the default onto them in place.
        for (const coll of ['solves', 'sessions'] as const) {
          const store = t.objectStore(coll);
          store.openCursor().onsuccess = (curEv) => {
            const cursor = (curEv.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            const row = cursor.value as SolveRecord | SessionRecord;
            if (!row.puzzle) cursor.update({ ...row, puzzle: DEFAULT_PUZZLE });
            cursor.continue();
          };
        }
      }
      if (oldVersion < 3) db.createObjectStore('favs', { keyPath: 'id' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(wrap(open.result));
  });
}

function wrap(db: IDBDatabase): Store {
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };

  async function put(coll: Coll, r: AnyRecord, markDirty: boolean): Promise<void> {
    const t = db.transaction(markDirty ? [coll, 'dirty'] : [coll], 'readwrite');
    t.objectStore(coll).put(r);
    if (markDirty) t.objectStore('dirty').put({ key: `${coll}/${r.id}`, coll, id: r.id });
    await done(t);
    changed();
  }
  const get = <T extends AnyRecord>(coll: Coll, id: string): Promise<T | undefined> => req(db.transaction(coll).objectStore(coll).get(id) as IDBRequest<T | undefined>);
  const all = <T extends AnyRecord>(coll: Coll): Promise<T[]> => req(db.transaction(coll).objectStore(coll).getAll() as IDBRequest<T[]>);

  return {
    putSolve: (s) => put('solves', s, true),
    async getSolve(id) { const r = await get<SolveRecord>('solves', id); return r && withPuzzle(r); },
    async listSolves(session) {
      const rows = await req(db.transaction('solves').objectStore('solves').index('session').getAll(session) as IDBRequest<SolveRecord[]>);
      return rows.filter((s) => !s.deleted).sort((a, b) => a.when - b.when).map(withPuzzle);
    },
    async allSolves() { return (await all<SolveRecord>('solves')).map(withPuzzle); },
    putSession: (s) => put('sessions', s, true),
    async listSessions() { return (await all<SessionRecord>('sessions')).filter((s) => !s.deleted).sort((a, b) => a.createdAt - b.createdAt).map(withPuzzle); },
    async allSessions() { return (await all<SessionRecord>('sessions')).map(withPuzzle); },
    putAttempt: (a) => put('attempts', a, true),
    async getAttempt(id) { const r = await get<AttemptRecord>('attempts', id); return r && withPuzzle(r); },
    async listAttempts(stage, since) {
      const rows = stage
        ? await req(db.transaction('attempts').objectStore('attempts').index('stage').getAll(stage) as IDBRequest<AttemptRecord[]>)
        : await all<AttemptRecord>('attempts');
      return rows.filter((a) => !a.deleted && (since === undefined || a.when >= since)).sort((a, b) => a.when - b.when).map(withPuzzle);
    },
    async allAttempts() { return (await all<AttemptRecord>('attempts')).map(withPuzzle); },
    putFav: (f) => put('favs', f, true),
    getFav: (id) => get<FavRecord>('favs', id),
    async listFavs() { return (await all<FavRecord>('favs')).filter((f) => !f.deleted); },
    async applyRemote(coll, r) {
      const mine = await get<AnyRecord>(coll, r.id);
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

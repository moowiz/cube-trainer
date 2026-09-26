// Optional cloud sync for the solve store (docs/smart-cube-design.md 4.1):
// the local IndexedDB store stays the source of truth; when sync is on
// and the user is signed in, every dirty record is pushed to Firestore
// under users/{uid}/{solves|sessions|attempts|favs|notes}/{id} and every record another
// device wrote is pulled (`updatedAt` after the last one seen) at sign-in and whenever the
// tab comes back into view, through applyRemote (the later edit wins). No live listener: the
// app is used on one screen at a time (2026-09-26), and the Firestore lite build is a third of
// the full one. Firebase itself loads lazily (firebase.ts).

import type { Coll, Store } from './local';
import type { AttemptRecord, FavRecord, NoteRecord, SessionRecord, SolveRecord } from './types';
import { readStored, writeStored } from '../ui/settings';

export interface SyncState {
  status: 'off' | 'loading' | 'signed-out' | 'syncing' | 'synced' | 'error';
  user?: { name: string; email: string };
  error?: string;
  pushed: number;
  pulled: number;
  /** records edited here that the cloud has not acknowledged */
  pending: number;
  /** wall ms since when something has been pending (unset while nothing is) */
  pendingSince?: number;
}

/**
 * What the header should warn about, or null: sync wanted but signed out, a failed push or
 * pull, or edits the cloud has not taken for a while (offline, or a push that keeps failing).
 * Pure, for the tests.
 */
export function syncWarning(s: SyncState, now = Date.now(), online = true, stuckMs = 60_000): string | null {
  if (s.status === 'off' || s.status === 'loading') return null;
  if (s.status === 'signed-out') return 'Sync is on but you are signed out: solves stay on this device until you sign in again.';
  if (s.status === 'error') return `Sync failed: ${s.error ?? 'unknown error'}`;
  if (s.pending > 0 && (!online || now - (s.pendingSince ?? now) > stuckMs)) {
    return `${s.pending} record${s.pending === 1 ? '' : 's'} not synced yet${online ? '' : ' (offline)'}. They will go up when the cloud answers.`;
  }
  return null;
}

/** The header chip, the way a document editor shows it: syncing while records are on their way, a warning when they are not going, nothing otherwise. */
export function syncChip(s: SyncState, now = Date.now(), online = true): { kind: 'syncing' | 'warn'; text: string } | null {
  const warn = syncWarning(s, now, online);
  if (warn) return { kind: 'warn', text: warn };
  if (s.pending > 0 && s.status !== 'off' && s.status !== 'loading') return { kind: 'syncing', text: `${s.pending} record${s.pending === 1 ? '' : 's'} on the way to the cloud` };
  return null;
}

type FB = typeof import('./firebase');
const COLLS: Coll[] = ['solves', 'sessions', 'attempts', 'favs', 'notes'];
const ON_KEY = 'cube.sync.on';

export function syncWanted(): boolean { return readStored(ON_KEY) === '1'; }
function setWanted(on: boolean): void { writeStored(ON_KEY, on ? '1' : null); }

/** How to fetch one record by id, per collection (sessions has no get-by-id on Store). */
const getters: Record<Coll, (store: Store, id: string) => Promise<SolveRecord | SessionRecord | AttemptRecord | FavRecord | NoteRecord | undefined>> = {
  solves: (store, id) => store.getSolve(id),
  sessions: async (store, id) => (await store.allSessions()).find((s) => s.id === id),
  attempts: (store, id) => store.getAttempt(id),
  favs: (store, id) => store.getFav(id),
  notes: (store, id) => store.getNote(id),
};

export class Sync {
  private fb: FB | null = null;
  private state: SyncState = { status: 'off', pushed: 0, pulled: 0, pending: 0 };
  private uid: string | null = null;
  private pulling: Promise<void> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pushing = false;

  constructor(private readonly store: Store, private readonly onState: (s: SyncState) => void) {}

  current(): SyncState { return this.state; }

  private set(patch: Partial<SyncState>): void {
    const next = { ...this.state, ...patch };
    // the pending clock: starts when the queue fills, stops when it empties
    if (next.pending > 0 && this.state.pending === 0) next.pendingSince = Date.now();
    if (next.pending === 0) delete next.pendingSince;
    this.state = next; this.onState(this.state);
  }

  /** Load Firebase and follow the auth state; called at page load when sync was switched on before, and on Sign in. */
  async start(): Promise<void> {
    if (this.fb) return;
    this.set({ status: 'loading' });
    try { this.fb = await import('./firebase'); }
    catch (err) { this.set({ status: 'error', error: `Firebase failed to load: ${err instanceof Error ? err.message : err}` }); return; }
    const fb = this.fb;
    fb.getRedirectResult(fb.auth).catch(() => undefined);
    fb.onAuthStateChanged(fb.auth, (user) => { void this.onUser(user); });
    this.store.onChange(() => this.schedulePush());
    window.addEventListener('online', () => { void this.pullAll(); this.schedulePush(); });
    // the pull, on coming back to the tab: another device may have written while this one was away
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void this.pullAll(); });
    void this.countPending();
  }

  /** How many records wait for the cloud; kept on the state so the header can warn when they sit there. */
  private async countPending(): Promise<void> {
    try { const n = (await this.store.dirty()).length; if (n !== this.state.pending) this.set({ pending: n }); }
    catch { /* the store is closing */ }
  }

  /**
   * Sign in on signin.html and come back. The app runs cross-origin isolated (COOP same-origin, for
   * wasm threads), which cuts a popup off from its opener and makes an in-app popup sign-in fail
   * with auth/popup-closed-by-user; the sign-in page is served without those headers and shares
   * this origin's auth persistence, so start() finds the user on return.
   */
  signIn(): Promise<void> {
    setWanted(true);
    location.href = `${import.meta.env.BASE_URL}signin.html?return=${encodeURIComponent(location.pathname + location.search)}`;
    return Promise.resolve();
  }

  async signOut(): Promise<void> {
    setWanted(false);
    if (this.fb) await this.fb.signOut(this.fb.auth).catch(() => undefined);
    this.uid = null;
    this.set({ status: 'off', user: undefined });
  }

  private async onUser(user: import('./firebase').User | null): Promise<void> {
    if (!user) { this.uid = null; this.set({ status: 'signed-out', user: undefined }); return; }
    this.uid = user.uid;
    this.set({ status: 'syncing', user: { name: user.displayName ?? '', email: user.email ?? '' } });
    await this.pullAll();
    await this.push();
  }

  /** Every collection pulled once; a pull already under way is shared, not repeated. */
  private pullAll(): Promise<void> {
    if (!this.fb || !this.uid) return Promise.resolve();
    return (this.pulling ??= (async () => {
      try {
        for (const coll of COLLS) await this.pull(coll);
        if (this.state.status === 'syncing') this.set({ status: 'synced' });
      } catch (err) {
        this.set({ status: 'error', error: `Pull failed: ${err instanceof Error ? err.message : err}` });
      } finally {
        this.pulling = null;
      }
    })());
  }

  private col(coll: Coll) {
    const fb = this.fb!;
    return fb.collection(fb.db, 'users', this.uid!, coll);
  }

  /** The records the other side edited after the last one we saw, into the store. */
  private async pull(coll: Coll): Promise<void> {
    const fb = this.fb!, uid = this.uid!;
    const key = `lastPulled/${uid}/${coll}`;
    const last = (await this.store.getMeta<number>(key)) ?? 0;
    if (this.uid !== uid) return;
    const snap = await fb.getDocs(fb.query(this.col(coll), fb.where('updatedAt', '>', fb.Timestamp.fromMillis(last))));
    let newest = last;
    let pulled = 0;
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown> & { updatedAt?: { toMillis(): number } | null };
      const at = data.updatedAt && typeof data.updatedAt.toMillis === 'function' ? data.updatedAt.toMillis() : null;
      if (at === null) continue;
      const rec = { ...data } as Record<string, unknown>;
      delete rec.updatedAt;
      const applied = await this.store.applyRemote(coll, rec as unknown as SolveRecord & SessionRecord & AttemptRecord & FavRecord & NoteRecord);
      if (applied === 'applied') pulled++;
      if (at > newest) newest = at;
    }
    if (newest !== last) await this.store.setMeta(key, newest);
    if (pulled) this.set({ pulled: this.state.pulled + pulled });
  }

  private schedulePush(): void {
    void this.countPending();
    if (!this.uid) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { void this.push(); }, 500);
  }

  /** Every dirty record up, in batches; a failure keeps them dirty for the next try. */
  private async push(): Promise<void> {
    if (!this.fb || !this.uid || this.pushing) return;
    this.pushing = true;
    const fb = this.fb;
    try {
      const dirty = await this.store.dirty();
      for (let i = 0; i < dirty.length; i += 400) {
        const chunk = dirty.slice(i, i + 400);
        const batch = fb.writeBatch(fb.db);
        const done: typeof chunk = [];
        for (const { coll, id } of chunk) {
          const rec = await getters[coll](this.store, id);
          if (!rec) { await this.store.clearDirty(coll, id); continue; }
          batch.set(fb.doc(this.col(coll), id), { ...strip(rec), updatedAt: fb.serverTimestamp() });
          done.push({ coll, id });
        }
        if (!done.length) continue;
        await batch.commit();
        for (const { coll, id } of done) await this.store.clearDirty(coll, id);
        this.set({ pushed: this.state.pushed + done.length, pending: Math.max(0, this.state.pending - done.length) });
      }
      this.set({ pending: (await this.store.dirty()).length });
      if (this.state.status === 'syncing' || this.state.status === 'error') this.set({ status: 'synced', error: undefined });
    } catch (err) {
      this.set({ status: 'error', error: `Push failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      this.pushing = false;
    }
  }
}

/** Firestore rejects undefined fields: drop them. */
function strip<T extends object>(rec: T): T {
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined)) as T;
}

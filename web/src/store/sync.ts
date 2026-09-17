// Optional cloud sync for the solve store (docs/smart-cube-design.md 4.1):
// the local IndexedDB store stays the source of truth; when sync is on
// and the user is signed in, every dirty record is pushed to Firestore
// under users/{uid}/{solves|sessions}/{id} and every record another
// device wrote comes back through a snapshot listener and applyRemote
// (the later edit wins). Firebase itself loads lazily (firebase.ts).

import type { Coll, Store } from './local';
import type { SessionRecord, SolveRecord } from './types';

export interface SyncState {
  status: 'off' | 'loading' | 'signed-out' | 'syncing' | 'synced' | 'error';
  user?: { name: string; email: string };
  error?: string;
  pushed: number;
  pulled: number;
}

type FB = typeof import('./firebase');
const COLLS: Coll[] = ['solves', 'sessions'];
const ON_KEY = 'cube.sync.on';

export function syncWanted(): boolean { try { return localStorage.getItem(ON_KEY) === '1'; } catch { return false; } }
function setWanted(on: boolean): void { try { if (on) localStorage.setItem(ON_KEY, '1'); else localStorage.removeItem(ON_KEY); } catch { /* no storage */ } }

export class Sync {
  private fb: FB | null = null;
  private state: SyncState = { status: 'off', pushed: 0, pulled: 0 };
  private uid: string | null = null;
  private unsubs: (() => void)[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pushing = false;

  constructor(private readonly store: Store, private readonly onState: (s: SyncState) => void) {}

  current(): SyncState { return this.state; }

  private set(patch: Partial<SyncState>): void { this.state = { ...this.state, ...patch }; this.onState(this.state); }

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
    window.addEventListener('online', () => this.schedulePush());
  }

  async signIn(): Promise<void> {
    setWanted(true);
    await this.start();
    if (!this.fb) return;
    try { await this.fb.signInWithGoogle(); }
    catch (err) { this.set({ status: 'error', error: `Sign-in failed: ${err instanceof Error ? err.message : err}` }); }
  }

  async signOut(): Promise<void> {
    setWanted(false);
    this.stopListening();
    if (this.fb) await this.fb.signOut(this.fb.auth).catch(() => undefined);
    this.uid = null;
    this.set({ status: 'off', user: undefined });
  }

  private stopListening(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private async onUser(user: import('./firebase').User | null): Promise<void> {
    this.stopListening();
    if (!user) { this.uid = null; this.set({ status: 'signed-out', user: undefined }); return; }
    this.uid = user.uid;
    this.set({ status: 'syncing', user: { name: user.displayName ?? '', email: user.email ?? '' } });
    for (const coll of COLLS) this.listen(coll);
    await this.push();
  }

  private col(coll: Coll) {
    const fb = this.fb!;
    return fb.collection(fb.db, 'users', this.uid!, coll);
  }

  /** Records the other side edited after the last one we saw, from now on. */
  private listen(coll: Coll): void {
    const fb = this.fb!, uid = this.uid!;
    const key = `lastPulled/${uid}/${coll}`;
    void this.store.getMeta<number>(key).then((last) => {
      if (this.uid !== uid) return;
      const q = fb.query(this.col(coll), fb.where('updatedAt', '>', fb.Timestamp.fromMillis(last ?? 0)));
      const unsub = fb.onSnapshot(q, (snap) => {
        void (async () => {
          let newest = last ?? 0;
          let pulled = 0;
          for (const ch of snap.docChanges()) {
            if (ch.type === 'removed') continue;
            const data = ch.doc.data() as Record<string, unknown> & { updatedAt?: { toMillis(): number } | null };
            const at = data.updatedAt && typeof data.updatedAt.toMillis === 'function' ? data.updatedAt.toMillis() : null;
            if (at === null) continue; // our own pending write, not yet stamped by the server
            const rec = { ...data } as Record<string, unknown>;
            delete rec.updatedAt;
            const applied = await this.store.applyRemote(coll, rec as unknown as SolveRecord & SessionRecord);
            if (applied === 'applied') pulled++;
            if (at > newest) newest = at;
          }
          if (newest !== (last ?? 0)) { last = newest; await this.store.setMeta(key, newest); }
          if (pulled) this.set({ pulled: this.state.pulled + pulled });
          if (this.state.status === 'syncing') this.set({ status: 'synced' });
        })();
      }, (err) => this.set({ status: 'error', error: `Sync listener failed: ${err.message}` }));
      this.unsubs.push(unsub);
    });
  }

  private schedulePush(): void {
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
          const rec = coll === 'solves' ? await this.store.getSolve(id) : (await this.store.allSessions()).find((s) => s.id === id);
          if (!rec) { await this.store.clearDirty(coll, id); continue; }
          batch.set(fb.doc(this.col(coll), id), { ...strip(rec), updatedAt: fb.serverTimestamp() });
          done.push({ coll, id });
        }
        if (!done.length) continue;
        await batch.commit();
        for (const { coll, id } of done) await this.store.clearDirty(coll, id);
        this.set({ pushed: this.state.pushed + done.length });
      }
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

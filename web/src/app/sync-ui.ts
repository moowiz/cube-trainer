// The settings sheet's sync row: sign in / sign out and the status line
// (docs/smart-cube-design.md 4.1). The Sync itself lives in store/sync.ts
// and loads Firebase only once sync has been switched on.

import { Sync, syncWanted, type SyncState } from '../store/sync';
import { panel, store } from './context';

let sync: Sync | null = null;

function renderSync(s: SyncState): void {
  const sub = panel('sync-sub');
  const who = s.user ? ` as ${s.user.email || s.user.name}` : '';
  sub.textContent = s.status === 'off' ? 'Keep the history in the cloud and share it between the phone and the desktop. Google sign-in; nothing but the solve records goes up.'
    : s.status === 'loading' ? 'Loading…' : s.status === 'signed-out' ? 'Signed out. Sign in to sync.'
    : s.status === 'error' ? `Sync problem: ${s.error ?? '?'}` : `${s.status === 'syncing' ? 'Syncing' : 'Synced'}${who} · ${s.pushed} up, ${s.pulled} down this session`;
  panel('sync-in').hidden = !!s.user;
  panel('sync-out').hidden = !s.user;
}

async function ensureSync(): Promise<Sync> { sync ??= new Sync(await store, renderSync); return sync; }

export function initSyncUi(): void {
  panel('sync-in').onclick = () => { void ensureSync().then((s) => s.signIn()); };
  panel('sync-out').onclick = () => { void ensureSync().then((s) => s.signOut()); };
  if (syncWanted()) void ensureSync().then((s) => s.start());
}

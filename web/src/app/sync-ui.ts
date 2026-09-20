// The settings sheet's sync row: sign in / sign out and the status line
// (docs/smart-cube-design.md 4.1), and the header's warning chip when the
// cloud is not taking the solves (signed out, a failed push, edits pending
// too long). The Sync itself lives in store/sync.ts and loads Firebase only
// once sync has been switched on.

import { openSheet, toast } from '../shell';
import { Sync, syncChip, syncWanted, type SyncState } from '../store/sync';
import { panel, store } from './context';

let sync: Sync | null = null;
let lastWarning: string | null = null;

/** The chip in the tab bar: "Syncing" while records are on their way, a warning when they are not going; a new warning also toasts once. */
function renderWarning(s: SyncState): void {
  const chip = document.getElementById('sync-warn');
  if (!chip) return;
  const c = syncChip(s, Date.now(), navigator.onLine);
  chip.hidden = c === null;
  chip.title = c?.text ?? '';
  chip.classList.toggle('warn', c?.kind === 'warn');
  chip.classList.toggle('busy', c?.kind === 'syncing');
  chip.querySelector('.ico-txt')!.textContent = c?.kind === 'warn' ? '⚠' : '⟳';
  chip.querySelector('.txt')!.textContent = c?.kind === 'warn' ? ' Not syncing' : ' Syncing';
  const msg = c?.kind === 'warn' ? c.text : null;
  if (msg && msg !== lastWarning) toast(msg);
  lastWarning = msg;
}

function renderSync(s: SyncState): void {
  renderWarning(s);
  const sub = panel('sync-sub');
  const who = s.user ? ` as ${s.user.email || s.user.name}` : '';
  sub.textContent = s.status === 'off' ? 'Keep the history in the cloud and share it between the phone and the desktop. Google sign-in; nothing but the solve records goes up.'
    : s.status === 'loading' ? 'Loading…' : s.status === 'signed-out' ? 'Signed out. Sign in to sync.'
    : s.status === 'error' ? `Sync problem: ${s.error ?? '?'}` : `${s.status === 'syncing' ? 'Syncing' : 'Synced'}${who} · ${s.pushed} up, ${s.pulled} down this session${s.pending ? ` · ${s.pending} waiting` : ''}`;
  panel('sync-in').hidden = !!s.user;
  panel('sync-out').hidden = !s.user;
}

async function ensureSync(): Promise<Sync> { sync ??= new Sync(await store, renderSync); return sync; }

export function initSyncUi(): void {
  panel('sync-in').onclick = () => { void ensureSync().then((s) => s.signIn()); };
  panel('sync-out').onclick = () => { void ensureSync().then((s) => s.signOut()); };
  const chip = document.getElementById('sync-warn');
  if (chip) chip.onclick = () => openSheet('settings-sheet');
  if (syncWanted()) {
    void ensureSync().then((s) => s.start());
    // the "pending too long" warning is a matter of time passing, not of a state change: look every 15 s, and when the network comes or goes
    const again = () => { if (sync) renderWarning(sync.current()); };
    setInterval(again, 15_000);
    window.addEventListener('online', again);
    window.addEventListener('offline', again);
  }
}

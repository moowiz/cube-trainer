// The favourite algs kept: the store's favs collection (IndexedDB, and Firestore
// when sync is on) is the truth, the case tables follow it - at load, and again
// whenever the store changes (a star here, or one on another device coming
// down). Starring goes through here so the record is written; a table (the
// last-layer cases, the F2L finder's) only applies it, through TABLES.

import type { Coll, Store } from '../store/local';
import type { AlgKind, FavRecord } from '../store/types';
import { CASES, isFavourite as llIsFavourite, setMainAlg as llSetMainAlg, standardAlg as llStandardAlg } from './cases';
import { f2lCaseIds, f2lIsFavourite, f2lMainAlg, f2lSetMainAlg, f2lStandardAlg } from '../f2l/model';

/** What a case table does with a favourite: apply one (false for an alg the case lacks), say the standard, say whether one is set. */
interface FavTable { ids(): string[]; mainAlg(id: string): string | undefined; setMainAlg(id: string, alg: string | null): boolean; standardAlg(id: string): string | undefined; isFavourite(id: string): boolean }
const TABLES: Record<AlgKind, FavTable> = {
  ocll: { ids: () => CASES.ocll.map((c) => c.id), mainAlg: (id) => CASES.ocll.find((c) => c.id === id)?.alg, setMainAlg: (id, alg) => llSetMainAlg('ocll', id, alg), standardAlg: (id) => llStandardAlg('ocll', id), isFavourite: (id) => llIsFavourite('ocll', id) },
  pll: { ids: () => CASES.pll.map((c) => c.id), mainAlg: (id) => CASES.pll.find((c) => c.id === id)?.alg, setMainAlg: (id, alg) => llSetMainAlg('pll', id, alg), standardAlg: (id) => llStandardAlg('pll', id), isFavourite: (id) => llIsFavourite('pll', id) },
  f2l: { ids: f2lCaseIds, mainAlg: f2lMainAlg, setMainAlg: f2lSetMainAlg, standardAlg: f2lStandardAlg, isFavourite: f2lIsFavourite },
};

let store: Promise<Store> | null = null;
const listeners = new Set<() => void>();

// A record's id, and so its Firestore document name: NO SLASH (2026-09-22 - a slash made
// users/{uid}/favs/pll/Ja, which Firestore reads as a path, and the failing write stopped every
// other record from syncing too). Records written with the old id are dropped on sight.
const idOf = (kind: AlgKind, caseId: string): string => `${kind}:${caseId}`;

/** The rows written before ids were slash-free: forgotten here, and taken off the sync queue so the push runs again. */
async function dropOldIds(st: Store): Promise<void> {
  const bad = (await st.listFavs()).filter((f) => f.id.includes('/'));
  for (const f of bad) {
    // keep what it said: the same case's favourite under the new id, unless one is there already
    if (!(await st.getFav(idOf(f.kind, f.caseId)))) await st.putFav({ ...f, id: idOf(f.kind, f.caseId), editedAt: Date.now() });
    await st.clearDirty('favs' as Coll, f.id);
  }
}

/** Apply the store's favourites to the table; true when any case's main changed. */
async function applyAll(): Promise<boolean> {
  if (!store) return false;
  const st = await store;
  const favs = await st.listFavs();
  const want = new Map(favs.filter((f) => !f.id.includes('/')).map((f) => [f.id, f]));
  let changed = false;
  for (const kind of Object.keys(TABLES) as AlgKind[]) {
    const t = TABLES[kind];
    for (const id of t.ids()) {
      const f = want.get(idOf(kind, id));
      const alg = f ? f.alg : null;
      const before = t.mainAlg(id);
      // an alg the table no longer has (renamed, dropped) leaves the standard one
      if (!t.setMainAlg(id, alg)) t.setMainAlg(id, null);
      if (t.mainAlg(id) !== before) changed = true;
    }
  }
  return changed;
}

/** Wire the table to the store: the stored favourites applied (the listeners told), then again on every store change. */
export async function initFavs(s: Promise<Store>): Promise<void> {
  store = s;
  await dropOldIds(await s);
  const tell = (changed: boolean) => { if (changed) for (const l of listeners) l(); };
  tell(await applyAll());
  (await s).onChange(() => { void applyAll().then(tell); });
}

/** Hear the table change under a favourite that came from the store (another device, a sync). */
export function onFavsChange(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** Star `alg` as the case's main (null: the standard one back): the table now, the store behind it. */
export function setFavourite(kind: AlgKind, id: string, alg: string | null): boolean {
  const t = TABLES[kind];
  const ok = t.setMainAlg(id, alg);
  if (!ok) return false;
  const rec: FavRecord = { id: idOf(kind, id), kind, caseId: id, alg: alg ?? t.standardAlg(id)!, editedAt: Date.now(), ...(t.isFavourite(id) ? {} : { deleted: true }) };
  if (store) void store.then((st) => st.putFav(rec));
  return true;
}

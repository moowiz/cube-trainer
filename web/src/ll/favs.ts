// The favourite algs kept: the store's favs collection (IndexedDB, and Firestore
// when sync is on) is the truth, the case table follows it - at load, and again
// whenever the store changes (a star here, or one on another device coming
// down). Starring goes through here so the record is written; cases.ts only
// applies it.

import type { Store } from '../store/local';
import type { FavRecord } from '../store/types';
import { CASES, isFavourite, type LLKind, setMainAlg, standardAlg } from './cases';

let store: Promise<Store> | null = null;
const listeners = new Set<() => void>();

/** Apply the store's favourites to the table; true when any case's main changed. */
async function applyAll(): Promise<boolean> {
  if (!store) return false;
  const st = await store;
  const favs = await st.listFavs();
  const want = new Map(favs.map((f) => [f.id, f]));
  let changed = false;
  for (const kind of ['ocll', 'pll'] as const) {
    for (const c of CASES[kind]) {
      const f = want.get(`${kind}/${c.id}`);
      const alg = f ? f.alg : null;
      const before = c.alg;
      // an alg the table no longer has (renamed, dropped) leaves the standard one
      if (!setMainAlg(kind, c.id, alg)) setMainAlg(kind, c.id, null);
      if (c.alg !== before) changed = true;
    }
  }
  return changed;
}

/** Wire the table to the store: the stored favourites applied (the listeners told), then again on every store change. */
export async function initFavs(s: Promise<Store>): Promise<void> {
  store = s;
  const tell = (changed: boolean) => { if (changed) for (const l of listeners) l(); };
  tell(await applyAll());
  (await s).onChange(() => { void applyAll().then(tell); });
}

/** Hear the table change under a favourite that came from the store (another device, a sync). */
export function onFavsChange(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** Star `alg` as the case's main (null: the standard one back): the table now, the store behind it. */
export function setFavourite(kind: LLKind, id: string, alg: string | null): boolean {
  const ok = setMainAlg(kind, id, alg);
  if (!ok) return false;
  const rec: FavRecord = { id: `${kind}/${id}`, kind, caseId: id, alg: alg ?? standardAlg(kind, id)!, editedAt: Date.now(), ...(isFavourite(kind, id) ? {} : { deleted: true }) };
  if (store) void store.then((st) => st.putFav(rec));
  return true;
}

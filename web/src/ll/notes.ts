// What you wrote about an alg: how you tell the case from its twin, how you
// hold it, whatever makes it stick. One note per alg (a case's main and each
// of its alternatives have their own), kept in the store's notes collection -
// IndexedDB always, Firestore when sync is on - and read back here.

import type { Store } from '../store/local';
import type { NoteRecord } from '../store/types';
import type { LLKind } from './cases';

let store: Promise<Store> | null = null;
let notes = new Map<string, string>();
const listeners = new Set<() => void>();

// the id, and so the Firestore document name: no slash (see ll/favs.ts), and the alg in it so a note
// follows its own alg when a case's algs are reordered by a favourite
const keyOf = (alg: string): string => alg.replace(/\s+/g, '').replace(/'/g, 'i');
const idOf = (kind: LLKind, caseId: string, alg: string): string => `${kind}:${caseId}:${keyOf(alg)}`;

async function load(): Promise<boolean> {
  if (!store) return false;
  const rows = await (await store).listNotes();
  const next = new Map(rows.map((n) => [n.id, n.text]));
  const same = next.size === notes.size && [...next].every(([k, v]) => notes.get(k) === v);
  notes = next;
  return !same;
}

/** Read the notes in, and follow the store (another device's note arrives the same way). */
export async function initNotes(s: Promise<Store>): Promise<void> {
  store = s;
  const tell = (changed: boolean) => { if (changed) for (const l of listeners) l(); };
  tell(await load());
  (await s).onChange(() => { void load().then(tell); });
}

/** Hear a note change (one written here, or one synced in). */
export function onNotesChange(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** The note on this alg, or '' when there is none. */
export function noteFor(kind: LLKind, caseId: string, alg: string): string {
  return notes.get(idOf(kind, caseId, alg)) ?? '';
}

/** Write (or, with empty text, clear) the note on an alg. */
export function setNote(kind: LLKind, caseId: string, alg: string, text: string): void {
  const id = idOf(kind, caseId, alg);
  const t = text.trim();
  if ((notes.get(id) ?? '') === t) return;
  if (t) notes.set(id, t); else notes.delete(id);
  const rec: NoteRecord = { id, kind, caseId, alg, text: t, editedAt: Date.now(), ...(t ? {} : { deleted: true }) };
  if (store) void store.then((st) => st.putNote(rec));
  for (const l of listeners) l();
}

// The analysed solves, kept in memory: each stored solve with turns is analysed
// once (per edit, per colour scheme - the frame the turns are read in) and the
// list is handed to the coach and the solve report. The work yields every few
// solves so a long history does not freeze the page on a phone.

import { frontIndex } from '../cube/scheme';
import type { Store } from '../store/local';
import type { SolveRecord } from '../store/types';
import { analyseSolve, type SolveAnalysis } from './solve';

export interface Analysed { rec: SolveRecord; a: SolveAnalysis }

const memo = new Map<string, { key: string; a: SolveAnalysis | null }>();
const keyOf = (r: SolveRecord) => `${r.editedAt}|${r.moves?.length ?? 0}|${frontIndex()}`;

/** One solve's analysis, memoised. */
export function analysedOne(r: SolveRecord): SolveAnalysis | null {
  const k = keyOf(r), hit = memo.get(r.id);
  if (hit && hit.key === k) return hit.a;
  let a: SolveAnalysis | null;
  try { a = r.moves?.length && r.penalty !== -1 ? analyseSolve(r) : null; } catch { a = null; }
  memo.set(r.id, { key: k, a });
  return a;
}

/** Every solve in the store that can be analysed (turns recorded, not a DNF, not deleted), oldest first. */
export async function analysedSolves(store: Promise<Store>): Promise<Analysed[]> {
  const all = (await (await store).allSolves()).filter((r) => !r.deleted && r.moves?.length && r.penalty !== -1).sort((a, b) => a.when - b.when);
  const out: Analysed[] = [];
  let since = performance.now();
  for (const rec of all) {
    const a = analysedOne(rec);
    if (a) out.push({ rec, a });
    if (performance.now() - since > 30) { await new Promise((ok) => setTimeout(ok, 0)); since = performance.now(); }
  }
  return out;
}

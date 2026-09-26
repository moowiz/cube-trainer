// The F2L cases picked to practise (the case sheet's "practise" toggles), kept in localStorage, and
// the draw a targeted scramble makes from them; plus the practice so far, per case, off the store's
// attempts (the finder files one when a targeted pair is solved). A case is picked on the slot it was
// picked on; `mirrors` draws it on all four (the slots are mirrors: the same hand motions reflected).

import type { AttemptRecord } from '../store/types';
import { persisted } from '../ui/settings';
import { DATA } from './data';
import { caseGroup, caseId, caseOf, caseOfTwin, GROUP_WORD, SLOTS, twinOf, type SlotName } from './model';
import type { Target, TargetOpts } from './target';

export interface PoolSettings {
  /** case ids (`${slot}-${n}`) */
  ids: string[];
  /** draw a picked case on any slot, as its mirror */
  mirrors: boolean;
  /** the pairs not targeted: scrambled, or solved where they can be */
  rest: NonNullable<TargetOpts['rest']>;
}
const { settings: pool, save } = persisted<PoolSettings>('zzf2l-pool', { ids: [], mirrors: false, rest: 'mixed' }, (s) => {
  if (!Array.isArray(s.ids)) s.ids = [];
  s.ids = s.ids.filter((id) => caseOf(id));
  if (s.rest !== 'solved') s.rest = 'mixed';
  s.mirrors = !!s.mirrors;
});
export { pool };
export const savePool = save;
export const isPicked = (id: string): boolean => pool.ids.includes(id);
export function togglePick(id: string): void { pool.ids = isPicked(id) ? pool.ids.filter((x) => x !== id) : [...pool.ids, id]; save(); }
export function setPicks(ids: readonly string[]): void { pool.ids = [...new Set(ids)].filter((id) => caseOf(id)); save(); }

/** The cases a draw can land on: the picked ones, and with `mirrors` each one's twin on every other slot. */
export function poolTargets(p: Pick<PoolSettings, 'ids' | 'mirrors'> = pool): Target[] {
  const out = new Map<string, Target>();
  for (const id of p.ids) {
    const hit = caseOf(id);
    if (!hit) continue;
    const slots: SlotName[] = p.mirrors ? [...SLOTS] : [hit.slot];
    for (const s of slots) {
      const c = s === hit.slot ? hit.c : caseOfTwin(s, twinOf(hit.slot, hit.c.n));
      if (c) out.set(caseId(s, c.n), { slot: s, n: c.n });
    }
  }
  return [...out.values()];
}

/** The picked cases' front-right twins, as the practice table names them. */
export function pickedTwins(): Set<string> {
  return new Set(pool.ids.flatMap((id) => { const hit = caseOf(id); return hit ? [String(twinOf(hit.slot, hit.c.n))] : []; }));
}

/** A case from the pool at random, not the one just done when there is another. */
export function drawTarget(targets: readonly Target[], last: Target | null, rnd: () => number = Math.random): Target | null {
  const fresh = targets.length > 1 && last ? targets.filter((t) => t.slot !== last.slot || t.n !== last.n) : targets;
  return fresh.length ? fresh[Math.floor(rnd() * fresh.length)]! : null;
}

// ---- the practice so far: attempts are filed by the slot's case id; the table merges the four mirrors ----

/** A case's name everywhere a number is shown: its front-right twin's number. */
export const caseLabel = (slot: SlotName, n: number): string => String(twinOf(slot, n));
/** The practice table's rows: the 83 front-right cases, each standing for its mirrors on the other slots. */
export function practiceCases(): { id: string; name: string; group: string }[] {
  return Object.values(DATA.slots.FR.cases).sort((a, b) => a.n - b.n).map((c) => ({ id: caseId('FR', c.n), name: String(c.n), group: GROUP_WORD[caseGroup('FR', c)] }));
}
/** The attempts with their case put as the front-right twin's name, so the four mirrors count as one case. */
export function byTwin(attempts: readonly AttemptRecord[]): AttemptRecord[] {
  return attempts.flatMap((a) => {
    const hit = a.caseId ? caseOf(a.caseId) : null;
    return hit ? [{ ...a, caseId: String(twinOf(hit.slot, hit.c.n)) }] : [];
  });
}

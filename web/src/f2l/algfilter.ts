// The F2L move filter: which kinds of move (R and L together, D, F2/B2, F/B quarter turns, wide/slice, and a cross
// edge brought up on the way) the finder and the case sheet list algs with (user, 2026-09-26: "only show certain
// algs, and maybe hide F2 for now"). One setting, stored, shared by both; F2/B2 and the cross coming up hidden to
// begin with. The model holds the set (model.shownAlg reads it).
import { readStored, writeStored } from '../ui/settings';
import { ALG_TOOLS, hiddenTools, setHiddenTools, toolCounts, TOOL_WORD, type AlgTool, type SlotName } from './model';

const KEY = 'zzf2l-hide3';
// the filters stored before: 2026-09-28 to 2026-09-30, before the cross-comes-up kind existed (it is added, hidden,
// as it is for a fresh install); and before 2026-09-28, when D, F2/B2 and wide/slice were one kind each: a stored
// kind widens to its parts
const KEY2 = 'zzf2l-hide2', OLD_KEY = 'zzf2l-hide';
const WIDENED: Record<string, AlgTool[]> = { D: ['D', 'D2'], F2: ['F2', 'F2x'], wide: ['wide', 'slice'] };
const listeners: (() => void)[] = [];
let loaded = false;
/** The stored filter into the model, once. */
export function loadAlgFilter(): void {
  if (loaded) return;
  loaded = true;
  const v = readStored(KEY);
  if (v !== null) { setHiddenTools(v.split(',').filter(Boolean) as AlgTool[]); return; }
  const v2 = readStored(KEY2);
  if (v2 !== null) { setHiddenTools([...v2.split(',').filter(Boolean) as AlgTool[], 'crossUp']); return; }
  const old = readStored(OLD_KEY);
  if (old !== null) setHiddenTools([...old.split(',').filter(Boolean).flatMap((t) => WIDENED[t] ?? [t as AlgTool]), 'crossUp']);
}
/** Show or hide a kind of move, stored; everyone listening redraws. */
export function toggleTool(t: AlgTool): void {
  loadAlgFilter();
  const h = new Set(hiddenTools());
  if (h.has(t)) h.delete(t); else h.add(t);
  setHiddenTools(h);
  writeStored(KEY, [...h].join(','));
  for (const f of listeners) f();
}
export const onAlgFilterChange = (f: () => void): void => { listeners.push(f); };
/**
 * The chips, one per kind of move, lit when shown, each with the number of algs it alone shows or hides (on `slots`'
 * sheets; all four by default) so the setting says what it does; `attr` names the data attribute a tap is read from.
 */
export function toolChipsHtml(attr: string, value: (t: AlgTool) => string = (t) => t, slots?: readonly SlotName[]): string {
  loadAlgFilter();
  const n = toolCounts(slots);
  return ALG_TOOLS.map((t) => `<button type="button" class="eo-chip${hiddenTools().has(t) ? '' : ' on'}" ${attr}="${value(t)}" aria-pressed="${!hiddenTools().has(t)}" title="${n[t].algs} alg${n[t].algs === 1 ? '' : 's'} in ${n[t].cases} case${n[t].cases === 1 ? '' : 's'} ${hiddenTools().has(t) ? 'hidden' : 'shown'} by this">${TOOL_WORD[t]}<small>${n[t].algs}</small></button>`).join('');
}

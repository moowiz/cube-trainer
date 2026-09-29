// The F2L move filter: which kinds of move (R and L together, D, F2/B2, F/B quarter turns, wide/slice) the finder and
// the case sheet list algs with (user, 2026-09-26: "only show certain algs, and maybe hide F2 for now"). One setting,
// stored, shared by both; F2/B2 hidden to begin with. The model holds the set (model.shownAlg reads it).
import { readStored, writeStored } from '../ui/settings';
import { ALG_TOOLS, hiddenTools, setHiddenTools, toolCounts, TOOL_WORD, type AlgTool, type SlotName } from './model';

const KEY = 'zzf2l-hide';
const listeners: (() => void)[] = [];
let loaded = false;
/** The stored filter into the model, once. */
export function loadAlgFilter(): void {
  if (loaded) return;
  loaded = true;
  const v = readStored(KEY);
  if (v !== null) setHiddenTools(v.split(',').filter(Boolean) as AlgTool[]);
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

// Where each practice stretch stops (the mode picker's cells), in one place: the modes read it for the rail and the
// chip, and the EO page reads it for where its attempt ends (user, 2026-09-27: the page's own "Timed until" said the
// same thing again - the stop is the one control). The phases are the strip's: EO, then the cross, then F2L, ...

import type { SplitStage } from '../timer/splits';
import { readStoredJson, writeStored } from '../ui/settings';

const STOP_KEY = 'zz-stop';
/** The phases in order, as the picker's columns. */
export const PHASES: readonly SplitStage[] = ['eo', 'cross', 'f2l', 'ocll', 'pll'];
export const phaseRank = (s: SplitStage): number => PHASES.indexOf(s);
/** The rows a stretch can start at. */
export type StopStart = 'eo' | 'f2l' | 'ocll';
// DECISION: EO on to the cross (the user's drill, 2026-09-27), F2L alone, OCLL on into PLL
const STOP_DEFAULT: Record<StopStart, SplitStage> = { eo: 'cross', f2l: 'f2l', ocll: 'pll' };

/** Once: the EO page's old goal ("EO" / "EO, then cross" / "EOCross") becomes the EO row's stop. */
function migrate(): void {
  const eo = readStoredJson('zz-eo-settings') as { goal?: string } | null;
  if (!eo || eo.goal === undefined) return;
  const st = (readStoredJson(STOP_KEY) as Partial<Record<StopStart, SplitStage>> | null) ?? {};
  if ((st.eo ?? 'eo') === 'eo') writeStored(STOP_KEY, JSON.stringify({ ...st, eo: eo.goal === 'eo' ? 'eo' : 'cross' }));
  const rest: Record<string, unknown> = { ...eo };
  delete rest.goal;
  writeStored('zz-eo-settings', JSON.stringify(rest));
}
migrate();

/** Where the stretch starting at `start` stops. */
export function stopOf(start: StopStart): SplitStage {
  const st = readStoredJson(STOP_KEY) as Partial<Record<StopStart, SplitStage>> | null;
  const s = st?.[start];
  return s && PHASES.includes(s) && phaseRank(s) >= phaseRank(start) && !(start === 'eo' && s === 'pll') && !(start !== 'eo' && s === 'cross') ? s : STOP_DEFAULT[start];
}
const listeners = new Set<() => void>();
export function setStop(start: StopStart, stop: SplitStage): void {
  const st = (readStoredJson(STOP_KEY) as Partial<Record<StopStart, SplitStage>> | null) ?? {};
  writeStored(STOP_KEY, JSON.stringify({ ...st, [start]: stop }));
  for (const l of listeners) l();
}
export const onStopChange = (l: () => void): void => { listeners.add(l); };
/** The EO page's attempt runs on to the cross (the EO row stops at the cross or later), rather than ending at EO. */
export const eoToCross = (): boolean => stopOf('eo') !== 'eo';

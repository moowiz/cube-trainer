// The inspection clock's switch (user, 2026-09-26): one setting for the Solve tab and the EOCross drill -
// the time from the scramble on the cube to the first turn, shown counting up while you plan. Off only
// hides it; the time is recorded either way. Each mode's settings row flips it (the rail's button went to the settings, 2026-09-27: the rail was cramped).

import { readStored, writeStored } from './settings';

const KEY = 'zz-inspect';
let on = readStored(KEY) !== 'off';
const listeners = new Set<() => void>();

export const inspectOn = (): boolean => on;
export function setInspect(v: boolean): void {
  if (v === on) return;
  on = v;
  writeStored(KEY, v ? 'on' : 'off');
  for (const l of listeners) l();
}
export function onInspectChange(l: () => void): void { listeners.add(l); }

/** Wire every settings row `[data-inspect]` (an .eo-seg with Off / On buttons) to the switch. */
export function wireInspectRows(): void {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-inspect]')];
  const paint = () => rows.forEach((r) => r.querySelectorAll<HTMLElement>('button[data-v]').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'on') === on)));
  for (const r of rows) r.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-v]'); if (b) setInspect(b.dataset.v === 'on'); });
  onInspectChange(paint);
  paint();
}

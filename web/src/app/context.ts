// Shared page state the app modules read (docs/housekeeping-plan.md 3):
// the trainer's hold, the solve store, the last scan lock, and the panel
// lookup. Nothing here decides anything; the modules that do import it.

import { faceColorName } from '../cube/scheme';
import type { Hold, ScannedCube } from '../handoff';
import { openStore } from '../store/local';
import { COLOR_NAMES, type ColorName } from '../types';

export const panel = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`index.html is missing #${id}`);
  return e;
};

/** The colour the trainer shows in front, as the scanner names colours. */
export function frontColour(): ColorName {
  const name = faceColorName('F');
  return (COLOR_NAMES as readonly string[]).includes(name) ? (name as ColorName) : 'blue';
}

/** How the trainer holds the cube: white down, the chosen colour in front. */
export const hold = (): Hold => ({ down: 'white', front: frontColour() });

/** The solve store: local always, synced when switched on (settings). */
export const store = openStore();

let lastScan: ScannedCube | null = null;
/** The last scan lock the scanner handed to the trainer (the smart cube's "resync from the scan"). */
export const scans = {
  last: (): ScannedCube | null => lastScan,
  set(s: ScannedCube): void { lastScan = s; },
};

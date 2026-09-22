// The colour scheme the trainers draw and talk in: white is always down
// (D), yellow up, and the setting is which colour faces you. Standard cube:
// blue - red - green - orange going round, so the front colour fixes the
// other three. One place, persisted, with listeners for repaints.

const SIDES: readonly [string, string][] = [['blue', '#2E6CE0'], ['red', '#E2433C'], ['green', '#33B15D'], ['orange', '#F58F2A']];
const UD: Record<string, [string, string]> = { U: ['yellow', '#F5D63D'], D: ['white', '#FBFBF9'] };
const SIDE_ORDER = ['F', 'R', 'B', 'L'];
const KEY = 'zz-scheme';

let front = 0; // index into SIDES of the colour in front
try { const v = Number(localStorage.getItem(KEY)); if (v >= 0 && v < 4) front = v; } catch { /* no storage */ }

const listeners = new Set<() => void>();

/** Index of the front colour (0 blue, 1 red, 2 green, 3 orange), as the settings select stores it. */
export function frontIndex(): number { return front; }

export function setFrontIndex(i: number): void {
  const v = ((Math.round(i) % 4) + 4) % 4;
  if (v === front) return;
  front = v;
  try { localStorage.setItem(KEY, String(v)); } catch { /* no storage */ }
  for (const l of listeners) l();
}

/** Repaint when the scheme changes. */
export function onSchemeChange(l: () => void): void { listeners.add(l); }

/** The colour name a face letter shows in the trainers' frame. */
export function faceColorName(f: string): string {
  if (f in UD) return UD[f][0];
  return SIDES[(front + SIDE_ORDER.indexOf(f)) % 4][0];
}

/** The colour a face letter is drawn in. */
export function faceHex(f: string): string {
  if (f in UD) return UD[f][1];
  return SIDES[(front + SIDE_ORDER.indexOf(f)) % 4][1];
}

/** The options for the settings select, in index order. */
export const FRONT_OPTIONS: readonly string[] = SIDES.map(([name], i) => `${name} (${SIDES[(i + 1) % 4][0]} on the right)`);

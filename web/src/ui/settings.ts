// Settings that survive a refresh, in localStorage. Nothing here is a gate
// on anything: a missing or unreadable store (private mode, quota, an old
// shape) just leaves the default standing.
//
// Three shapes (docs/maintenance-plan.md 3.4):
//   readStored / writeStored  one string under a key (the tab, the scheme, a mode)
//   persisted                 an object of settings with defaults, and its save()
//   persistControls           the scan sheet's: a setting IS a control, mirrored
//                             to one record on every change

/** The string stored under `key`, or null when there is none (or no storage). */
export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Store a string under `key`; null removes it. Private mode and quota are silently nothing. */
export function writeStored(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* no storage */ }
}

/** The JSON stored under `key`, or null when there is none or it does not parse. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * A settings object under `key`: `defaults` overlaid with whatever was stored (unknown fields
 * kept, as Object.assign leaves them), then `fix` run over the result to put back anything an
 * older version or a hand edit left out of range. `save()` writes the object as it is now.
 */
export function persisted<T extends object>(key: string, defaults: T, fix?: (s: T) => void): { settings: T; save(): void } {
  const settings = defaults;
  const stored = readStoredJson(key);
  if (stored && typeof stored === 'object') Object.assign(settings, stored);
  fix?.(settings);
  return { settings, save: () => writeStored(key, JSON.stringify(settings)) };
}

// ---- the scan sheet's controls ----------------------------------------------------------------
// Restoring sets values only - the page dispatches 'change' itself once its
// listeners exist, so the same code path handles a restored value and a click.

const KEY = 'cube.scan.settings.v1';

type Stored = Record<string, string | boolean>;

function read(): Stored {
  const v = readStoredJson(KEY);
  return v && typeof v === 'object' ? (v as Stored) : {};
}

function write(s: Stored): void {
  writeStored(KEY, JSON.stringify(s));
}

function stateOf(el: HTMLElement): string | boolean | null {
  if (el instanceof HTMLDetailsElement) return el.open;
  if (el instanceof HTMLInputElement) return el.type === 'checkbox' ? el.checked : el.value;
  if (el instanceof HTMLSelectElement) return el.value;
  return null;
}

/** Apply a stored value; false when it does not fit the control (a select
 *  without that option, a type change) so the default stands. */
function apply(el: HTMLElement, v: string | boolean): boolean {
  if (el instanceof HTMLDetailsElement && typeof v === 'boolean') { el.open = v; return true; }
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && typeof v === 'boolean') { el.checked = v; return true; }
  if (el instanceof HTMLInputElement && el.type !== 'checkbox' && typeof v === 'string') { el.value = v; return true; }
  if (el instanceof HTMLSelectElement && typeof v === 'string' && [...el.options].some((o) => o.value === v)) { el.value = v; return true; }
  return false;
}

/**
 * Restore the given controls (keyed by their name in the store) and keep
 * the store current from now on. Returns the controls whose value was
 * actually restored, for the caller to dispatch 'change' on.
 */
export function persistControls(controls: Record<string, HTMLElement>): HTMLElement[] {
  const stored = read();
  const restored: HTMLElement[] = [];
  for (const [key, el] of Object.entries(controls)) {
    const v = stored[key];
    if (v !== undefined && apply(el, v)) restored.push(el);
    el.addEventListener(el instanceof HTMLDetailsElement ? 'toggle' : 'change', () => {
      const s = read();
      const now = stateOf(el);
      if (now === null) return;
      s[key] = now;
      write(s);
    });
  }
  return restored;
}

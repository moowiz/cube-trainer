// Page settings that survive a refresh. A setting IS a control (checkbox,
// select, text input, or a <details> panel): its state is mirrored to one
// localStorage record on every change and written back on the next load.
// Restoring sets values only - the page dispatches 'change' itself once its
// listeners exist, so the same code path handles a restored value and a
// click. Nothing here is a gate on the pipeline: a missing or unreadable
// store just leaves every control at its markup default.

const KEY = 'cube.scan.settings.v1';

type Stored = Record<string, string | boolean>;

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Stored) : {};
  } catch {
    return {};
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* private mode, quota: settings just don't persist */ }
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
 * Restore the given controls (by element id) from the store and keep the
 * store current from now on. Returns the controls whose value was actually
 * restored, for the caller to dispatch 'change' on.
 */
export function persistControls(ids: string[]): HTMLElement[] {
  const stored = read();
  const restored: HTMLElement[] = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = stored[id];
    if (v !== undefined && apply(el, v)) restored.push(el);
    el.addEventListener(el instanceof HTMLDetailsElement ? 'toggle' : 'change', () => {
      const s = read();
      const now = stateOf(el);
      if (now === null) return;
      s[id] = now;
      write(s);
    });
  }
  return restored;
}

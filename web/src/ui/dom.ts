// The three DOM chores every sheet and trainer was writing for itself
// (docs/maintenance-plan.md 3.7): an HTML escape, a scoped lookup that
// throws, and a <style> injected once.

/** The two characters that make text unsafe inside an element's HTML. Attributes need more; nothing here writes one. */
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * A lookup that throws: `$('sol')` is the element `sel('sol')` finds under `root`, or an error
 * naming `what`, so a template edit that drops an element fails at mount and not on first click.
 * An element moved out of `root` since (a stage's option rows, taken into its mode's settings
 * sheet by app/modes.ts) is found in the page: the ids are the page's own.
 */
export function scoped(root: ParentNode, sel: (name: string) => string, what: string): <T extends HTMLElement = HTMLElement>(name: string) => T {
  return <T extends HTMLElement = HTMLElement>(name: string): T => {
    const e = root.querySelector<T>(sel(name)) ?? (typeof document !== 'undefined' && sel(name).startsWith('#') ? document.querySelector<T>(sel(name)) : null);
    if (!e) throw new Error(`${what} has no ${sel(name)}`);
    return e;
  };
}

/** Append `<style id>` to the head the first time; a second mount of the same module adds nothing. */
export function ensureStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}

/**
 * The page's zoom at `el` (index.html zooms <html> on wide screens). Pointer coordinates, getBoundingClientRect
 * and window.innerWidth are in screen px; offsetWidth and style.left are in the element's own px, smaller by
 * this factor. A tooltip placed from a pointer position must divide by it, or it lands to the right of the
 * pointer by 20-40% of the way across on a wide monitor.
 */
export function zoomAt(el: HTMLElement): number {
  const w = el.offsetWidth;
  return w ? el.getBoundingClientRect().width / w : 1;
}

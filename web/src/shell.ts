// The page shell: the stage tabs, the scan and settings sheets, the toast,
// the keyboard shortcuts, and the bus the stages and the scanner bridge talk
// through. The markup lives in index.html; this wires it.

import { FRONT_OPTIONS, faceColorName, frontIndex, setFrontIndex } from './cube/scheme';

export const TABS = ['eo', 'f2l', 'ocll', 'pll'] as const;
export type Tab = (typeof TABS)[number];

/** What every stage offers the shell. Scrambles are in the trainer frame (white down, chosen colour front). */
export interface Stage {
  /** Show the cube reached by this trainer-frame scramble from solved. */
  load(scramble: string): void;
  /** Repaint (the colour scheme changed). */
  render(): void;
  /** The scramble the stage is on, or null. */
  scramble(): string | null;
  /** A fresh random scramble / case. */
  newScramble(): void;
}

export const stages: Partial<Record<Tab, Stage>> = {};

const el = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`index.html is missing #${id}`);
  return e;
};

export function activeTab(): Tab {
  return TABS.find((k) => !el(`${k}-panel`).hidden) ?? 'eo';
}

export function showTab(t: Tab): void {
  for (const k of TABS) {
    el(`${k}-panel`).hidden = k !== t;
    document.querySelector(`.tabs button[data-t="${k}"]`)?.classList.toggle('on', k === t);
  }
  try { localStorage.setItem('zz-tab', t); } catch { /* no storage */ }
}

/** How the trainer holds the cube, in words, for the moves typed into it. */
export function trainerHold(): string {
  return `white down, ${faceColorName('F')} facing you`;
}

// ---- sheets: the scanner, the settings and the fingertricks float over whichever stage is open ----
export function sheetOpen(): boolean {
  return !!document.querySelector('.zz-sheet:not([hidden])');
}
export function openSheet(id: string): void {
  el(id).hidden = false;
  document.body.style.overflow = 'hidden';
}
export function closeSheet(id: string): void {
  el(id).hidden = true;
  if (!sheetOpen()) document.body.style.overflow = '';
}

/** The scanner bridge fills these in: run the camera while the scan sheet is up. */
export const scanHooks: { onOpen(opts?: { keep?: boolean }): void; onClose(): void } = { onOpen: () => undefined, onClose: () => undefined };

/** Open the scanner; a fresh scan unless `keep` asks for the one in progress. */
export function openScan(opts?: { keep?: boolean }): void {
  openSheet('scan-sheet');
  scanHooks.onOpen(opts);
}
export function closeScan(): void {
  closeSheet('scan-sheet');
  scanHooks.onClose();
}
export function resumeScan(): void { openScan({ keep: true }); }
/** Show the Resume button once there is a scan to come back to. */
export function scanStarted(): void { el('scan-resume').hidden = false; }

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/** The scramble the open stage expects the cube to be in (trainer frame), or null. */
export function expectedScramble(): string | null {
  return stages[activeTab()]?.scramble() ?? null;
}

/** Wire the shell once the stages are registered. `initialTab` overrides the remembered one. */
export function initShell(): void {
  // tabs
  document.querySelectorAll<HTMLButtonElement>('.tabs button[data-t]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.t as Tab)));
  // sheets
  el('scan-open').onclick = () => openScan();
  el('scan-resume').onclick = () => resumeScan();
  el('scan-close').onclick = () => closeScan();
  el('settings-open').onclick = () => openSheet('settings-sheet');
  el('settings-close').onclick = () => closeSheet('settings-sheet');
  el('tricks-close').onclick = () => closeSheet('tricks-sheet');
  const closeSheetEl = (s: HTMLElement) => (s.id === 'scan-sheet' ? closeScan() : closeSheet(s.id));
  document.querySelectorAll<HTMLElement>('.zz-sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheetEl(s); }));
  // keys: Escape closes a sheet; c / r open the scanner (fresh / resumed), s the settings, from any stage - all under the right hand on Dvorak
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const s = document.querySelector<HTMLElement>('.zz-sheet:not([hidden])'); if (s) closeSheetEl(s); return; }
    if (sheetOpen() || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'c') openScan();
    else if (e.key === 'r' && !el('scan-resume').hidden) resumeScan();
    else if (e.key === 's') openSheet('settings-sheet');
  });
  // the colour scheme select
  const sel = el('frontc') as HTMLSelectElement;
  sel.innerHTML = FRONT_OPTIONS.map((o, i) => `<option value="${i}">${o}</option>`).join('');
  sel.value = String(frontIndex());
  sel.addEventListener('change', () => setFrontIndex(Number(sel.value)));
  // which tab: ?tab=... wins, then the remembered one; ?tab=scan opens the scanner over it (the replay tooling's URL)
  let tab: string = 'eo';
  try { tab = localStorage.getItem('zz-tab') || 'eo'; } catch { /* no storage */ }
  const want = new URLSearchParams(location.search).get('tab');
  if (want && want !== 'scan') tab = want;
  showTab((TABS as readonly string[]).includes(tab) ? (tab as Tab) : 'eo');
  if (want === 'scan') openScan();
}

// a window.ZZ facade for the headless checks and the page's own console use
declare global {
  interface Window { ZZ: unknown }
}
if (typeof window !== 'undefined') { // importable from node tests (fingertricks.test.ts)
  window.ZZ = {
    tabs: TABS, showTab, activeTab, openScan, closeScan, resumeScan, sheetOpen, toast, expectedScramble, stages,
    get eo() { return stages.eo; }, get f2l() { return stages.f2l; }, get ocll() { return stages.ocll; }, get pll() { return stages.pll; },
  };
}

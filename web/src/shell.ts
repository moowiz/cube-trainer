// The page shell: the stage tabs, the scan and settings sheets, the toast,
// the keyboard shortcuts, and the bus the stages and the scanner bridge talk
// through. The markup lives in index.html; this wires it.

import { FRONT_OPTIONS, faceColorName, frontIndex, setFrontIndex } from './cube/scheme';
import type { ColorName, FaceId } from './types';
import { readStored, writeStored } from './ui/settings';

const TABS = ['solve', 'eo', 'f2l', 'ocll', 'pll'] as const;
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
  /** The turns made so far on a cube that was at this stage's scramble (trainer letters), at host time `t`, from a smart cube or the camera; true once they reach the target. */
  feed?(text: string, t: number, source?: 'cube' | 'camera'): boolean;
  /** The cube that feeds this stage reached its scramble at host time `t` (inspection may start). */
  armed?(t: number): void;
  /** The belief of the cube that feeds this stage changed (its letters coloured `colourOf`), before arming too; `turn` is the move that did it (trainer letters), if a move did. */
  watch?(facelets: string | null, colourOf: Record<FaceId, ColorName>, turn?: string): void;
}

export const stages: Partial<Record<Tab, Stage>> = {};

// One scramble for every tab (user, 2026-09-17): whichever tab makes a new scramble, a case setup,
// or carries the cube on (Continue, a scan lock, follow mode) hands the resulting trainer-frame alg
// to every other tab, so switching tabs mid-practice keeps the cube. A tab not yet at its stage says
// so (the last-layer tabs: "this cube is at EO"; F2L: "EO is not solved on this state").
let shared: string | null = null;
let ready = false; // initShell() done: until then every tab is making its first scramble, and none of those is the cube
/** The scramble every tab shows, trainer frame; null before the first one. */
function sharedScramble(): string | null { return shared; }
/**
 * Give `scramble` to every tab but `from` (the one that already has it; null: all of them). A tab that
 * is not the one open (its first scramble at mount, the Solve tab's first one arriving later) keeps it
 * to itself: the open tab's case is the cube, and a refresh on the PLL tab lands on a PLL case.
 */
export function shareScramble(scramble: string, from: Tab | null): void {
  if (from !== null && (!ready || from !== activeTab())) return;
  shared = scramble;
  for (const t of TABS) if (t !== from && t !== kept) stages[t]?.load(scramble);
}
let kept: Tab | null = null;
/** A tab no share may load (null: none): the Solve tab while its timer runs a solve the cube's follow is carrying through the stages. */
export function keepScramble(tab: Tab | null): void { kept = tab; }

const el = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`index.html is missing #${id}`);
  return e;
};

export function activeTab(): Tab {
  return TABS.find((k) => !el(`${k}-panel`).hidden) ?? 'eo';
}

const tabListeners = new Set<(t: Tab) => void>();
/** Hear every tab switch (a tap, a lock routed, a follow moving on), after it is shown. */
export function onTabChange(cb: (t: Tab) => void): () => void {
  tabListeners.add(cb);
  return () => { tabListeners.delete(cb); };
}

export function showTab(t: Tab): void {
  for (const k of TABS) {
    el(`${k}-panel`).hidden = k !== t;
    document.querySelector(`.tabs button[data-t="${k}"]`)?.classList.toggle('on', k === t);
  }
  writeStored('zz-tab', t);
  for (const cb of tabListeners) cb(t);
}

/** How the trainer holds the cube, in words, for the moves typed into it. */
export function trainerHold(): string {
  return `white down, ${faceColorName('F')} facing you`;
}

// ---- sheets: the scanner, the settings and the fingertricks float over whichever stage is open ----
// A DOCKED sheet (the scanner following a solve, shrunk to a corner) is up but not open: the stage under it is live.
export function sheetOpen(): boolean {
  return !!document.querySelector('.zz-sheet:not([hidden]):not(.docked)');
}
export function openSheet(id: string): void {
  el(id).hidden = false;
  el(id).classList.remove('docked');
  document.body.style.overflow = 'hidden';
}
export function closeSheet(id: string): void {
  el(id).hidden = true;
  el(id).classList.remove('docked');
  if (!sheetOpen()) document.body.style.overflow = '';
}

/** The scanner bridge fills these in: run the camera while the scan sheet is up; lay it out docked or in full. */
export const scanHooks: { onOpen(opts?: { keep?: boolean }): void; onClose(): void; onDock(on: boolean): void } = { onOpen: () => undefined, onClose: () => undefined, onDock: () => undefined };

/** Open the scanner; a fresh scan unless `keep` asks for the one in progress. */
export function openScan(opts?: { keep?: boolean }): void {
  openSheet('scan-sheet');
  scanHooks.onDock(false);
  scanHooks.onOpen(opts);
}
export function closeScan(): void {
  closeSheet('scan-sheet');
  scanHooks.onClose();
}
function resumeScan(): void { openScan({ keep: true }); }

/** The algs sheet fills this in: draw the chosen puzzle's algs when the sheet opens. */
export const algsHooks: { onOpen(): void } = { onOpen: () => undefined };
/** Open the algs sheet (the other puzzles' cheat sheet). */
function openAlgs(): void {
  openSheet('algs-sheet');
  algsHooks.onOpen();
}
/** Shrink the open scan sheet to a corner dock (the camera keeps running) or bring it back up in full. */
export function dockScan(on: boolean): void {
  const s = el('scan-sheet');
  if (s.hidden) return;
  s.classList.toggle('docked', on);
  el('scan-dock').hidden = on;
  document.body.style.overflow = sheetOpen() ? 'hidden' : '';
  scanHooks.onDock(on);
}
function scanDocked(): boolean { return !el('scan-sheet').hidden && el('scan-sheet').classList.contains('docked'); }
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
  el('scan-dock').onclick = () => dockScan(true);
  // a click on the dock (not on its Stop button) brings the sheet back up
  el('scan-sheet').addEventListener('click', (e) => { if (scanDocked() && !(e.target as HTMLElement).closest('button')) dockScan(false); });
  el('settings-open').onclick = () => openSheet('settings-sheet');
  el('settings-close').onclick = () => closeSheet('settings-sheet');
  el('cube-open').onclick = () => openSheet('cube-sheet');
  el('cube-close').onclick = () => closeSheet('cube-sheet');
  el('algs-open').onclick = () => openAlgs();
  el('algs-close').onclick = () => closeSheet('algs-sheet');
  el('tricks-close').onclick = () => closeSheet('tricks-sheet');
  el('ref-close').onclick = () => closeSheet('ref-sheet');
  el('stats-close').onclick = () => closeSheet('stats-sheet');
  const closeSheetEl = (s: HTMLElement) => (s.id === 'scan-sheet' ? closeScan() : closeSheet(s.id));
  document.querySelectorAll<HTMLElement>('.zz-sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheetEl(s); }));
  // keys: Escape closes a sheet; c / r open the scanner (fresh / resumed), s the settings, l the cube, a the algs, from any stage - all under the right hand on Dvorak
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const s = document.querySelector<HTMLElement>('.zz-sheet:not([hidden])'); if (s) closeSheetEl(s); return; }
    if (sheetOpen() || e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'c') openScan();
    else if (e.key === 'r' && !el('scan-resume').hidden) resumeScan();
    else if (e.key === 's') openSheet('settings-sheet');
    else if (e.key === 'l') openSheet('cube-sheet');
    else if (e.key === 'a') openAlgs();
  });
  // the colour scheme select
  const sel = el('frontc') as HTMLSelectElement;
  sel.innerHTML = FRONT_OPTIONS.map((o, i) => `<option value="${i}">${o}</option>`).join('');
  sel.value = String(frontIndex());
  sel.addEventListener('change', () => setFrontIndex(Number(sel.value)));
  // which tab: ?tab=... wins, then the remembered one; ?tab=scan opens the scanner over it (the replay tooling's URL),
  // ?tab=algs the algs sheet (the manifest's home-screen shortcut)
  let tab: string = readStored('zz-tab') || 'solve';
  const want = new URLSearchParams(location.search).get('tab');
  if (want && want !== 'scan' && want !== 'algs') tab = want;
  showTab((TABS as readonly string[]).includes(tab) ? (tab as Tab) : 'eo');
  ready = true;
  const own = stages[activeTab()]?.scramble(); // the open tab's first scramble is the cube for the others
  if (own) shareScramble(own, activeTab());
  if (want === 'scan') openScan();
  if (want === 'algs') openAlgs();
}

// a window.ZZ facade for the headless checks and the page's own console use
declare global {
  interface Window { ZZ: unknown }
}
if (typeof window !== 'undefined') { // importable from node tests (fingertricks.test.ts)
  window.ZZ = {
    tabs: TABS, showTab, activeTab, openScan, closeScan, resumeScan, dockScan, scanDocked, sheetOpen, toast, expectedScramble, stages, shareScramble, sharedScramble, openAlgs,
    get solve() { return stages.solve; }, get eo() { return stages.eo; }, get f2l() { return stages.f2l; }, get ocll() { return stages.ocll; }, get pll() { return stages.pll; },
  };
}

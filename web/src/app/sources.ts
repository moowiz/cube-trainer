// The active MoveSource and the drill drivers over it (docs/smart-cube-
// design.md 1 and 3.4): the smart cube when it is connected, else the
// camera reader while it follows a solve. Every item goes to the open
// stage - the belief for scramble following, the arming moment, and the
// turns since the scramble in the trainer's letters until the stage says
// they are done - and to the PINNED stage, if one is: the Solve tab's
// timer keeps timing while the cube's follow moves the drill tabs along
// (cubefollow.ts). Each stage has its own driver; a stage that is neither
// open nor pinned starts over when it is opened again. Listeners (the
// live view) hear every item and every switch. Nothing here knows which
// kind of source it is holding.

import { expectedFacelets, relabelTurns } from '../handoff';
import { DrillDriver } from '../moves/drive';
import type { MoveSource, SourceItem } from '../moves/source';
import { activeTab, stages, type Tab } from '../shell';
import { hold } from './context';

let active: MoveSource | null = null;
let fallback: MoveSource | null = null;
let unsub: (() => void) | null = null;
/** one driver per stage, with the scramble it was last stepped on */
const drivers = new Map<Tab, { driver: DrillDriver; lastKey: string | null }>();
const driverOf = (tab: Tab) => { let d = drivers.get(tab); if (!d) { d = { driver: new DrillDriver(), lastKey: null }; drivers.set(tab, d); } return d; };
let pinned: Tab | null = null;   // a stage fed even while another is open
let lastOpen: Tab | null = null; // the tab last stepped as the open one
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function activeSource(): MoveSource | null { return active; }

/** Called on every item of the active source and whenever the active source changes. */
export function onSourceChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Make `src` the source the stages and the live view follow (null: none). The driver starts over:
 * items the new source already holds are history, and it arms again when the belief reaches the
 * open stage's scramble.
 */
export function useSource(src: MoveSource | null): void {
  if (src === active) return;
  unsub?.();
  unsub = null;
  active = src;
  for (const d of drivers.values()) { d.driver.reset(); d.lastKey = null; }
  if (src) unsub = src.subscribe(onItem);
  notify();
}

/**
 * Keep feeding `tab` while other tabs are open (null: none): the Solve tab's timer, mid-solve, while
 * the follow opens the stages the cube crosses into. Its driver keeps its arming across the switches;
 * once unpinned it starts over like any other tab the next time it is opened.
 */
export function pinStage(tab: Tab | null): void { pinned = tab; }

/** The source to fall back to when the active one is dropped (the camera reader, behind the cube). */
export function setFallback(src: MoveSource | null): void { fallback = src; }

/** `src` is gone (the cube disconnected): the fallback takes over if `src` was active. */
export function dropSource(src: MoveSource): void {
  if (fallback === src) fallback = null;
  if (active === src) useSource(fallback);
}

/**
 * Run the driver against the open stage without a new item: after a stage was opened with the
 * cube's own state loaded (follow mode), so it arms right there instead of waiting for the belief
 * to come round to that state again - it moves on with the very next turn.
 */
export function syncDriver(): void {
  // asked from inside a feed (a stage that starts its next rep the moment one is done): after the
  // step, so the finish() of the rep just judged lands on the old scramble, not on the new arming
  if (stepping) { resync = true; return; }
  step(null);
}
let stepping = false, resync = false;
/** The open stage's drill is on a solve from its own scramble (the turns are being fed to it). */
export function driverArmed(): boolean { return driverOf(activeTab()).driver.isArmed(); }

function onItem(item: SourceItem): void {
  // the open stage hears the item first, then the listeners: a follow that moves the tabs on this
  // item (it finished the stage) does so after the stage has judged it
  step(item);
  notify();
}

function step(item: SourceItem | null): void {
  stepping = true;
  try { stepOnce(item); } finally { stepping = false; }
  if (resync) { resync = false; step(null); }
}

function stepOnce(item: SourceItem | null): void {
  const src = active;
  if (!src) return;
  const tab = activeTab();
  // a tab opened afresh starts over (its arming, if any, was for an earlier visit); the pinned one carries on
  if (tab !== lastOpen) { lastOpen = tab; if (tab !== pinned) { const d = driverOf(tab); d.driver.reset(); d.lastKey = null; } }
  stepTab(tab, src, item);
  if (pinned !== null && pinned !== tab) stepTab(pinned, src, item);
}

function stepTab(tab: Tab, src: MoveSource, item: SourceItem | null): void {
  const stage = stages[tab];
  const slot = driverOf(tab);
  const driver = slot.driver;
  let turn: string | undefined;
  if (item?.kind === 'move') { try { turn = relabelTurns(src.colourOf, [item.move], hold()); } catch { turn = undefined; } }
  stage?.watch?.(src.state(), src.colourOf, turn);
  const scr = stage?.scramble() ?? null;
  let expected: string | null = null;
  if (scr !== null) { try { expected = expectedFacelets(scr, hold(), src.colourOf); } catch { expected = null; } }
  const key = scr === null ? null : `${tab}:${scr}`;
  // armed before this step on the same scramble; a new scramble's arming is always news to the stage
  const wasArmed = driver.isArmed() && key === slot.lastKey;
  slot.lastKey = key;
  const feeds = driver.step(src, expected, key);
  if (!wasArmed && driver.isArmed()) stage?.armed?.(item?.kind === 'move' ? item.t : performance.now());
  // a replayed capture is a cube for the stages' purposes; the typed box never feeds through here
  const kind = src.kind === 'camera' ? 'camera' : 'cube';
  for (const f of feeds) {
    if (!stage?.feed) break;
    let text: string;
    try { text = relabelTurns(src.colourOf, f.moves, hold()); } catch { break; }
    if (stage.feed(text, f.t, kind)) { driver.finish(); break; }
  }
}

// The active MoveSource and the drill driver over it (docs/smart-cube-
// design.md 1 and 3.4): the smart cube when it is connected, else the
// camera reader while it follows a solve. Every item goes to the open
// stage - the belief for scramble following, the arming moment, and the
// turns since the scramble in the trainer's letters until the stage says
// they are done. Listeners (the live view) hear every item and every
// switch. Nothing here knows which kind of source it is holding.

import { expectedFacelets, relabelTurns } from '../handoff';
import { DrillDriver } from '../moves/drive';
import type { MoveSource, SourceItem } from '../moves/source';
import { activeTab, stages } from '../shell';
import { hold } from './context';

let active: MoveSource | null = null;
let fallback: MoveSource | null = null;
let unsub: (() => void) | null = null;
const driver = new DrillDriver();
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
  driver.reset();
  if (src) unsub = src.subscribe(onItem);
  notify();
}

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
export function syncDriver(): void { step(null); }
/** The open stage's drill is on a solve from its own scramble (the turns are being fed to it). */
export function driverArmed(): boolean { return driver.isArmed(); }

function onItem(item: SourceItem): void {
  // the open stage hears the item first, then the listeners: a follow that moves the tabs on this
  // item (it finished the stage) does so after the stage has judged it
  step(item);
  notify();
}

function step(item: SourceItem | null): void {
  const src = active;
  if (!src) return;
  const tab = activeTab();
  const stage = stages[tab];
  let turn: string | undefined;
  if (item?.kind === 'move') { try { turn = relabelTurns(src.colourOf, [item.move], hold()); } catch { turn = undefined; } }
  stage?.watch?.(src.state(), src.colourOf, turn);
  const scr = stage?.scramble() ?? null;
  let expected: string | null = null;
  if (scr !== null) { try { expected = expectedFacelets(scr, hold(), src.colourOf); } catch { expected = null; } }
  const wasArmed = driver.isArmed();
  const feeds = driver.step(src, expected, scr === null ? null : `${tab}:${scr}`);
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

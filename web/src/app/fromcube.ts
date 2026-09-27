// "Use my cube" (user, 2026-09-26): scramble the cube your own way and tell the app that is the scramble,
// instead of following the one on show. The cube's belief, turned into the trainer's frame, is solved with
// Kociemba off the main thread; the solution backwards becomes the mode's scramble (so the solve is stored
// with a real scramble and the coach can read it), the drill driver arms on the spot - inspection starts
// now - and the cube follow treats it as the scramble reached.

import { inverse } from '../cube/alg';
import { SOLVED } from '../cube/state';
import { beliefInTrainer } from '../handoff';
import { activeTab, stages, toast, type Tab } from '../shell';
import { stageOf } from '../stage';
import { solveState } from '../state';
import { hold } from './context';
import { adoptScramble } from './cubefollow';
import { activeSource, driverArmed, syncDriver } from './sources';

/** The stages a hand scramble can stand in for: the Solve and EOCross, which start from a scrambled cube. */
const TABS: readonly Tab[] = ['solve', 'eo'];

/** "Use my cube" makes sense now: a cube connected, on the Solve or EOCross, not mid-attempt. */
export function canUseCube(): boolean {
  const st = activeSource()?.state();
  return !!st && st !== SOLVED && TABS.includes(activeTab()) && !driverArmed();
}

export async function useMyCube(): Promise<void> {
  const src = activeSource(), tab = activeTab();
  const facelets = src?.state();
  if (!src || !facelets) { toast('Connect the cube first'); return; }
  if (!TABS.includes(tab)) { toast('Use my cube works on the Solve and EOCross'); return; }
  const f = beliefInTrainer(facelets, src.colourOf, hold());
  if (!f) { toast('Could not read the cube: resync it in the Cube sheet'); return; }
  if (f === SOLVED) { toast('The cube is solved: scramble it first'); return; }
  if (tab === 'eo' && stageOf(f).stage !== 'eo') { toast('EO and the cross are already done on this cube'); return; }
  let scramble: string;
  try { scramble = inverse(await solveState(f)); } catch (e) { toast(`Could not use the cube: ${e instanceof Error ? e.message : e}`); return; }
  // turned while the solver worked, or another tab by now: the cube is not that scramble any more
  if (src.state() !== facelets || activeTab() !== tab) { toast('The cube moved: tap again when it is still'); return; }
  stages[tab]?.load(scramble);
  syncDriver();
  adoptScramble();
  toast('Your cube is the scramble: inspection started');
}

// The smart cube on the page (docs/smart-cube-design.md 3): connecting it,
// its source as the active MoveSource while it is connected, the Cube
// sheet's live view of whichever source is active, the three resyncs, the
// idle report poll, the wake lock, its events into the recording session,
// and the window.ZZ.smart hooks the headless checks replay captures with.

import { invertMap } from '../cube/frame';
import { SOLVED } from '../cube/state';
import { expectedFacelets, frameMap, relabelMoves, trainerScramble } from '../handoff';
import { toast } from '../shell';
import { bluetoothAvailable, connectCube, type CubeLink } from '../smart/adapter';
import { Capture, replay } from '../smart/capture';
import { CubeSource } from '../smart/source';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER, type ColorName } from '../types';
import { mountCubeView, type CubeView } from '../ui/cubeview';
import { downloadText } from '../ui/download';
import { hold, panel, scans } from './context';
import { rig } from './rig';
import { activeSource, dropSource, onSourceChange, useSource } from './sources';

// DECISION: a smart cube's letters are its colours on the standard scheme (white up, green front,
// red right), which is what a GAN reports; a differently coloured smart cube would need a setting.
const CUBE_COLOURS = DEFAULT_SCHEME_NAMES;
let cubeLink: CubeLink | null = null;
let cube: CubeSource | null = null;     // the connected cube, or a replayed capture; kept after a disconnect for Save
let view: CubeView;

/** The cube's source is the one the stages follow right now. */
export function cubeActive(): boolean { return cube !== null && activeSource() === cube; }

function refreshView(): void {
  const src = activeSource();
  view.setStatus(cube?.status() ?? null, cube && src === cube && cube.clock.n ? { skew: cube.clock.skewPercent(), n: cube.clock.n } : undefined);
  const state = src?.state() ?? null;
  if (!src || state === null) { view.setBelief(null); return; }
  let last: { move: string; t: number } | null = null;
  const items = src.items();
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]!; if (it.kind === 'move') { last = { move: it.move, t: it.t }; break; } }
  view.setBelief({ facelets: state, colourOf: src.colourOf, source: src.kind, lastMove: last?.move ?? null, lastMoveT: last?.t ?? null });
}

function takeSource(src: CubeSource): void {
  cube?.dispose();
  cube = src;
  useSource(src);
  refreshView();
}

/** The smart cube's capture header into the recording session, once per session and cube. */
function headerToSession(): void {
  const s = rig.current();
  if (!s || !cube || !cubeLink) return;
  void s.cubeHeader(cube.capture.header, { name: cubeLink.name, protocol: cubeLink.protocol, scheme: cube.colourOf });
}

async function connectSmartCube(): Promise<void> {
  if (cubeLink) return;
  const src = new CubeSource(CUBE_COLOURS);
  view.setBusy('Pick your cube in the browser dialog…');
  try {
    cubeLink = await connectCube({
      onEvent: (e) => {
        src.feed(e);
        const s = rig.current();
        if (s) { headerToSession(); void s.cubeEvent(e); }
        if (e.kind === 'disconnect') {
          cubeLink = null;
          dropSource(src);
          refreshView();
          toast('Smart cube disconnected');
        }
      },
      askMac: async (name) => {
        const v = window.prompt(`The browser could not read the MAC address of ${name}. Type it as the GAN app shows it (like AB:12:34:56:78:9A); it is remembered for this cube.`);
        const mac = v?.trim().toUpperCase().replace(/-/g, ':') ?? '';
        return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
      },
      onStatus: (m) => view.setBusy(m),
    });
  } catch (err) {
    view.setBusy(null);
    toast(`No cube connected: ${err instanceof Error ? err.message : err}`);
    return;
  }
  view.setBusy(null);
  takeSource(src);
  headerToSession();
  toast(`${cubeLink.name} connected`);
}

export function initSmart(): void {
  view = mountCubeView(panel('cube-panel'), {
    bluetooth: bluetoothAvailable(),
    connect: connectSmartCube,
    disconnect: async () => { await cubeLink?.disconnect().catch(() => undefined); },
    resync(how) {
      if (!cube) return;
      if (how === 'solved') cube.resync(SOLVED, 'solved');
      else if (how === 'report') { const r = cube.status().reported; if (r) cube.resync(r, 'report'); }
      else {
        const scan = scans.last();
        if (!scan) return;
        // the scanned cube, in the smart cube's letters: its trainer scramble read back in those letters
        try { cube.resync(expectedFacelets(trainerScramble(scan, hold()), hold(), cube.colourOf), 'scan'); }
        catch (err) { toast(`Cannot use the scan: ${err instanceof Error ? err.message : err}`); }
      }
      refreshView();
    },
    hasScan: () => scans.last() !== null,
    save() { if (cube) downloadText(`smart-${cube.capture.header.startedAt}.jsonl`, cube.capture.toJSONL(), 'application/x-ndjson'); },
    hold,
  });
  onSourceChange(refreshView);
  rig.onStart(headerToSession);

  // while connected: the status line every second, and, once the turns have settled, the cube's own
  // report every few seconds so a missed turn shows up as drift instead of a wrong lock later
  setInterval(() => { if (cube && cubeLink) refreshView(); }, 1000);
  // DECISION: a report every 4 s while idle for 2 s; every turn packet already carries the cube's
  // state on GAN cubes, so this only covers turns the app never received.
  setInterval(() => {
    if (!cube || !cubeLink) return;
    const s = cube.status();
    if (s.lastMoveT !== null && performance.now() - s.lastMoveT < 2000) return;
    cubeLink.requestFacelets().catch(() => undefined);
  }, 4000);

  // For the headless checks and the console: play a capture (JSONL text) as if the cube were sending
  // it, at `speed` times real time (Infinity = all at once), through the same path as a live cube.
  (window.ZZ as { smart?: unknown }).smart = {
    replay(text: string, speed = Infinity) {
      const cap = Capture.parse(text);
      const src = new CubeSource(cap.header.scheme, { kind: 'replay' });
      takeSource(src);
      // the capture's clock becomes this page's: its first event lands now
      const offset = performance.now() - (cap.events[0]?.t ?? 0);
      return replay(cap.events, (e) => src.feed({ ...e, t: e.t + offset }), { speed }).done;
    },
    status: () => cube?.status() ?? null,
    items: () => cube?.items() ?? [],
    /** a trainer-frame alg as the smart cube would report its turns (its own letters) */
    cubeAlg: (alg: string): string => {
      const letter = (c: ColorName) => FACE_ORDER.find((f) => CUBE_COLOURS[f] === c)!;
      return relabelMoves(alg, invertMap(frameMap(letter(hold().down), letter(hold().front))));
    },
  };
}

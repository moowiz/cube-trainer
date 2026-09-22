// The live view (docs/smart-cube-design.md 3.3): what the app believes the
// cube in your hands looks like - the smart cube's belief when one is
// connected, the camera's while it follows a solve - drawn in the
// trainer's hold (white down, the chosen colour in front) as the 3D
// picture and the net, with where the belief came from, the last turn,
// and the cube's own opinion when it disagrees. Also the smart cube's
// connect / disconnect / save controls and the three resyncs.
//
// Pure presentation: the host hands it beliefs and statuses.

import Cube from '../vendor/cubejs';
import { STICKERS } from '../cube/geometry';
import { DEFAULT_VIEW, orbit, render3d, renderNet, type Cell, type View } from '../cube/render';
import { faceColorName, faceHex } from '../cube/scheme';
import { SOLVED } from '../cube/state';
import type { Hold } from '../handoff';
import type { SourceKind } from '../moves/source';
import type { CubeStatus } from '../smart/belief';
import { FACE_ORDER, type ColorName, type FaceId } from '../types';
import { ensureStyle, scoped } from './dom';

interface Belief {
  /** the cube, in the source's letters */
  facelets: string;
  colourOf: Record<FaceId, ColorName>;
  source: SourceKind;
  lastMove?: string | null;
  /** host time of the last turn */
  lastMoveT?: number | null;
}

export interface CubeViewOpts {
  /** Web Bluetooth exists in this browser */
  bluetooth: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** set the smart cube's belief: solved, the last scan lock, or what the cube itself reports */
  resync(how: 'solved' | 'scan' | 'report'): void;
  hasScan(): boolean;
  /** download the session's capture */
  save(): void;
  hold(): Hold;
}

export interface CubeView {
  setBelief(b: Belief | null): void;
  setStatus(s: CubeStatus | null, clock?: { skew: number; n: number }): void;
  /** a line under the chip while connecting (null clears it) */
  setBusy(msg: string | null): void;
}

const STYLE = `
  .cv { max-width: 560px; margin: 0 auto; }
  @media (min-width: 820px) { .cv { max-width: 900px; } }
  .cv-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cv-chip { font-size: 14px; padding: 6px 10px; border-radius: 999px; background: var(--grey-ll); color: var(--ink-2); }
  .cv-chip.on { background: #DDF3E4; color: var(--good); }
  .cv-chip.drift { background: #FBE9C6; color: #7A4B00; }
  .cv-status, .cv-busy { font-size: 13px; color: var(--ink-2); margin: 2px 2px 8px; line-height: 1.5; }
  .cv-warn { background: #FBE9C6; border: 1px solid #E9C784; border-radius: 10px; padding: 10px 12px; margin: 0 0 10px; font-size: 14px; line-height: 1.45; }
  .cv-warn .btn { margin: 6px 6px 0 0; }
  .cv-pics { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: center; }
  @media (min-width: 820px) { .cv-pics { grid-template-columns: 340px 1fr; } }
  .cv-net { width: 100%; max-width: 420px; height: auto; display: block; margin: 0 auto; }
  .cv-net rect { stroke: #2b3340; stroke-width: 1; }
  .cv-badge { font-size: 14px; color: var(--ink-2); margin: 10px 2px; line-height: 1.5; }
  .cv-badge b { color: var(--ink); font-weight: 600; }
  .cv-resync { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-2); margin-top: 8px; }
  .cv-nobt { font-size: 13px; color: var(--ink-2); line-height: 1.45; }
`;

const ROTATIONS: readonly string[] = (() => {
  const out: string[] = [];
  for (const a of ['', 'x', 'x2', "x'", 'z', "z'"]) for (const b of ['', 'y', 'y2', "y'"]) out.push(`${a} ${b}`.trim());
  return out;
})();
const rotCache = new Map<string, string>();

/**
 * The whole-cube rotation that shows a cube whose letters are coloured `colourOf` in the hold: white
 * (hold.down) underneath, hold.front in front. '' when it already is; null when the hold is impossible.
 */
function rotationToHold(colourOf: Record<FaceId, ColorName>, hold: Hold): string | null {
  const key = `${hold.down}/${hold.front}/${FACE_ORDER.map((f) => colourOf[f]).join(',')}`;
  const hit = rotCache.get(key);
  if (hit !== undefined) return hit || null;
  for (const rot of ROTATIONS) {
    const s = rot ? new Cube().move(rot).asString() : SOLVED;
    if (colourOf[s[31] as FaceId] === hold.down && colourOf[s[22] as FaceId] === hold.front) { rotCache.set(key, rot); return rot; }
  }
  rotCache.set(key, '');
  return null;
}

/** The belief's stickers as the trainer draws colours, turned into the hold. */
function beliefCells(b: Belief, hold: Hold): Cell[] {
  const rot = rotationToHold(b.colourOf, hold);
  const shown = rot ? Cube.fromString(b.facelets).move(rot).asString() : b.facelets;
  const hex = (c: ColorName | undefined): string => {
    const letter = c && FACE_ORDER.find((f) => faceColorName(f) === c);
    return letter ? faceHex(letter) : '#9AA3AE';
  };
  return STICKERS.map((s) => ({ fill: hex(b.colourOf[shown[s.idx] as FaceId]) }));
}

export function mountCubeView(root: HTMLElement, opts: CubeViewOpts): CubeView {
  ensureStyle('cubeview-style', STYLE);
  root.innerHTML = `
    <div class="cv">
      <div class="cv-row">
        <span class="cv-chip" id="cv-chip">No smart cube</span>
        <button class="btn eo-primary" id="cv-connect" type="button">Connect a smart cube</button>
        <button class="btn" id="cv-disconnect" type="button" hidden>Disconnect</button>
        <button class="btn" id="cv-save" type="button" hidden title="Download this session's capture: every event with both clocks, as JSONL - it replays in the tests">Save capture</button>
      </div>
      <div class="cv-busy" id="cv-busy" hidden></div>
      <div class="cv-status" id="cv-status"></div>
      <div class="cv-warn" id="cv-warn" hidden></div>
      <div class="cv-pics">
        <div class="eo-stage"><svg id="cv-3d" viewBox="-170 -170 340 340" aria-label="the cube as believed"></svg></div>
        <svg id="cv-net" class="cv-net" viewBox="0 0 400 300" aria-label="the cube as believed, unfolded"></svg>
      </div>
      <div class="cv-badge" id="cv-badge">Nothing yet: connect a smart cube, or scan your cube and follow a solve.</div>
      <div class="cv-resync" id="cv-resync" hidden><span>Tell the smart cube what it is:</span>
        <button class="btn" id="cv-solved" type="button" title="The cube in your hand is solved: the app believes it, and the cube is told so too (its own state can drift when it misses a turn)">Solved</button>
        <button class="btn" id="cv-scan" type="button" title="Set the belief to the last scan lock">The last scan</button>
        <button class="btn" id="cv-report" type="button" title="Set the belief to what the cube itself reports">What the cube reports</button>
      </div>
    </div>`;
  const $ = scoped(root, (n) => `#cv-${n}`, 'cube view');
  const svg3d = $('3d') as unknown as SVGSVGElement, svgNet = $('net') as unknown as SVGSVGElement;
  const view: View = { ...DEFAULT_VIEW };
  let belief: Belief | null = null;
  let status: CubeStatus | null = null;
  let clock: { skew: number; n: number } | undefined;

  const draw = () => {
    if (!belief) { svg3d.innerHTML = ''; svgNet.innerHTML = ''; return; }
    let cells: Cell[];
    try { cells = beliefCells(belief, opts.hold()); } catch { cells = STICKERS.map(() => ({ fill: '#9AA3AE' })); }
    render3d(svg3d, cells, view);
    renderNet(svgNet, cells);
  };
  orbit(svg3d, view, draw);

  // an instant replay stamps its turns ahead of the page's clock: never say "-2 s ago"
  const ago = (t: number | null | undefined): string => (t === null || t === undefined ? '' : ` ${(Math.max(0, performance.now() - t) / 1000).toFixed(1)} s ago`);
  const badge = () => {
    if (!belief) { $('badge').textContent = 'Nothing yet: connect a smart cube, or scan your cube and follow a solve.'; return; }
    const from = belief.source === 'cube' ? 'the smart cube' : belief.source === 'camera' ? 'the camera' : belief.source === 'replay' ? 'a replayed capture' : 'the moves box';
    const last = belief.lastMove ? ` · last turn <b>${belief.lastMove}</b>${ago(belief.lastMoveT)}` : ' · no turns yet';
    const n = status ? ` · ${status.moves} turn${status.moves === 1 ? '' : 's'} this session` : '';
    $('badge').innerHTML = `From ${from}${last}${n}`;
  };
  setInterval(badge, 500);

  const chip = () => {
    const c = $('chip');
    if (!status || !status.connected) { c.textContent = status?.name ? `${status.name} disconnected` : 'No smart cube'; c.className = 'cv-chip'; }
    else if (status.agree === false) { c.textContent = `${status.name}: out of sync`; c.className = 'cv-chip drift'; }
    else { c.textContent = `${status.name} connected`; c.className = 'cv-chip on'; }
    const on = !!status?.connected;
    $('connect').hidden = on || !opts.bluetooth;
    $('disconnect').hidden = !on;
    $('save').hidden = !status || status.moves === 0;
    $('resync').hidden = !on;
    $('report').hidden = !status?.reported;
    $('scan').hidden = !opts.hasScan();
    const parts: string[] = [];
    if (status?.connected) {
      parts.push(status.protocol ?? '');
      if (status.hardware) parts.push(status.hardware);
      if (status.battery !== null) parts.push(`battery ${status.battery}%`);
      if (status.caps) parts.push(`${status.caps.gyroscope ? 'gyro' : 'no gyro'}`);
      if (clock && clock.n >= 2) parts.push(`cube clock ${clock.skew >= 0 ? '+' : ''}${clock.skew.toFixed(2)}% (${clock.n} turns fitted)`);
      if (status.agree === true) parts.push(`the cube confirms the state${status.movesSinceSync ? ` (${status.movesSinceSync} turns ago)` : ''}`);
    } else if (!opts.bluetooth) {
      parts.push('This browser has no Web Bluetooth: use Chrome or Edge on Android, Windows, macOS or Linux (not Safari, not iOS).');
    }
    $('status').textContent = parts.filter(Boolean).join(' · ');
    const w = $('warn');
    if (status?.connected && status.agree === false) {
      w.hidden = false;
      w.innerHTML = `The cube's own report disagrees with what the app believes${status.movesSinceSync ? ` (${status.movesSinceSync} turn${status.movesSinceSync === 1 ? '' : 's'} since they last agreed)` : ''}. A turn was probably missed. Which is right?<br>` +
        `<button class="btn" type="button" data-how="report">Trust the cube</button><button class="btn" type="button" data-how="solved">It is solved</button>${opts.hasScan() ? '<button class="btn" type="button" data-how="scan">Use the last scan</button>' : ''}`;
    } else w.hidden = true;
  };

  $('connect').onclick = () => { void opts.connect(); };
  $('disconnect').onclick = () => { void opts.disconnect(); };
  $('save').onclick = () => opts.save();
  $('solved').onclick = () => opts.resync('solved');
  $('scan').onclick = () => opts.resync('scan');
  $('report').onclick = () => opts.resync('report');
  $('warn').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-how]');
    if (b) opts.resync(b.dataset.how as 'solved' | 'scan' | 'report');
  });

  chip();
  return {
    setBelief(b) { belief = b; draw(); badge(); },
    setStatus(s, c) { status = s; clock = c; chip(); badge(); },
    setBusy(msg) { const b = $('busy'); b.hidden = !msg; b.textContent = msg ?? ''; },
  };
}

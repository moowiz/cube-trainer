// A generic play/step 3D viewer for an alg on any puzzle model. Split out
// of fto3d.ts, which had the only 3D player until now: the FTO's play/step
// UI and animation loop (button wiring, token row, requestAnimationFrame
// easing, play-at-end restart) has nothing FTO-specific in it once the
// puzzle's own state type and geometry are behind the Animatable contract
// below. algs/fto3d.ts (ftoAnimatable) and algs/nxn3d.ts (nxnAnimatable)
// are the two adapters; sheet.ts mounts either through mountPlayer.
//
// The animation trick (unchanged from fto3d.ts): a sticker's screen
// position is always its fixed slot's geometry, rotated by whatever the
// scene says (the whole-puzzle rotations done so far, and any move in
// progress); its colour is state[slot], which only changes at the end of a
// move. So a forward move animates the moving slots' geometry toward the
// next slot while their colour stays put - at k=1 a slot's sticker has
// visually arrived where apply() would put its colour, so the commit is
// seamless. Running a move backward relies on the same fact: undoing the
// state first (state <- apply(state, invert(op)), i.e. jumping straight to
// the pre-move picture) and then animating the ORIGINAL op's rotation from
// k=1 down to 0 draws exactly the reverse of the forward animation, ending
// on the already-updated state at k=0.

import type { Vec } from '../cube/fto';
import { orbit, renderPolys, type Poly, type View } from '../cube/render';

export type { Vec };

/**
 * One move of an alg, geometric enough to animate: an axis/angle turn and the sticker positions it carries.
 * `moving` is empty only for a no-op token (should not happen for a real alg).
 */
export interface AnimOp {
  token: string;
  axis: Vec;
  /** radians about `axis`, right-hand rule */
  angle: number;
  /** whole-puzzle rotation (moves every sticker) */
  rotation: boolean;
  /** sticker positions the move carries */
  moving: number[];
}

/** A puzzle model mountPlayer can animate: its ops, how one changes state, how to invert one, and how to paint a scene. */
export interface Animatable<S> {
  ops: AnimOp[];
  start: S;
  /** the state after one op */
  apply(state: S, op: AnimOp): S;
  /** the op that undoes `op`, animatable the same way (same moving set, negated angle) */
  invert(op: AnimOp): AnimOp;
  /** polygons of a scene: `anim` is the move in progress at fraction k of its angle */
  polys(scene: { state: S; rots: { axis: Vec; angle: number }[]; anim?: { op: AnimOp; k: number } }): Poly[];
  scale: number;
  view: View;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/** Mount a play/step viewer for `a` inside `host`; returns a handle to tear it down. */
/** The player's look, installed once on the first mount (the sheets that host it do not need to know). */
const STYLE = `
  .p3d { display: block; width: 100%; max-width: 300px; height: auto; margin: 6px auto 0; touch-action: none; cursor: grab; }
  .p3d polygon { stroke: #2b3340; stroke-width: 1.2; stroke-linejoin: round; }
  .p3d-ctl { display: flex; justify-content: center; gap: 6px; margin-top: 4px; }
  .p3d-ctl button { font: inherit; font-size: 15px; min-width: 44px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
  .p3d-alg { font-size: 15px; word-spacing: .1em; line-height: 1.6; text-align: center; margin-top: 4px; }
  .p3d-alg .tok { display: inline-block; padding: 0 3px; border-radius: 4px; color: var(--ink); }
  .p3d-alg .tok.done { color: var(--ink-2); opacity: .55; }
  .p3d-alg .tok.now { background: var(--ink); color: var(--bg); }
`;
function ensureStyle(): void {
  if (document.getElementById('p3d-style')) return;
  const el = document.createElement('style'); el.id = 'p3d-style'; el.textContent = STYLE; document.head.appendChild(el);
}

export function mountPlayer<S>(host: HTMLElement, a: Animatable<S>): { destroy(): void } {
  ensureStyle();
  const ops = a.ops;
  const scene: { state: S; rots: { axis: Vec; angle: number }[]; anim?: { op: AnimOp; k: number } } = { state: a.start, rots: [] };
  let i = 0; // ops committed so far
  let rafId = 0;
  let playTimer = 0;
  let playing = false;
  let running: { op: AnimOp; commit: () => void } | null = null; // the move currently animating, if any

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'p3d');
  host.appendChild(svg);

  const ctl = document.createElement('div');
  ctl.className = 'p3d-ctl';
  const mkBtn = (label: string, aria: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    ctl.appendChild(b);
    return b;
  };
  const resetBtn = mkBtn('↺', 'reset');
  const backBtn = mkBtn('◀', 'back');
  const fwdBtn = mkBtn('▶', 'forward');
  const playBtn = mkBtn('▶▶', 'play');
  host.appendChild(ctl);

  const tokRow = document.createElement('div');
  tokRow.className = 'p3d-alg';
  const spans = ops.map((op) => {
    const sp = document.createElement('span');
    sp.className = 'tok';
    sp.textContent = op.token;
    tokRow.appendChild(sp);
    return sp;
  });
  host.appendChild(tokRow);

  const view = a.view;
  const redraw = () => renderPolys(svg, a.polys(scene), view, a.scale);
  const updateTokens = () => spans.forEach((sp, idx) => {
    sp.classList.toggle('done', idx < i);
    sp.classList.toggle('now', running !== null && idx === i);
  });
  orbit(svg, view, redraw);

  const setPlayLabel = () => {
    playBtn.textContent = playing ? '❚❚' : '▶▶';
    playBtn.setAttribute('aria-label', playing ? 'pause' : 'play');
  };
  function stopPlay() {
    playing = false;
    clearTimeout(playTimer);
    setPlayLabel();
  }

  /** Snap any move in progress to its end and run its commit, without waiting for the timer. */
  function finishAnim() {
    if (!running) return;
    cancelAnimationFrame(rafId);
    const done = running;
    running = null;
    scene.anim = undefined;
    done.commit();
  }
  function startAnim(op: AnimOp, dir: 1 | -1, commit: () => void) {
    const dur = op.rotation ? 450 : 380;
    const t0 = performance.now();
    running = { op, commit };
    scene.anim = { op, k: dir === 1 ? 0 : 1 };
    updateTokens();
    redraw();
    const frame = (t: number) => {
      if (!host.isConnected) { running = null; return; } // torn out of the page mid-move: just stop
      const raw = Math.min(1, (t - t0) / dur);
      const eased = easeInOut(raw);
      scene.anim = { op, k: dir === 1 ? eased : 1 - eased };
      redraw();
      if (raw < 1) { rafId = requestAnimationFrame(frame); return; }
      running = null;
      scene.anim = undefined;
      commit();
    };
    rafId = requestAnimationFrame(frame);
  }

  function forwardStep(after?: () => void) {
    finishAnim();
    if (i >= ops.length) { after?.(); return; }
    const op = ops[i]!;
    startAnim(op, 1, () => {
      scene.state = a.apply(scene.state, op);
      if (op.rotation) scene.rots.push({ axis: op.axis, angle: op.angle });
      i++;
      updateTokens();
      redraw();
      after?.();
    });
  }
  function backStep() {
    finishAnim();
    if (i <= 0) return;
    i--;
    const op = ops[i]!;
    if (op.rotation) scene.rots.pop();
    // apply() is a no-op for a rotation on a puzzle that tracks rotations in `rots` instead of the state (the
    // FTO); on a puzzle whose rotations do permute stickers (the n×n) this is the undo that actually matters.
    scene.state = a.apply(scene.state, a.invert(op));
    startAnim(op, -1, () => {
      updateTokens();
      redraw();
    });
  }
  function playStep() {
    if (!playing) return;
    if (i >= ops.length) { stopPlay(); return; }
    forwardStep(() => {
      if (!playing) return;
      if (i >= ops.length) { stopPlay(); return; }
      playTimer = window.setTimeout(playStep, 150);
    });
  }

  const reset = () => {
    stopPlay();
    finishAnim();
    scene.state = a.start;
    scene.rots = [];
    scene.anim = undefined;
    i = 0;
    updateTokens();
    redraw();
  };
  resetBtn.addEventListener('click', reset);
  backBtn.addEventListener('click', () => { stopPlay(); backStep(); });
  fwdBtn.addEventListener('click', () => { stopPlay(); forwardStep(); });
  playBtn.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    if (i >= ops.length) reset(); // play at the end runs it again from the case
    playing = true;
    setPlayLabel();
    playStep();
  });

  updateTokens();
  redraw();

  return {
    destroy() {
      playing = false;
      clearTimeout(playTimer);
      cancelAnimationFrame(rafId);
      running = null;
      host.innerHTML = '';
    },
  };
}

// A 3D player for an FTO alg: the algs sheet's case pictures (pic.ts) are
// static, but an alg is a sequence of turns, and seeing which pieces a move
// carries matters more on the FTO than on the cube (the vertex rotations in
// particular are easy to get backwards from a diagram alone). ftoPolys is
// the pure half: a scene (state + whole-puzzle rotations done so far + an
// in-progress move) to the polygons render.ts paints, so the composition
// can be checked without a DOM. mountFtoPlayer wraps it with a play/step UI
// and a requestAnimationFrame loop.
//
// The animation trick: a sticker's screen position is always its fixed
// slot's geometry (STICKER_GEOM), rotated by the whole-puzzle turns done so
// far; its colour is state[slot], which only changes at the end of a move.
// So a forward move animates the moving slots' geometry toward the next
// slot while their colour stays put — at k=1 a slot's sticker has visually
// arrived where applyOp would put its colour, so the commit is seamless.
// Running a move backward relies on the same fact: cube/fto.ts's moving set
// is purely geometric (which slots the layer touches), the same set forward
// or inverted, so undoing first (state ← applyOp(state, inverseOp(op)),
// i.e. jumping straight to the pre-move picture) and then animating the
// ORIGINAL op's rotation from k=1 down to 0 draws exactly the reverse of
// the forward animation, ending on the already-updated state at k=0.

import { applyOp, FTO_FACES, FTO_HEX, FTO_NORMAL, FTO_STICKERS, ftoOps, ftoPoint, inverseOp, rotate, type FtoFrame, type FtoOp, type FtoState, type Vec } from '../cube/fto';
import { orbit, renderPolys, type Poly, type View } from '../cube/render';

export interface FtoScene {
  /** stickers in the START frame */
  state: FtoState;
  /** whole-puzzle rotations done so far, start-frame axes, in the order performed */
  rots: { axis: Vec; angle: number }[];
  /** the move in progress: fraction k (0..1) of op.angle applied */
  anim?: { op: FtoOp; k: number };
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** the gap between stickers: each corner is pulled 6% of the way toward the triangle's centroid */
const GAP = 0.06;

/** Each of the 72 slots' fixed corners and outward normal, computed once (state only ever changes which colour sits there). */
const STICKER_GEOM: readonly { idx: number; pts: readonly [Vec, Vec, Vec]; n: Vec }[] = FTO_STICKERS.map((s) => ({
  idx: s.idx,
  pts: s.bary.map((w) => lerp(ftoPoint(s.face, w), s.c, GAP)) as [Vec, Vec, Vec],
  n: FTO_NORMAL[s.face],
}));

/** The polygons of a scene: sticker geometry, spun by any move in progress, then turned by the whole-puzzle rotations done so far (latest first — see cube/fto.ts's toStart, which this mirrors). */
export function ftoPolys(scene: FtoScene): Poly[] {
  const spin = scene.anim && scene.anim.op.sel !== 'all' ? scene.anim : null;
  const moving = spin ? new Set(spin.op.moving) : null;
  const rots = scene.anim && scene.anim.op.sel === 'all' ? [...scene.rots, { axis: scene.anim.op.axis, angle: scene.anim.op.angle * scene.anim.k }] : scene.rots;
  return STICKER_GEOM.map((g) => {
    let pts: readonly Vec[] = g.pts;
    let n = g.n;
    if (moving?.has(g.idx)) {
      const t = spin!.op.angle * spin!.k;
      pts = pts.map((p) => rotate(p, spin!.op.axis, t));
      n = rotate(n, spin!.op.axis, t);
    }
    if (rots.length) {
      pts = pts.map((p) => rots.reduceRight((q, r) => rotate(q, r.axis, r.angle), p));
      n = rots.reduceRight((q, r) => rotate(q, r.axis, r.angle), n);
    }
    return { pts, n, fill: FTO_HEX[FTO_FACES[scene.state[g.idx]!]!], idx: g.idx };
  });
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

/** Mount a play/step viewer for `alg` (in `frame`'s notation) starting from `start`; returns a handle to tear it down. */
export function mountFtoPlayer(host: HTMLElement, opts: { alg: string; frame: FtoFrame; start: FtoState }): { destroy(): void } {
  const ops = ftoOps(opts.alg, opts.frame);
  const scene: FtoScene = { state: opts.start, rots: [] };
  let i = 0; // ops committed so far
  let rafId = 0;
  let playTimer = 0;
  let playing = false;
  let running: { op: FtoOp; commit: () => void } | null = null; // the move currently animating, if any

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fto3d');
  host.appendChild(svg);

  const ctl = document.createElement('div');
  ctl.className = 'fto3d-ctl';
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
  tokRow.className = 'fto3d-alg';
  const spans = ops.map((op) => {
    const sp = document.createElement('span');
    sp.className = 'tok';
    sp.textContent = op.token;
    tokRow.appendChild(sp);
    return sp;
  });
  host.appendChild(tokRow);

  // DECISION: nearly straight at the front corner, as the sheet's pictures are, tilted just enough to read as a solid
  const view: View = { rx: 8, ry: -10 };
  const redraw = () => renderPolys(svg, ftoPolys(scene), view, 140);
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
  function startAnim(op: FtoOp, dir: 1 | -1, commit: () => void) {
    const dur = op.sel === 'all' ? 450 : 380;
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
      scene.state = op.sel === 'all' ? scene.state : applyOp(scene.state, op);
      if (op.sel === 'all') scene.rots.push({ axis: op.axis, angle: op.angle });
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
    if (op.sel === 'all') scene.rots.pop();
    else scene.state = applyOp(scene.state, inverseOp(op));
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
    scene.state = opts.start;
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

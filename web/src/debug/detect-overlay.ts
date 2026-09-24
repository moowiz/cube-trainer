// Debug drawing for the anonymous-quad detector (M4 center-v1 head).
//
// CLAUDE.md: "Debug views are first-class. When adding a processing step, add
// a way to see its output in the debug panel." The center head adds two
// things worth seeing — the face-center heatmap the peaks come from, and the
// raw quads as the model produced them — so each gets a drawing here, shared
// by the scan page and the self-test rather than copy-pasted around.
import type { HeatMap } from '../detect/facekp';
import type { TwoStageResult } from '../detect/twostage';
import type { TrackedQuad } from '../detect/tracker';
import type { CellPlan } from '../colour/patch';
import { TOO_SMALL_REASON } from '../detect/quality';
import { mapUV, squareToQuad } from '../rectify';
import { DEFAULT_SCHEME_NAMES, type FaceId } from '../types';

/**
 * Stage 1's box (solid, with its objectness) and the padded ROI stage 2 was
 * given (dashed). Both in source px. On a miss only the objectness is
 * printed, in the corner, so a near-threshold miss is visible as such.
 */
function drawStage1(
  ctx: CanvasRenderingContext2D,
  box: readonly [number, number, number, number] | null,
  roi: readonly [number, number, number, number] | null,
  obj: number,
): void {
  ctx.save();
  ctx.font = 'bold 14px system-ui';
  if (box) {
    ctx.strokeStyle = '#5ee66b';
    ctx.lineWidth = 2;
    ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    ctx.fillStyle = '#5ee66b';
    ctx.fillText(`obj ${obj.toFixed(2)}`, box[0] + 4, Math.max(14, box[1] - 4));
  } else {
    ctx.fillStyle = '#e06a4e';
    ctx.fillText(`stage 1: no cube (obj ${obj.toFixed(2)})`, 8, 18);
  }
  if (roi) {
    ctx.strokeStyle = '#5ee66b88';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(roi[0], roi[1], roi[2] - roi[0], roi[3] - roi[1]);
  }
  ctx.restore();
}

/**
 * Paint the stride-16 heatmap as translucent cells over the frame.
 *
 * Cells are drawn in source coordinates via the map's own cellToSource, so
 * this stays correct under letterboxing and under the two-stage ROI crop -
 * a heatmap that visibly sits off the cube is itself the bug report.
 */
function drawHeatmap(ctx: CanvasRenderingContext2D, heat: HeatMap, minP = 0.05): void {
  // Cell footprint in source px, measured from two neighbouring cell centers
  // rather than assumed, so no stride/scale constant is duplicated here.
  const [x0, y0] = heat.cellToSource(0, 0);
  const [x1, y1] = heat.cellToSource(1, 1);
  const cw = Math.abs(x1 - x0);
  const ch = Math.abs(y1 - y0);
  ctx.save();
  for (let i = 0; i < heat.h; i++) {
    for (let j = 0; j < heat.w; j++) {
      const p = heat.data[i * heat.w + j]!;
      if (p < minP) continue;
      const [cx, cy] = heat.cellToSource(j, i);
      // Warm ramp: dim blue at the noise floor, hot yellow at a peak.
      const hue = 220 - 200 * p;
      ctx.fillStyle = `hsla(${hue}, 95%, 55%, ${(0.12 + 0.5 * p).toFixed(3)})`;
      ctx.fillRect(cx - cw / 2, cy - ch / 2, cw, ch);
    }
  }
  ctx.restore();
}

/** One quad outline plus a label at its first (arbitrary) corner. */
function drawQuad(
  ctx: CanvasRenderingContext2D,
  corners: readonly (readonly [number, number])[],
  color: string,
  label?: string,
  width = 3,
  dashed = false,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dashed) ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(corners[0]![0], corners[0]![1]);
  for (let k = 1; k < corners.length; k++) ctx.lineTo(corners[k]![0], corners[k]![1]);
  ctx.closePath();
  ctx.stroke();
  if (label) {
    ctx.fillStyle = color;
    ctx.font = 'bold 15px system-ui';
    ctx.fillText(label, corners[0]![0] + 6, corners[0]![1] + 16);
  }
  ctx.restore();
}

/** Which of the scan sheet's debug layers to draw (its four checkboxes). */
export interface OverlayFlags { heat: boolean; stage: boolean; refused: boolean; labels: boolean }

/**
 * The scan sheet's per-frame overlay. Layering, back to front: stage 1's box
 * and ROI, heatmap, then the raw anonymous quads in grey (what the model
 * actually said), then the tracked quads in the colour their face resolved
 * to (what the app decided). Seeing them all at once is how a naming bug is
 * told apart from a detection bug, and a stage-1 miss from a stage-2 one.
 * Dashed amber = seen but deliberately skipped for size; solid grey = a
 * quality refusal.
 *
 * `faceOf` / `cssOf` are the sheet's: which face a track is grouped into by
 * the current solution, and the CSS colour to draw that face with (the
 * palette's measured colour once known, the default scheme before).
 */
export function drawTracks(
  ctx: CanvasRenderingContext2D, lastTick: TwoStageResult | null, tracks: readonly TrackedQuad[], flags: OverlayFlags,
  sampleConf: number, faceOf: (track: number) => FaceId | null, cssOf: (f: FaceId) => string,
): void {
  if (lastTick?.result?.heat && flags.heat) drawHeatmap(ctx, lastTick.result.heat);
  if (lastTick && flags.stage) drawStage1(ctx, lastTick.box?.box ?? null, lastTick.roi, lastTick.obj);
  if (lastTick?.result && flags.refused) {
    for (const u of lastTick.result.refused) {
      const tooSmall = u.reason.startsWith(TOO_SMALL_REASON);
      drawQuad(ctx, u.quad.corners, tooSmall ? '#d98a1f' : '#8b93a3', `${u.quad.conf.toFixed(2)} ${u.reason}`, 1.5, tooSmall);
    }
  }
  // Solid = a detection on this frame; dashed = coasting (the tracker's
  // memory of a quad, kept up to dropMs so a one-frame miss does not kill
  // the track - never sampled). Bold = confident enough to be sampled.
  for (const t of tracks) {
    const strong = t.conf >= sampleConf;
    const coasting = t.sinceDetectMs > 0;
    const face = faceOf(t.id);
    ctx.globalAlpha = strong && !coasting ? 1 : 0.5;
    const label = flags.labels ? `#${t.id} ${face ? DEFAULT_SCHEME_NAMES[face] : '?'} ${t.conf.toFixed(2)}${coasting ? ` coast ${Math.round(t.sinceDetectMs)}ms` : ''}` : '';
    drawQuad(ctx, t.corners, face ? cssOf(face) : '#cfd3dc', label, strong && !coasting ? 4 : 1.5, coasting);
    ctx.globalAlpha = 1;
  }
}

/** A quad the sampler read this frame, with the patch plan it used (the sampler's `refined`). */
export interface SampledQuad { track: number; quad: [number, number][]; plan: CellPlan }

/**
 * Outline every patch the colour sampler reads on the quads that voted this
 * frame: the nine cells, and the centre cell's diagonal ring around the logo.
 * `cssOf` gives the track's face colour, or null when it has none yet.
 */
export function drawSamplePatches(ctx: CanvasRenderingContext2D, sampled: readonly SampledQuad[], cssOf: (track: number) => string | null): void {
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const { track, quad, plan } of sampled) {
    const m = squareToQuad(quad);
    ctx.strokeStyle = cssOf(track) ?? '#cfd3dc';
    const box = (u: number, v: number, half: number) => {
      const pts = [[u - half, v - half], [u + half, v - half], [u + half, v + half], [u - half, v + half]]
        .map(([a, b]) => mapUV(m, a!, b!));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    };
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const u = (c + 0.5) / 3;
        const v = (r + 0.5) / 3;
        if (r === 1 && c === 1) {
          box(u, v, plan.centreHalf / 3);
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(u + (sx! * plan.centreOff) / 3, v + (sy! * plan.centreOff) / 3, plan.centreHalf / 3);
        } else {
          box(u, v, plan.half / 3);
        }
      }
    }
  }
  ctx.restore();
}

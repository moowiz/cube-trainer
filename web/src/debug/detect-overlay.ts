// Debug drawing for the anonymous-quad detector (M4 center-v1 head).
//
// CLAUDE.md: "Debug views are first-class. When adding a processing step, add
// a way to see its output in the debug panel." The center head adds two
// things worth seeing — the face-center heatmap the peaks come from, and the
// raw quads as the model produced them — so each gets a drawing here, shared
// by the scan page and the self-test rather than copy-pasted around.
import type { HeatMap } from '../detect/facekp';

/**
 * Stage 1's box (solid, with its objectness) and the padded ROI stage 2 was
 * given (dashed). Both in source px. On a miss only the objectness is
 * printed, in the corner, so a near-threshold miss is visible as such.
 */
export function drawStage1(
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
export function drawHeatmap(ctx: CanvasRenderingContext2D, heat: HeatMap, minP = 0.05): void {
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
export function drawQuad(
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

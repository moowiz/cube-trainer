// Pure letterbox geometry shared by the two model wrappers and their tests.
//
// A model input is an aspect-preserving fit of a source region (the whole
// frame for stage 1, stage 1's padded box for stage 2) into the model's
// canvas, centred, with rgb(114) padding - exactly model/train/dataset.py
// letterbox_params / crop_letterbox, so the training labels and the app's
// corner mapping are the same arithmetic. Kept free of DOM and ORT so the
// ROI round trip can be unit-tested (web/test/roi-geometry.test.ts).

export type Box = [number, number, number, number]; // x0, y0, x1, y1

export interface Letterbox {
  /** The source region actually used, clamped to the source bounds. */
  r: Box;
  /** Model px per source px. */
  scale: number;
  dx: number;
  dy: number;
  /** Model-canvas px -> source px. */
  toSource: (u: number, v: number) => [number, number];
  /** Source px -> model-canvas px. */
  toModel: (x: number, y: number) => [number, number];
}

/** Letterbox `roi` (default: the whole source) into an iw x ih canvas. */
export function letterbox(fullW: number, fullH: number, iw: number, ih: number, roi?: Box): Letterbox {
  const r: Box = roi
    ? [Math.max(0, roi[0]), Math.max(0, roi[1]), Math.min(fullW, roi[2]), Math.min(fullH, roi[3])]
    : [0, 0, fullW, fullH];
  const sw = Math.max(1e-6, r[2] - r[0]);
  const sh = Math.max(1e-6, r[3] - r[1]);
  const scale = Math.min(iw / sw, ih / sh);
  const dx = (iw - sw * scale) / 2;
  const dy = (ih - sh * scale) / 2;
  return {
    r, scale, dx, dy,
    toSource: (u, v) => [(u - dx) / scale + r[0], (v - dy) / scale + r[1]],
    toModel: (x, y) => [(x - r[0]) * scale + dx, (y - r[1]) * scale + dy],
  };
}

/** Expand a box by `frac` of its own width/height per side and clamp to the source. */
export function padBox(box: Box, frac: number, sw: number, sh: number): Box {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return [
    Math.max(0, box[0] - frac * w),
    Math.max(0, box[1] - frac * h),
    Math.min(sw, box[2] + frac * w),
    Math.min(sh, box[3] + frac * h),
  ];
}

/** Axis-aligned hull of a set of points. */
export function hull(points: readonly (readonly [number, number])[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

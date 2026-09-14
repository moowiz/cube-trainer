// The only detection path (model/PORTRAIT-DESIGN.md section 3): localize ->
// crop -> corners, on every detection tick, on every page.
//
//   stage 1  CubeLocalizer on the whole frame (~1 ms on wasm): a box and an
//            objectness. A miss IS the tick's answer: no ROI, no stage 2, the
//            caller feeds the tracker nothing and the banner says no cube.
//   stage 2  FaceDetector on padBox(box, CROP_PAD) - inside the padding range
//            the model was trained on (model/train/shapes.py PAD_TRAIN), so
//            it sees the geometry it knows. Corners come back in frame px.
//
// There is deliberately no tracker-hull ROI, no centre crop and no full-frame
// fallback: the stage-2 model has never seen a full frame and would only
// produce confident garbage on one.
import { CubeLocalizer, type CubeBox } from './cubebox';
import { FaceDetector, type DetectResult } from './facekp';
import { padBox, type Box } from './geometry';

/**
 * Per-side padding of the stage-1 box before stage 2 (= shapes.PAD_VAL).
 * DECISION 2026-09-13: 0.20, down from 0.45. The detector's error is a
 * constant ~3.4 px in its own 256 input whatever the crop, so the tighter
 * the crop the fewer source px that is: on data_real_val (diagnose.py
 * --pad) cell-centre error went 10.75 -> 8.79 source px, F1 0.956 -> 0.972,
 * and it held (9.27) with the box jittered +-0.15 per side. Training
 * re-crops span -0.10..0.45 so 0.20 is in-distribution; 0.10 was worse
 * (3.9 model px - the model wants some context).
 */
export const CROP_PAD = 0.20;

export interface TwoStageResult {
  /** null when stage 1 found no cube (stage 2 did not run). */
  result: DetectResult | null;
  /** Stage 1's box in frame px, when it fired. */
  box: CubeBox | null;
  /** The region stage 2 actually looked at (padded, clamped), when it ran. */
  roi: Box | null;
  /** Stage 1's raw objectness even on a miss, for the debug overlay. */
  obj: number;
  /** Stage-1 inference ms. */
  locateMs: number;
}

export async function detectTwoStage(
  localizer: CubeLocalizer,
  detector: FaceDetector,
  video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
): Promise<TwoStageResult> {
  const w = video instanceof HTMLVideoElement ? video.videoWidth : video.width;
  const h = video instanceof HTMLVideoElement ? video.videoHeight : video.height;
  const t0 = performance.now();
  const box = await localizer.locate(video, w, h);
  const locateMs = performance.now() - t0;
  const obj = localizer.lastObj;
  if (!box) return { result: null, box: null, roi: null, obj, locateMs };
  const roi = padBox(box.box, CROP_PAD, w, h);
  const result = await detector.detect(video, roi);
  return { result, box, roi, obj, locateMs };
}

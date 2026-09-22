// Debug exports shared by the scan page's debug panel (and any future page):
// download helpers, the RAW camera frame for the labeling loop, and the
// snapshot of what a detection tick saw.
//
// Rule for every image written here: the raw frame, never the overlay canvas.
// A painted quad or box would poison training data.
//
// Nothing here derives a colour decision. The snapshot carries the quads and
// the quality refusals the tick actually produced; what the stickers ARE is
// the colour solver's answer, and the scan sheet captures its evidence log
// beside this file's output.
import type { DetectResult, FaceDetector } from '../detect/facekp';
import { downloadBlob } from '../ui/download';

/** One detection tick, as the scan page keeps it for the capture's history. */
export interface TickSummary {
  t: number;
  obj: number;
  quads: number;
  refused: string[];
}

/** Compact record of a tick for the history ring buffer. */
export function summarizeTick(t: number, obj: number, res: DetectResult | null): TickSummary {
  return {
    t, obj: +obj.toFixed(2), quads: res?.quads.length ?? 0,
    refused: (res?.refused ?? []).map((u) => u.reason),
  };
}

/** A frame source: the live video, or a frozen frame from the scan page's ring. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement;

function frameDims(src: FrameSource): { w: number; h: number } {
  return src instanceof HTMLVideoElement ? { w: src.videoWidth, h: src.videoHeight } : { w: src.width, h: src.height };
}

/** The frame as a clean PNG (no overlay). */
function rawFrameBlob(video: FrameSource): Promise<Blob | null> {
  const c = document.createElement('canvas');
  const { w, h } = frameDims(video);
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(video, 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

/** Download the raw frame as `<prefix>-<stamp>.png`; returns the file name. */
export async function saveRawFrame(video: FrameSource, prefix: string, stamp = Date.now()): Promise<string | null> {
  if (frameDims(video).w === 0) return null;
  const blob = await rawFrameBlob(video);
  if (!blob) return null;
  const name = `${prefix}-${stamp}.png`;
  downloadBlob(name, blob);
  return name;
}

/** Everything this detection tick saw, as a plain object. */
function debugSnapshot(res: DetectResult | null, detector: FaceDetector, video: FrameSource,
                              history: readonly TickSummary[] = [], extra: Record<string, unknown> = {}): unknown {
  return {
    ...extra,
    captured: new Date().toISOString(),
    model: detector.modelId,
    ep: detector.ep,
    input: frameDims(video),
    inferMs: res?.inferMs ?? null,
    totalMs: res?.totalMs ?? null,
    ticks: history,
    // (until 2026-09-22 every quad also carried `named` - the exemplar namer's cells, ranking and
    // reason - and the snapshot carried the exemplars themselves. The app does not name on the
    // detection tick any more; the colour solver's own evidence log is the capture that matters,
    // and the scan sheet writes it beside this one.)
    quads: (res?.quads ?? []).map((q, i) => ({ i, conf: q.conf, cornersSourcePx: q.corners })),
    refused: (res?.refused ?? []).map((u) => u.reason),
  };
}

/** Download the snapshot JSON and the raw frame under one stamp; returns the stem. */
export async function captureDebug(res: DetectResult | null, detector: FaceDetector, video: FrameSource,
                                   prefix = 'detect-debug', history: readonly TickSummary[] = [],
                                   extra: Record<string, unknown> = {},
                                   sink?: (json: string, name: string) => Promise<void>): Promise<string> {
  const stamp = Date.now();
  const json = JSON.stringify(debugSnapshot(res, detector, video, history, extra), null, 1);
  if (sink) {
    // a headless clip replay posts the capture to the dev server instead of downloading
    await sink(json, `${prefix}-${stamp}.json`);
    return `${prefix}-${stamp}`;
  }
  downloadBlob(`${prefix}-${stamp}.json`, new Blob([json], { type: 'application/json' }));
  await saveRawFrame(video, prefix, stamp);
  return `${prefix}-${stamp}`;
}

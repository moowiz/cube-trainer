// Debug exports and readouts shared by the scan page's debug panel (and any
// future page): download helpers, the RAW camera frame for the labeling
// loop, the naming-evidence snapshot, and the per-sticker readout.
//
// Rule for every image written here: the raw frame, never the overlay canvas.
// A painted quad or box would poison training data.
//
// The readout and the snapshot are both built from `res.named`, which is
// what nameQuads actually decided from - the same cell samples and the same
// exemplar ranking. Nothing here re-derives a colour decision; the one
// derived value is each cell's nearest exemplar, which naming never computes
// because only the centre names a face, and it is computed with the app's
// own labDistance against the app's own live exemplars so it cannot drift
// from what the centre decision would say.
import type { DetectResult, FaceDetector } from '../detect/facekp';
import type { CenterExemplars } from '../detect/identify';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';
import type { FaceId, Lab } from '../types';

/** One detection tick, as the scan page keeps it for the capture's history. */
export interface TickSummary {
  t: number;
  obj: number;
  quads: number;
  named: { face: FaceId; conf: number; nameConf: number }[];
  refused: string[];
}

/** Compact record of a tick for the history ring buffer. */
export function summarizeTick(t: number, obj: number, res: DetectResult | null): TickSummary {
  return {
    t, obj: +obj.toFixed(2), quads: res?.quads.length ?? 0,
    named: (res?.named ?? []).flatMap((n, i) => n.face
      ? [{ face: n.face, conf: +(res!.quads[i]?.conf ?? 0).toFixed(2), nameConf: +n.nameConf.toFixed(2) }] : []),
    refused: (res?.unnamed ?? []).map((u) => u.reason),
  };
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** A frame source: the live video, or a frozen frame from the scan page's ring. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement;

export function frameDims(src: FrameSource): { w: number; h: number } {
  return src instanceof HTMLVideoElement ? { w: src.videoWidth, h: src.videoHeight } : { w: src.width, h: src.height };
}

/** The frame as a clean PNG (no overlay). */
export function rawFrameBlob(video: FrameSource): Promise<Blob | null> {
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
  downloadBlob(blob, name);
  return name;
}

export function cellPick(lab: Lab, exemplars: CenterExemplars): { face: FaceId; d: number; second: number } {
  const ranked = FACE_ORDER
    .map((f) => ({ f, d: exemplars.distance(lab, f) }))
    .sort((a, b) => a.d - b.d);
  return { face: ranked[0]!.f, d: ranked[0]!.d, second: ranked[1]!.d };
}

/** Everything the naming layer saw for this detection, as a plain object. */
export function debugSnapshot(res: DetectResult | null, detector: FaceDetector, video: FrameSource,
                              history: readonly TickSummary[] = [], extra: Record<string, unknown> = {}): unknown {
  const ex = detector.exemplars;
  return {
    ...extra,
    captured: new Date().toISOString(),
    model: detector.modelId,
    ep: detector.ep,
    input: frameDims(video),
    inferMs: res?.inferMs ?? null,
    totalMs: res?.totalMs ?? null,
    exemplars: ex.status().map((e) => ({ ...e, color: DEFAULT_SCHEME_NAMES[e.face] })),
    exemplarRejects: ex.rejected,
    exemplarHistory: ex.history,
    ticks: history,
    quads: (res?.quads ?? []).map((q, i) => {
      const n = res!.named?.[i];
      return {
        i,
        conf: q.conf,
        cornersSourcePx: q.corners,
        named: n && {
          face: n.face, color: n.color, reason: n.reason, nameConf: n.nameConf,
          centreNorm: n.center, centreRgb: n.rgb,
          ranked: n.ranked,
          cells: n.cellsNorm?.map((lab, k) => ({
            k, rgb: n.cellRgb?.[k], lab: n.cells?.[k], labNorm: lab, nearest: cellPick(lab, ex),
          })),
        },
      };
    }),
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
  downloadBlob(new Blob([json], { type: 'application/json' }), `${prefix}-${stamp}.json`);
  await saveRawFrame(video, prefix, stamp);
  return `${prefix}-${stamp}`;
}

/**
 * Per-sticker readout: one 3x3 swatch grid per quad, each cell with the
 * colour the detector's exemplar namer would give it and the distance (the
 * low-res debug view; the solver's own view is the six lock grids).
 */
export function renderCellReadout(host: HTMLElement, res: DetectResult | null, exemplars: CenterExemplars): void {
  host.textContent = '';
  if (!res?.named) return;
  res.named.forEach((n, i) => {
    if (!n.cellsNorm || !n.cellRgb || !n.cells) return;
    const box = document.createElement('div');
    box.className = 'sc-face';
    const hd = document.createElement('div');
    hd.className = 'sc-hd';
    const best = n.ranked?.[0];
    hd.textContent = `quad ${i} · ${res.quads[i] ? res.quads[i]!.conf.toFixed(2) : '?'} · ${n.reason}\n`
      + (best ? `centre ${n.color ?? '—'} d ${best.d.toFixed(1)} · conf ${n.nameConf.toFixed(2)}` : 'not named');
    const g = document.createElement('div');
    g.className = 'sc-g';
    n.cellsNorm.forEach((lab, k) => {
      const p = cellPick(lab, exemplars);
      const label = DEFAULT_SCHEME_NAMES[p.face].slice(0, 3);
      const d = p.d;
      const rgb = n.cellRgb![k]!;
      const c = document.createElement('div');
      c.className = 'sc-c' + (k === 4 ? ' sc-mid' : '');
      c.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      c.style.color = d > 35 ? '#fff' : '#000';
      c.innerHTML = `<b>${label}</b><span>${d.toFixed(0)}</span>`;
      g.append(c);
    });
    box.append(hd, g);
    host.append(box);
  });
}

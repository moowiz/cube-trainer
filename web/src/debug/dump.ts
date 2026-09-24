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
import type { EvidenceLog, FaceGroup, Solution } from '../colour/types';
import type { MovesResult } from '../colour/solve.worker';
import type { DEFAULT_PARAMS } from '../colour/solve';
import type { Hold } from '../handoff';
import type { Recording } from '../ui/recorder';
import type { RecordingSession } from '../rig/session';
import { downloadBlob } from '../ui/download';

/** The evidence-log capture format: 2 = glare means blown to white (v1 counted any saturated channel, which zeroed every orange reading). */
export const CAPTURE_VERSION = 2;

/**
 * What the scan sheet's Capture button writes beside the tick snapshot: the
 * evidence log and everything a replay needs to redo the scan without hands
 * (test/colour-replay.test.ts, test/moves-replay.test.ts, tools/solve/*.py).
 * A fixture adds `truth` (a confirmed state) and `note` by hand.
 */
export interface ScanCapture {
  version: typeof CAPTURE_VERSION;
  scramble: string;
  /** The truth only when the user says the scramble was applied from solved. */
  scrambleApplied: boolean;
  scrambleTruth: string | null;
  /** The host stage's scramble and hold, what the Check line compared the scan against (null when the sheet was opened without a stage): a replay can redo the comparison. */
  expected: { scramble: string; hold: Hold; shown?: string } | null;
  /** The solve recording (null when none): the video's name and wall-clock span (video time = QuadObs.t - startedAt). */
  recording: Recording | null;
  /** The moves the user said they turned, and the resulting state when scramble and moves are both truth. */
  movesApplied: string | null;
  endTruth: string | null;
  /** The move reader's record and last trace lines, when it ran. */
  moves: MovesResult | null;
  evidenceLog: EvidenceLog;
  solution: PlainSolution | null;
  params: typeof DEFAULT_PARAMS;
  locked: boolean;
  /** The debug panel's diagnostics line. */
  stats: string;
  /** The pipeline's rates and budgets at capture time; the sheet's own EMAs, named as it names them. */
  timing: Record<string, unknown>;
}

/** A solution as JSON carries it: the two Maps (a group's rotation, the per-frame gains) as entry lists. */
export type PlainSolution = Omit<Solution, 'groups' | 'gains'> & {
  groups: (Omit<FaceGroup, 'rotation'> & { rotation: [number, number][] })[];
  gains: [number, [number, number]][];
};

export function plainSolution(sol: Solution | null): PlainSolution | null {
  return sol ? { ...sol, groups: sol.groups.map((g) => ({ ...g, rotation: [...g.rotation] })), gains: [...sol.gains] } : null;
}

/** Where a capture goes instead of a download: a recording session (the evidence log is the session's, and writing it closes the session), or `?post=<name>` (the dev server's capture endpoint; `1` keeps the stamped name), or nowhere (undefined: download). */
export function captureSink(session: RecordingSession | null, post: string | null, onClosed?: () => Promise<void>): CaptureSink | undefined {
  if (session) return async (json) => { await session.evidence(json); await onClosed?.(); };
  if (post) return async (json, name) => { await fetch(`/__capture?name=${encodeURIComponent(post === '1' ? name : post)}`, { method: 'POST', body: json }); };
  return undefined;
}

export type CaptureSink = (json: string, name: string) => Promise<void>;

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
                              history: readonly TickSummary[] = [], extra: object = {}): unknown {
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
                                   extra: object = {},
                                   sink?: CaptureSink): Promise<string> {
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

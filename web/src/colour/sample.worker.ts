// Sampling off the main thread: corner refinement (100 seam-score warps
// per quad), the 90x90 warp, the nine patch statistics and the blur score
// cost ~48 ms per detection frame on a desktop, which capped the frame
// pump at ~15 ticks/s and stalled the video. The main thread ships the
// frame's pixels (transferred, not copied) with the fresh tracks; this
// worker returns the QuadObs for the log and the refined quads for the
// overlay.

import { blurScore, facePlan, minFaceEdgePx, quadEdgePx, quadViewCos, sampleGridStats } from './patch';
import { refineQuad } from '../detect/gridfit';
import { warpQuad, type ImageDataLike } from '../rectify';
import { makeReading, quadWeight } from './evidence';
import type { QuadObs } from './types';

export interface SampleTrack {
  id: number;
  corners: [number, number][];
  conf: number;
  speed: number;
  nth: number;
  /** Last frame's refinement offset per corner (refined - tracker), for a warm start. */
  warm?: [number, number][];
}

export interface SampleRequest {
  type: 'sample';
  frame: number;
  t: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  tracks: SampleTrack[];
  refine: boolean;
}

export interface SampleResponse {
  type: 'sampled';
  frame: number;
  quads: QuadObs[];
  /** track -> refined quad (source px) and its sampling plan, for the overlay */
  refined: { track: number; quad: [number, number][]; plan: { half: number; off: number; centreHalf: number; centreOff: number }; offset: [number, number][] }[];
  ms: number;
}

self.onmessage = (ev: MessageEvent<SampleRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'sample') return;
  const t0 = performance.now();
  const img: ImageDataLike = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.pixels) };
  const quads: QuadObs[] = [];
  const refined: SampleResponse['refined'] = [];
  for (const t of msg.tracks) {
    let quad = t.corners.map((c) => [c[0], c[1]]) as [number, number][];
    if (msg.refine) {
      // DECISION: a continuing track starts from last frame's refinement
      // offset and searches only at 1 px with a third of the budget - the
      // offset barely changes between detection frames and the full
      // 100-eval search cost 160-205 ms per frame on the phone
      const warm = t.warm && t.warm.length === 4;
      const start = warm ? quad.map((c, i) => [c[0] + t.warm![i]![0], c[1] + t.warm![i]![1]] as [number, number]) : quad;
      quad = refineQuad(img, start, warm ? { maxEvals: 32, steps: [1], finalSeam: false } : { finalSeam: false }).quad.map((c) => [c[0], c[1]]) as [number, number][];
    }
    let perim = 0;
    for (let i = 0; i < 4; i++) perim += Math.hypot(quad[i]![0] - quad[(i + 1) % 4]![0], quad[i]![1] - quad[(i + 1) % 4]![1]);
    const plan = facePlan(perim / 4 / 3, minFaceEdgePx(msg.height));
    if (!plan) continue;
    const warped = warpQuad(img, quad, 90);
    const stats = sampleGridStats(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 }, plan);
    const q = { conf: t.conf, blur: blurScore(warped), viewCos: quadViewCos(quad), edgePx: quadEdgePx(quad), speed: t.speed, nth: t.nth, frameH: msg.height };
    const w = quadWeight(q);
    quads.push({
      frame: msg.frame, t: msg.t, track: t.id, corners: quad, conf: t.conf,
      blur: q.blur, viewCos: q.viewCos, edgePx: q.edgePx, speed: t.speed, nth: t.nth,
      readings: stats.map((p, i) => makeReading(i, p, w)),
    });
    refined.push({ track: t.id, quad, plan, offset: quad.map((c, i) => [c[0] - t.corners[i]![0], c[1] - t.corners[i]![1]] as [number, number]) });
  }
  const out: SampleResponse = { type: 'sampled', frame: msg.frame, quads, refined, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(out);
};

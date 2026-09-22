// Headless self-test hook: web/scripts/check-detect.mjs drives
// window.__detectSelfTest(iters, ep, imgUrl) over the built page to prove
// both models load and run on each execution provider, no camera needed.
import type { Ep } from '../detect/facekp';
import { type LoadOutcome, type TwoStageModels } from '../detect/models';
import { detectTwoStage, type TwoStageResult } from '../detect/twostage';

export interface SelfTestHost {
  current(): TwoStageModels | null;
  /** (Re)load with this EP; the page keeps the outcome as its own state. */
  load(ep: Ep | 'auto'): Promise<LoadOutcome>;
}

export function installDetectSelfTest(host: SelfTestHost): void {
  (window as unknown as Record<string, unknown>).__detectSelfTest =
    async (iters = 30, ep?: string, imgUrl?: string) => {
      let outcome: LoadOutcome | null = null;
      if (ep) outcome = await host.load(ep as Ep | 'auto');
      else if (!host.current()) outcome = await host.load('auto');
      const m = host.current();
      if (!m) return { ok: false, reason: outcome?.reason ?? 'no model deployed' };
      const c = document.createElement('canvas');
      const g = c.getContext('2d')!;
      if (imgUrl) {
        // A real frame, so the check can compare what each EP actually decodes.
        // The synthetic rectangle below produces zero detections on every EP,
        // which is correct behaviour and therefore blind to a broken EP.
        const img = new Image();
        img.src = imgUrl;
        await img.decode();
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        g.drawImage(img, 0, 0);
      } else {
        c.width = 480;
        c.height = 640;
        g.fillStyle = '#555';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#c41e3a';
        g.fillRect(140, 220, 200, 200); // face-ish red square, content irrelevant
      }
      // Two-stage like the app. On the synthetic square stage 1 will usually
      // miss, which is a correct answer; a real frame (imgUrl) exercises stage 2.
      await detectTwoStage(m.localizer, m.detector, c); // warmup
      const t0 = performance.now();
      let last: TwoStageResult | null = null;
      for (let i = 0; i < iters; i++) last = await detectTwoStage(m.localizer, m.detector, c);
      const ms = (performance.now() - t0) / iters;
      const r = last!.result;
      return {
        ok: true, ep: m.detector.ep, offThread: m.detector.proxied, threads: m.detector.threads, avgMs: ms, fps: 1000 / ms,
        stage1: { obj: +last!.obj.toFixed(3), box: last!.box?.box.map((v) => Math.round(v)) ?? null },
        quads: r?.quads.length ?? 0, refused: r?.refused.length ?? 0,
        anonymous: m.detector.anonymous, model: `${m.localizer.modelId} -> ${m.detector.modelId}`,
        // enough to tell "this EP decoded nothing" from "this EP decoded
        // something different" without eyeballing an overlay
        scores: r?.quads.map((q) => +q.conf.toFixed(3)) ?? [],
        reasons: r?.refused.map((u) => u.reason) ?? [],
        corner0: r?.quads[0]?.corners.map((c) => c.map((v) => Math.round(v))),
      };
    };
}

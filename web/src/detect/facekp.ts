// ORT-web wrapper around the face keypoint model (M4).
//
// Loads web/public/models/facekp.onnx plus its facekp.json metadata sidecar
// (written by model/export/export_onnx.py — preprocessing and output layout
// live THERE, never hardcoded here). 'auto' benchmarks webgpu vs wasm on
// this device (some phones run wasm faster than their GPU driver) and keeps
// the faster session; the verdict is cached in localStorage so the ~1s
// measurement happens once per device per model. Never assumes WebGPU exists.
//
// The app must keep working when no model file is deployed: load() resolves
// null on a missing model, and callers fall back to the grid scanner.
import * as ort from 'onnxruntime-web';
import type { FaceId } from '../types';
import { FACE_ORDER } from '../types';

export interface DetectedFace {
  face: FaceId;
  conf: number;
  /** TL,TR,BR,BL in the face's cubejs sticker orientation, source-image px. */
  corners: [number, number][];
}

export interface DetectResult {
  faces: DetectedFace[];
  /** Pure session.run time, ms. */
  inferMs: number;
  /** Preprocess + run + decode, ms. */
  totalMs: number;
}

interface FacekpMeta {
  input: { shape: number[]; mean: number[]; std: number[] };
  output: { faces: string };
  precision?: string;
}

export type Ep = 'webgpu' | 'wasm';

const CONF_KEEP = 0.25; // hand everything plausible to the caller; it filters
const BENCH_KEY = 'facekp:epBench:v1';

export class FaceDetector {
  private constructor(
    private session: ort.InferenceSession,
    private meta: FacekpMeta,
    readonly ep: Ep,
    /** Per-EP mean inference ms when 'auto' ran (or replayed) a benchmark. */
    readonly benchMs?: Partial<Record<Ep, number>>,
  ) {
    const [, , h, w] = meta.input.shape;
    this.iw = w;
    this.ih = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  private iw: number;
  private ih: number;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  /** Resolves null when no model is deployed (the grid scanner is the fallback). */
  static async load(preferred: Ep | 'auto' = 'auto'): Promise<FaceDetector | null> {
    const base = import.meta.env.BASE_URL;
    ort.env.wasm.wasmPaths = `${base}ort/`;
    // GitHub Pages sends no COOP/COEP headers, so no SharedArrayBuffer there.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 1;

    const metaRes = await fetch(`${base}models/facekp.json`);
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as FacekpMeta;
    const modelRes = await fetch(`${base}models/facekp.onnx`);
    if (!modelRes.ok) return null;
    const model = new Uint8Array(await modelRes.arrayBuffer());

    const create = (ep: Ep) =>
      ort.InferenceSession.create(model, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });

    if (preferred !== 'auto') {
      return new FaceDetector(await create(preferred), meta, preferred);
    }
    if (!('gpu' in navigator)) {
      return new FaceDetector(await create('wasm'), meta, 'wasm');
    }

    // 'auto' with WebGPU present: use the cached verdict for this model if
    // there is one, otherwise benchmark both providers and keep the winner.
    const cacheId = `${meta.precision ?? 'fp32'}:${meta.input.shape.join('x')}`;
    interface BenchCache { id: string; ep: Ep; ms: Partial<Record<Ep, number>> }
    let cached: BenchCache | null = null;
    try {
      const raw = localStorage.getItem(BENCH_KEY);
      if (raw) cached = JSON.parse(raw) as BenchCache;
    } catch { /* storage unavailable: bench every load */ }
    if (cached && cached.id === cacheId) {
      try {
        return new FaceDetector(await create(cached.ep), meta, cached.ep, cached.ms);
      } catch { /* cached EP broke (driver change?): fall through to re-bench */ }
    }

    const [, , h, w] = meta.input.shape;
    const bench = async (session: ort.InferenceSession): Promise<number> => {
      const feed = { image: new ort.Tensor('float32', new Float32Array(3 * h * w), [1, 3, h, w]) };
      for (let i = 0; i < 5; i++) await session.run(feed); // warmup: shader compile etc.
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) await session.run(feed);
      return (performance.now() - t0) / 10;
    };

    // webgpu session FIRST: ort-web's jsep build can init plain wasm
    // afterwards, but initializing plain wasm first breaks a later webgpu
    // init ("multiple calls to initWasm()").
    const ms: Partial<Record<Ep, number>> = {};
    let gpuSession: ort.InferenceSession | null = null;
    try {
      gpuSession = await create('webgpu');
      ms.webgpu = await bench(gpuSession);
    } catch { /* WebGPU advertised but unusable */ }
    const wasmSession = await create('wasm');
    ms.wasm = await bench(wasmSession);
    let winner: Ep = 'wasm';
    let session = wasmSession;
    if (gpuSession && ms.webgpu !== undefined && ms.webgpu < ms.wasm) {
      winner = 'webgpu';
      session = gpuSession;
      void wasmSession.release();
    } else if (gpuSession) {
      void gpuSession.release();
    }
    try {
      localStorage.setItem(BENCH_KEY, JSON.stringify({ id: cacheId, ep: winner, ms }));
    } catch { /* fine, re-bench next load */ }
    return new FaceDetector(session, meta, winner, ms);
  }

  /** Run one frame. Corner coords come back in the source's own pixel space. */
  async detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<DetectResult> {
    const t0 = performance.now();
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;

    // Letterbox (must mirror model/train/dataset.py letterbox_params):
    // aspect-preserving fit, centered, rgb(114) padding.
    const scale = Math.min(this.iw / sw, this.ih / sh);
    const dx = (this.iw - sw * scale) / 2;
    const dy = (this.ih - sh * scale) / 2;
    this.ctx.fillStyle = 'rgb(114,114,114)';
    this.ctx.fillRect(0, 0, this.iw, this.ih);
    this.ctx.drawImage(source, dx, dy, sw * scale, sh * scale);
    const { data } = this.ctx.getImageData(0, 0, this.iw, this.ih);

    const [mr, mg, mb] = this.meta.input.mean;
    const [dr, dg, db] = this.meta.input.std;
    const plane = this.iw * this.ih;
    const x = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      x[i] = (data[i * 4] / 255 - mr) / dr;
      x[plane + i] = (data[i * 4 + 1] / 255 - mg) / dg;
      x[2 * plane + i] = (data[i * 4 + 2] / 255 - mb) / db;
    }

    const t1 = performance.now();
    const out = await this.session.run({
      image: new ort.Tensor('float32', x, [1, 3, this.ih, this.iw]),
    });
    const t2 = performance.now();

    const y = out.faces.data as Float32Array; // [1,6,9]
    const faces: DetectedFace[] = [];
    for (let f = 0; f < 6; f++) {
      const conf = 1 / (1 + Math.exp(-y[f * 9]));
      if (conf < CONF_KEEP) continue;
      const corners: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const u = y[f * 9 + 1 + 2 * k] * this.iw;
        const v = y[f * 9 + 2 + 2 * k] * this.ih;
        corners.push([(u - dx) / scale, (v - dy) / scale]);
      }
      faces.push({ face: FACE_ORDER[f], conf, corners });
    }
    return { faces, inferMs: t2 - t1, totalMs: t2 - t0 };
  }

  dispose(): void {
    void this.session.release();
  }
}

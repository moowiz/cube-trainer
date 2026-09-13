// ORT-web wrapper around the face keypoint model (M4).
//
// Loads web/public/models/facekp.onnx plus its facekp.json metadata sidecar
// (written by model/export/export_onnx.py — preprocessing and output layout
// live THERE, never hardcoded here). 'auto' benchmarks webgpu vs wasm on
// this device (some phones run wasm faster than their GPU driver) and keeps
// the faster session; the verdict is cached in localStorage so the ~1s
// measurement happens once per device per model. Never assumes WebGPU exists.
//
// Two model generations are supported, selected by `meta.head`:
//   undefined | 'legacy'  (B,6,9) named face slots, U R F D L B, one
//                         visibility logit + 4 corners each.
//   'center-v1'           (B,9,15,20) CenterNet maps: an anonymous
//                         face-center heatmap plus corner offsets. Quads
//                         carry NO face identity; identify.ts names them
//                         from the center sticker color.
// Either way detect() returns DetectedFace[], so the tracker, orientation
// and assembly code below it never learns which generation is deployed.
//
// The app must keep working when no model file is deployed: load() resolves
// null on a missing model, and callers fall back to the grid scanner.
import * as ort from 'onnxruntime-web';
import type { FaceId, Lab } from '../types';
import { FACE_ORDER } from '../types';
import type { ImageDataLike } from '../rectify';
import { CenterExemplars, nameQuads, type NamedQuad } from './identify';

export interface DetectedFace {
  face: FaceId;
  conf: number;
  /** TL,TR,BR,BL in the face's cubejs sticker orientation, source-image px. */
  corners: [number, number][];
  /** center-v1 only: how confidently the center color picked this face id. */
  nameConf?: number;
}

/** A detection before it has a name. center-v1 produces these directly. */
export interface DetectedQuad {
  conf: number;
  /** 4 corners, source-image px. Cyclic order, consistent winding, arbitrary start. */
  corners: [number, number][];
}

/** The raw face-center heatmap, for the debug overlay. */
export interface HeatMap {
  /** w*h sigmoid probabilities, row-major. */
  data: Float32Array;
  w: number;
  h: number;
  /** Map a cell (j,i) to source-image px: see letterbox math in detect(). */
  cellToSource: (j: number, i: number) => [number, number];
}

export interface DetectResult {
  faces: DetectedFace[];
  /** Anonymous quads as the model produced them, before naming (debug view). */
  quads: DetectedQuad[];
  /** center-v1 only. */
  heat?: HeatMap;
  /** Quads that were dropped by naming, with the reason (debug view). */
  unnamed: { quad: DetectedQuad; reason: string }[];
  /** center-v1 only: the naming result per quad, parallel to `quads`, with the
   *  sampled cells and the exemplar ranking it decided from. Debug/capture. */
  named?: NamedQuad[];
  /** Pure session.run time, ms. */
  inferMs: number;
  /** Preprocess + run + decode (+ naming), ms. */
  totalMs: number;
}

interface FacekpMeta {
  input: { shape: number[]; mean: number[]; std: number[] };
  output: { name?: string; faces?: string; shape?: number[]; stride?: number };
  head?: string;         // 'legacy' (or absent) | 'center-v1'
  anonymous?: boolean;
  precision?: string;
  run?: string;          // training run name (e.g. "ft7"), stamped at export
  trainedEpoch?: number;
  exported?: string;
  cropTrained?: boolean; // stage-2 of the two-stage detector: safe to feed crops
}

export type Ep = 'webgpu' | 'wasm';

const CONF_KEEP = 0.25; // hand everything plausible to the caller; it filters
const BENCH_KEY = 'facekp:epBench:v1';
const TOP_K = 6;        // max faces the center head decodes per frame (3 can be visible)
// Decode dedupe, mirroring model/train/model.py's CENTER_* constants exactly.
const DEDUPE_FRAC = 0.5;      // suppression radius as a fraction of the kept quad's mean edge
const MIN_DEDUPE_PX = 8;      // floor, for degenerate near-zero-area quads
const MAX_CANDIDATES = 32;    // cells decoded per frame before deduplication

export class FaceDetector {
  private constructor(
    private session: ort.InferenceSession,
    private meta: FacekpMeta,
    readonly ep: Ep,
    /** Per-EP mean inference ms when 'auto' ran (or replayed) a benchmark. */
    readonly benchMs?: Partial<Record<Ep, number>>,
  ) {
    const [, , h, w] = meta.input.shape;
    this.modelId = [meta.run, meta.trainedEpoch != null ? `ep${meta.trainedEpoch}` : '', meta.precision]
      .filter(Boolean).join(' ') || 'unknown model';
    this.cropTrained = !!meta.cropTrained;
    this.anonymous = (meta.head ?? 'legacy') === 'center-v1';
    this.outputName = meta.output?.name ?? (this.anonymous ? 'maps' : 'faces');
    this.stride = meta.output?.stride ?? 16;
    this.iw = w;
    this.ih = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** Human-readable model identity, e.g. "ft7 ep12 fp32" - shown in page status lines. */
  readonly modelId: string;
  /** True when the deployed model was trained on crop-normalized views. */
  readonly cropTrained: boolean;
  /** True for center-v1: the model emits unnamed quads, identify.ts names them. */
  readonly anonymous: boolean;
  /** Center-color exemplars, grown from seam-verified faces. Debug panel reads it. */
  readonly exemplars = new CenterExemplars();
  private outputName: string;
  private stride: number;
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
    const cacheId = `${meta.head ?? 'legacy'}:${meta.precision ?? 'fp32'}:${meta.input.shape.join('x')}`;
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

  /**
   * Run one frame. Corner coords come back in the source's own pixel space.
   *
   * For center-v1 the quads are decoded anonymously and then named from their
   * center sticker color; quads that cannot be named (glare, too dark, two
   * quads claiming one face, an impossible opposite pair) are dropped from
   * `faces` but stay in `quads`/`unnamed` for the debug overlay.
   */
  async detect(
    source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
    /** Optional source-space region: run the model on this crop only (the
     *  two-stage path: stage 1 or the tracker supplies it). Corners are
     *  mapped back to full-source coordinates. Only use with a crop-trained
     *  model (meta.cropTrained) - the fp32 base model degrades on crops. */
    roi?: [number, number, number, number],
  ): Promise<DetectResult> {
    const run = await this.run(source, roi);
    if (!this.anonymous) return run.result;

    // Name the quads from the letterboxed frame the model itself saw. It is
    // already in hand (no second getImageData, no full-res read on the
    // detector's cadence) and a center sticker is ~10-25 px across there -
    // ample for one averaged patch. Full-resolution sampling still happens
    // downstream, where per-sticker color actually has to be right.
    const named = nameQuads(run.lbFrame, run.lbQuads, this.exemplars,
                            run.result.quads.map((q) => q.conf));
    const faces: DetectedFace[] = [];
    const unnamed: { quad: DetectedQuad; reason: string }[] = [];
    named.forEach((n: NamedQuad, i: number) => {
      const quad = run.result.quads[i]!;
      if (n.face) faces.push({ face: n.face, conf: quad.conf, corners: quad.corners, nameConf: n.nameConf });
      else unnamed.push({ quad, reason: n.reason });
    });
    // `named` is parallel to `quads` and carries the evidence each naming
    // decision was made from. Passing it straight through costs nothing (it is
    // already built) and is the only way a debug view can show the numbers the
    // app used rather than numbers something else recomputed.
    return { ...run.result, faces, unnamed, named, totalMs: performance.now() - run.t0 };
  }

  /** Anonymous quads only - no color sampling, no naming. center-v1 only. */
  async detectQuads(
    source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
    roi?: [number, number, number, number],
  ): Promise<DetectResult> {
    return (await this.run(source, roi)).result;
  }

  /**
   * Record a center observation so the scheme stops relying on the default
   * prior. Callers pass the 9 Lab cells of a face they have already
   * seam-verified and are confident about (see web/src/color-notes.md item 2:
   * center stickers are free labeled exemplars).
   */
  observeCenter(face: FaceId, cells: readonly Lab[], rgb?: [number, number, number]): void {
    this.exemplars.observe(face, cells, rgb);
  }

  private async run(
    source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
    roi?: [number, number, number, number],
  ) {
    const t0 = performance.now();
    const fullW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const fullH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    const r: [number, number, number, number] = roi
      ? [Math.max(0, roi[0]), Math.max(0, roi[1]), Math.min(fullW, roi[2]), Math.min(fullH, roi[3])]
      : [0, 0, fullW, fullH];
    const sw = r[2] - r[0];
    const sh = r[3] - r[1];

    // Letterbox (must mirror model/train/dataset.py letterbox_params):
    // aspect-preserving fit, centered, rgb(114) padding.
    const scale = Math.min(this.iw / sw, this.ih / sh);
    const dx = (this.iw - sw * scale) / 2;
    const dy = (this.ih - sh * scale) / 2;
    this.ctx.fillStyle = 'rgb(114,114,114)';
    this.ctx.fillRect(0, 0, this.iw, this.ih);
    this.ctx.drawImage(source, r[0], r[1], sw, sh, dx, dy, sw * scale, sh * scale);
    const lbFrame = this.ctx.getImageData(0, 0, this.iw, this.ih);
    const { data } = lbFrame;

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

    // Letterbox px -> source px. Corners come out of both heads in the
    // model's own normalized frame, so this is the one place that inverts it.
    const toSource = (u: number, v: number): [number, number] =>
      [(u - dx) / scale + r[0], (v - dy) / scale + r[1]];

    const tensor = out[this.outputName];
    if (!tensor) throw new Error(`model output '${this.outputName}' missing (got ${Object.keys(out).join(', ')})`);
    const y = tensor.data as Float32Array;

    if (!this.anonymous) {
      const faces: DetectedFace[] = [];
      const quads: DetectedQuad[] = [];
      for (let f = 0; f < 6; f++) {
        const conf = 1 / (1 + Math.exp(-y[f * 9]));
        if (conf < CONF_KEEP) continue;
        const corners: [number, number][] = [];
        for (let k = 0; k < 4; k++) {
          corners.push(toSource(y[f * 9 + 1 + 2 * k] * this.iw, y[f * 9 + 2 + 2 * k] * this.ih));
        }
        faces.push({ face: FACE_ORDER[f], conf, corners });
        quads.push({ conf, corners });
      }
      return {
        t0,
        lbFrame: lbFrame as unknown as ImageDataLike,
        lbQuads: [] as [number, number][][],
        result: { faces, quads, unnamed: [], inferMs: t2 - t1, totalMs: performance.now() - t0 },
      };
    }

    const [, , gh, gw] = tensor.dims as number[];
    const dets = decodeMaps(y, gh, gw, this.stride, this.iw, this.ih, TOP_K, CONF_KEEP);
    const quads: DetectedQuad[] = [];
    const lbQuads: [number, number][][] = [];
    for (const d of dets) {
      const lb = d.quad.map(([u, v]) => [u * this.iw, v * this.ih] as [number, number]);
      quads.push({ conf: d.score, corners: lb.map(([u, v]) => toSource(u, v)) });
      lbQuads.push(lb);
    }
    const heatData = new Float32Array(gh * gw);
    for (let i = 0; i < gh * gw; i++) heatData[i] = 1 / (1 + Math.exp(-y[i]));
    const heat: HeatMap = {
      data: heatData, w: gw, h: gh,
      cellToSource: (j, i) => toSource((j + 0.5) * this.stride, (i + 0.5) * this.stride),
    };
    return {
      t0,
      lbFrame: lbFrame as unknown as ImageDataLike,
      lbQuads,
      result: { faces: [], quads, heat, unnamed: [], inferMs: t2 - t1, totalMs: performance.now() - t0 },
    };
  }

  dispose(): void {
    void this.session.release();
  }
}

/**
 * TypeScript mirror of model/train/model.py::decode_maps — 3x3 max-pool NMS,
 * top-K by score, corner = ((j + 0.5 + offx) * stride, (i + 0.5 + offy) * stride).
 *
 * Corners come back NORMALIZED to the model's input frame, exactly as the
 * Python version returns them, so web/test/facekp-decode.test.ts can compare
 * the two numbers for number against a fixture dumped from the Python decode.
 * If you change one, change the other.
 *
 * `maps` is the flat (1, 9, h, w) output tensor, row-major.
 */
export function decodeMaps(
  maps: Float32Array,
  gh: number,
  gw: number,
  stride: number,
  iw: number,
  ih: number,
  k = TOP_K,
  thresh = CONF_KEEP,
): { score: number; quad: [number, number][] }[] {
  const n = gh * gw;
  const heat = new Float32Array(n);
  for (let c = 0; c < n; c++) heat[c] = 1 / (1 + Math.exp(-maps[c]!));
  // Candidates: every cell at or above the threshold, strongest first, ties to
  // the lower cell index (torch.topk on a 1-D view returns the lower index
  // first for equal values).
  const cand: { score: number; cell: number }[] = [];
  for (let c = 0; c < n; c++) if (heat[c]! >= thresh) cand.push({ score: heat[c]!, cell: c });
  cand.sort((a, b) => (b.score - a.score) || (a.cell - b.cell));

  const out: { score: number; quad: [number, number][] }[] = [];
  const keptCentre: [number, number][] = [];
  const keptRadius: number[] = [];
  for (const { score, cell } of cand.slice(0, MAX_CANDIDATES)) {
    const i = Math.floor(cell / gw);
    const j = cell % gw;
    // Decode in input px first: the dedupe radius is a length, so it has to be
    // measured before the x/y normalization stretches the two axes differently.
    const px: [number, number][] = [];
    for (let c = 0; c < 4; c++) {
      const ox = maps[(1 + 2 * c) * n + cell]!;
      const oy = maps[(2 + 2 * c) * n + cell]!;
      px.push([(j + 0.5 + ox) * stride, (i + 0.5 + oy) * stride]);
    }
    let cx = 0;
    let cy = 0;
    let perim = 0;
    for (let c = 0; c < 4; c++) {
      cx += px[c]![0] / 4;
      cy += px[c]![1] / 4;
      perim += Math.hypot(px[(c + 1) % 4]![0] - px[c]![0], px[(c + 1) % 4]![1] - px[c]![1]);
    }
    // Suppression radius scales with the face, so a small cube's three centres
    // stay separable where a fixed one-cell radius merged them. See the
    // DECISION comment on decode_maps in model/train/model.py.
    const radius = Math.max(DEDUPE_FRAC * (perim / 4), MIN_DEDUPE_PX);
    if (keptCentre.some((c, idx) => Math.hypot(c[0] - cx, c[1] - cy) < keptRadius[idx]!)) continue;
    keptCentre.push([cx, cy]);
    keptRadius.push(radius);
    out.push({ score, quad: px.map(([x, y]) => [x / iw, y / ih]) as [number, number][] });
    if (out.length >= k) break;
  }
  return out;
}

// Stage-1 cube localizer (two-stage detector): tiny bbox+objectness net at
// the portrait input its sidecar declares (120x160: the whole 480x640 phone
// frame at scale 0.25, no bars; a landscape webcam gets top/bottom bars).
// Runs on the wasm EP only - at ~0.2M params it's ~1ms, not worth a WebGPU
// session. Returns a box in source coordinates, or null when no cube is
// found. A missing model means the app has NO detection path (there is no
// full-frame stage 2): callers fall back to the grid scanner.
import * as ort from 'onnxruntime-web';
import { letterbox, type Box, type Letterbox } from './geometry';

interface CubeboxMeta {
  input: { shape: number[]; mean: number[]; std: number[] };
  run?: string;
  trainedEpoch?: number;
  realIou?: number;
  minFaceEdgeFrac?: number;
}

const OBJ_THRESHOLD = 0.5;

export interface CubeBox {
  obj: number;
  /** [x0, y0, x1, y1] in source pixels, unpadded. */
  box: Box;
}

export class CubeLocalizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly iw: number;
  readonly ih: number;
  readonly modelId: string;
  /** Objectness of the most recent locate() call, hit or miss (debug overlay). */
  lastObj = 0;

  private constructor(private session: ort.InferenceSession, private meta: CubeboxMeta) {
    const [, , h, w] = meta.input.shape;
    this.iw = w;
    this.ih = h;
    this.modelId = [meta.run ?? 'cubebox', meta.trainedEpoch != null ? `ep${meta.trainedEpoch}` : ''].filter(Boolean).join(' ');
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /** null when the model files aren't deployed. */
  static async load(): Promise<CubeLocalizer | null> {
    const base = import.meta.env.BASE_URL;
    try {
      const metaRes = await fetch(`${base}models/cubebox.json`);
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as CubeboxMeta;
      const modelRes = await fetch(`${base}models/cubebox.onnx`);
      if (!modelRes.ok) return null;
      const buf = await modelRes.arrayBuffer();
      const session = await ort.InferenceSession.create(new Uint8Array(buf), {
        executionProviders: ['wasm'],
      });
      return new CubeLocalizer(session, meta);
    } catch {
      return null;
    }
  }

  async locate(source: CanvasImageSource, sw: number, sh: number): Promise<CubeBox | null> {
    const lb = letterbox(sw, sh, this.iw, this.ih);
    const { scale, dx, dy } = lb;
    this.ctx.fillStyle = 'rgb(114,114,114)';
    this.ctx.fillRect(0, 0, this.iw, this.ih);
    this.ctx.drawImage(source, dx, dy, sw * scale, sh * scale);
    const px = this.ctx.getImageData(0, 0, this.iw, this.ih).data;
    const [mr, mg, mb] = this.meta.input.mean;
    const [sr, sg, sb] = this.meta.input.std;
    const plane = this.iw * this.ih;
    const x = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      x[i] = (px[i * 4] / 255 - mr) / sr;
      x[plane + i] = (px[i * 4 + 1] / 255 - mg) / sg;
      x[2 * plane + i] = (px[i * 4 + 2] / 255 - mb) / sb;
    }
    const out = await this.session.run({
      image: new ort.Tensor('float32', x, [1, 3, this.ih, this.iw]),
    });
    const hit = decodeBox(out.box.data as Float32Array, this.iw, this.ih, lb);
    this.lastObj = hit.obj;
    return hit.obj < OBJ_THRESHOLD ? null : hit;
  }
}

/**
 * The exported head emits 5 logits [obj, cx, cy, w, h]; cx/cy/w/h are
 * sigmoids in model-input units and come back here in source px through the
 * letterbox inverse. Pure, so the mapping is unit-tested without a session.
 */
export function decodeBox(y: ArrayLike<number>, iw: number, ih: number, lb: Letterbox): CubeBox {
  const sig = (v: number) => 1 / (1 + Math.exp(-v));
  const obj = sig(y[0]);
  const cx = sig(y[1]) * iw;
  const cy = sig(y[2]) * ih;
  const w = sig(y[3]) * iw;
  const h = sig(y[4]) * ih;
  const [x0, y0] = lb.toSource(cx - w / 2, cy - h / 2);
  const [x1, y1] = lb.toSource(cx + w / 2, cy + h / 2);
  return { obj, box: [x0, y0, x1, y1] };
}

export { padBox } from './geometry';

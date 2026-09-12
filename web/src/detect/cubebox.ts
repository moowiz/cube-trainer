// Stage-1 cube localizer (two-stage detector): tiny bbox+objectness net at
// 160x120. Runs on the wasm EP only - at ~0.2M params it's ~1ms, not worth
// a WebGPU session. Returns a box in source coordinates, or null when no
// cube is found (or the model isn't deployed - callers must degrade to
// full-frame stage 2).
import * as ort from 'onnxruntime-web';

interface CubeboxMeta {
  input: { shape: number[]; mean: number[]; std: number[] };
  run?: string;
}

const OBJ_THRESHOLD = 0.5;

export interface CubeBox {
  obj: number;
  /** [x0, y0, x1, y1] in source pixels, unpadded. */
  box: [number, number, number, number];
}

export class CubeLocalizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private iw: number;
  private ih: number;
  readonly modelId: string;

  private constructor(private session: ort.InferenceSession, private meta: CubeboxMeta) {
    const [, , h, w] = meta.input.shape;
    this.iw = w;
    this.ih = h;
    this.modelId = meta.run ?? 'cubebox';
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
    const scale = Math.min(this.iw / sw, this.ih / sh);
    const dx = (this.iw - sw * scale) / 2;
    const dy = (this.ih - sh * scale) / 2;
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
    const y = out.box.data as Float32Array;
    const sig = (v: number) => 1 / (1 + Math.exp(-v));
    const obj = sig(y[0]);
    if (obj < OBJ_THRESHOLD) return null;
    const cx = sig(y[1]) * this.iw;
    const cy = sig(y[2]) * this.ih;
    const w = sig(y[3]) * this.iw;
    const h = sig(y[4]) * this.ih;
    const box: [number, number, number, number] = [
      ((cx - w / 2) - dx) / scale,
      ((cy - h / 2) - dy) / scale,
      ((cx + w / 2) - dx) / scale,
      ((cy + h / 2) - dy) / scale,
    ];
    return { obj, box };
  }
}

/** Expand a box by `frac` per side and clamp to the source bounds. */
export function padBox(
  box: [number, number, number, number], frac: number, sw: number, sh: number,
): [number, number, number, number] {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return [
    Math.max(0, box[0] - frac * w),
    Math.max(0, box[1] - frac * h),
    Math.min(sw, box[2] + frac * w),
    Math.min(sh, box[3] + frac * h),
  ];
}

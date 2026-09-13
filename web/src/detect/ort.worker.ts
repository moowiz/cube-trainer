// Web Worker that owns onnxruntime-web sessions for the wasm EP, so
// inference never blocks the page's animation loop. Bundled by Vite as a
// module worker (session.ts creates it with `new URL(..., import.meta.url)`);
// ort-web's own `env.wasm.proxy` could not be used because its proxy spawns
// a worker from the *bundled* chunk, which touches `document` and dies
// ("no available backend found. ERR: [wasm] [object ErrorEvent]").
//
// Protocol (session.ts is the only client): one `init`, then `create` /
// `run` / `dispose` per session, every request answered by `{ req, ok }`.
// Tensor data crosses as typed arrays with their buffers transferred.
import * as ort from 'onnxruntime-web';

export interface TensorWire { data: Float32Array | Int32Array | Uint8Array; dims: readonly number[]; type: string }
export type WorkerRequest =
  | { t: 'init'; req: number; wasmPaths: string }
  | { t: 'create'; req: number; id: number; model: ArrayBuffer; ep: 'wasm' }
  | { t: 'run'; req: number; id: number; feeds: Record<string, TensorWire> }
  | { t: 'dispose'; req: number; id: number };
export type WorkerReply =
  | { req: number; ok: true; threads?: number; inputNames?: string[]; outputNames?: string[]; outputs?: Record<string, TensorWire> }
  | { req: number; ok: false; error: string };

const sessions = new Map<number, ort.InferenceSession>();

function reply(msg: WorkerReply, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.t === 'init') {
      ort.env.wasm.wasmPaths = m.wasmPaths;
      // the worker inherits the page's cross-origin isolation (the COI
      // service worker's headers), and with it SharedArrayBuffer + threads
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      reply({ req: m.req, ok: true, threads: ort.env.wasm.numThreads });
    } else if (m.t === 'create') {
      const s = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: [m.ep], graphOptimizationLevel: 'all' });
      sessions.set(m.id, s);
      reply({ req: m.req, ok: true, inputNames: [...s.inputNames], outputNames: [...s.outputNames] });
    } else if (m.t === 'run') {
      const s = sessions.get(m.id);
      if (!s) throw new Error(`no session ${m.id}`);
      const feeds: Record<string, ort.Tensor> = {};
      for (const [k, v] of Object.entries(m.feeds)) feeds[k] = new ort.Tensor(v.type as 'float32', v.data as Float32Array, v.dims);
      const out = await s.run(feeds);
      const outputs: Record<string, TensorWire> = {};
      const transfer: Transferable[] = [];
      for (const [k, t] of Object.entries(out)) {
        const data = t.data as Float32Array;
        outputs[k] = { data, dims: t.dims, type: t.type };
        if (data.buffer instanceof ArrayBuffer) transfer.push(data.buffer);
      }
      reply({ req: m.req, ok: true, outputs }, transfer);
    } else if (m.t === 'dispose') {
      const s = sessions.get(m.id);
      sessions.delete(m.id);
      if (s) await s.release();
      reply({ req: m.req, ok: true });
    }
  } catch (err) {
    reply({ req: m.req, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};

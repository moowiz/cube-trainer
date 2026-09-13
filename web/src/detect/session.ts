// One place that creates onnxruntime-web sessions for the app.
//
// The wasm EP goes to a dedicated Web Worker (ort.worker.ts) so the 30-45 ms
// per inference on a phone no longer stalls the animation loop; WebGPU
// stays on the main thread (it is asynchronous on the GPU anyway, and the
// worker has no WebGPU here). The two runtimes are separate module
// instances, so a webgpu session on the page and a wasm session in the
// worker coexist without ort-web's "multiple calls to initWasm()".
//
// Callers see `RunSession`: the subset of ort.InferenceSession they use.
import * as ort from 'onnxruntime-web';
import type { TensorWire, WorkerReply, WorkerRequest } from './ort.worker';

export type Ep = 'webgpu' | 'wasm';

export interface RunSession {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  release(): Promise<void>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** true when inference runs in the worker */
  readonly offThread: boolean;
  /** wasm threads the runtime that hosts this session was configured with */
  readonly threads: number;
}

/** Page-side wasm configuration, applied once (used for main-thread sessions). */
export function configureMainThreadWasm(): void {
  const base = import.meta.env.BASE_URL;
  ort.env.wasm.wasmPaths = `${base}ort/`;
  // GitHub Pages sends no COOP/COEP headers, so no SharedArrayBuffer there
  // unless the COI service worker took control (scan-main registers it).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
}

class WorkerHost {
  private worker: Worker;
  private req = 0;
  private pending = new Map<number, { resolve: (r: WorkerReply) => void }>();
  private ready: Promise<number>;
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('./ort.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const p = this.pending.get(e.data.req);
      if (!p) return;
      this.pending.delete(e.data.req);
      p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const [req, p] of this.pending) { this.pending.delete(req); p.resolve({ req, ok: false, error: `worker error: ${e.message}` }); }
    };
    const wasmPaths = new URL(`${import.meta.env.BASE_URL}ort/`, location.href).href;
    this.ready = this.send({ t: 'init', req: 0, wasmPaths }).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.threads ?? 1;
    });
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerReply> {
    const req = ++this.req;
    return new Promise((resolve) => {
      this.pending.set(req, { resolve });
      this.worker.postMessage({ ...msg, req }, transfer);
    });
  }

  async create(model: Uint8Array): Promise<RunSession> {
    const threads = await this.ready;
    const id = this.nextId++;
    // copy so the caller keeps its bytes (the benchmark creates several sessions from one buffer)
    const bytes = model.slice().buffer;
    const r = await this.send({ t: 'create', req: 0, id, model: bytes, ep: 'wasm' }, [bytes]);
    if (!r.ok) throw new Error(r.error);
    return {
      inputNames: r.inputNames ?? [],
      outputNames: r.outputNames ?? [],
      offThread: true,
      threads,
      run: async (feeds) => {
        // inputs are cloned, not transferred: callers may reuse their buffers
        const wire: Record<string, TensorWire> = {};
        for (const [k, t] of Object.entries(feeds)) wire[k] = { data: t.data as Float32Array, dims: t.dims, type: t.type };
        const rr = await this.send({ t: 'run', req: 0, id, feeds: wire });
        if (!rr.ok) throw new Error(rr.error);
        const out: Record<string, ort.Tensor> = {};
        for (const [k, v] of Object.entries(rr.outputs ?? {})) out[k] = new ort.Tensor(v.type as 'float32', v.data as Float32Array, v.dims);
        return out;
      },
      release: async () => { await this.send({ t: 'dispose', req: 0, id }); },
    };
  }
}

let host: WorkerHost | null = null;
let workerBroken = false;

/**
 * Create a session for `ep`. wasm sessions live in the worker when the
 * browser has module workers; if the worker fails to come up the page falls
 * back to a main-thread wasm session and remembers not to try again.
 */
export async function createSession(model: Uint8Array, ep: Ep): Promise<RunSession> {
  if (ep === 'wasm' && !workerBroken && typeof Worker !== 'undefined') {
    try {
      host ??= new WorkerHost();
      return await host.create(model);
    } catch (err) {
      workerBroken = true;
      console.warn('ort worker unavailable, falling back to main-thread wasm:', err);
    }
  }
  configureMainThreadWasm();
  const s = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });
  return {
    inputNames: s.inputNames,
    outputNames: s.outputNames,
    offThread: false,
    threads: ort.env.wasm.numThreads ?? 1,
    run: (feeds) => s.run(feeds),
    release: () => s.release(),
  };
}

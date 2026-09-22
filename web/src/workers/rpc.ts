// A request/reply channel over a Worker (docs/maintenance-plan.md 3.9): every
// request goes out with a fresh `id`, the reply that carries the same id
// resolves it, and a message without a pending id (progress, a ready note, a
// warm-up ack) goes to `onEvent`. A worker error rejects every open request
// so nothing waits for ever. The three pending-map clients this replaces
// (cubejs solve, the ORT session host, EOCross) each had this in ~15 lines.
//
// colour/sampler.ts is not a client: its in-flight counter with drop-not-
// queue back-pressure is the point of that file.

type Pending<Rep> = { resolve: (r: Rep) => void; reject: (e: Error) => void };

export class WorkerRpc<Req extends object, Rep extends { id?: number }> {
  private pending = new Map<number, Pending<Rep>>();
  private nextId = 1;

  constructor(readonly worker: Worker, opts: { name?: string; onEvent?: (m: Rep) => void; onError?: (e: Error) => void } = {}) {
    worker.onmessage = (ev: MessageEvent<Rep>) => {
      const m = ev.data;
      const p = m.id === undefined ? undefined : this.pending.get(m.id);
      if (!p) { opts.onEvent?.(m); return; }
      this.pending.delete(m.id!);
      p.resolve(m);
    };
    worker.onerror = (ev) => {
      const err = new Error(`${opts.name ?? 'worker'}: ${ev.message || 'failed'}`);
      this.fail(err);
      opts.onError?.(err);
    };
  }

  /** Send `msg` under a fresh id; resolves with the reply that carries it. */
  ask(msg: Req, transfer: Transferable[] = []): Promise<Rep> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Send with no reply expected. */
  post(msg: Req, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** Reject every open request (the worker died, or the caller is giving up on it). */
  fail(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  get open(): number { return this.pending.size; }
}

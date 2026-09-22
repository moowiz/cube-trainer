// workers/rpc.ts: the request/reply channel the cubejs solve, the ORT session host and the
// EOCross client share, and the EOCross client's own start-once rule, on a fake Worker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerRpc } from '../src/workers/rpc';
import { EOCrossClient } from '../src/eo/eocross';

class FakeWorker {
  static made: FakeWorker[] = [];
  static failToStart = false;
  posted: { msg: Record<string, unknown>; transfer: Transferable[] }[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  constructor(readonly url: string | URL) {
    if (FakeWorker.failToStart) throw new Error('no worker here');
    FakeWorker.made.push(this);
  }
  postMessage(msg: Record<string, unknown>, transfer: Transferable[] = []): void { this.posted.push({ msg, transfer }); }
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
  die(message = 'boom'): void { this.onerror?.({ message } as ErrorEvent); }
}

beforeEach(() => { FakeWorker.made = []; FakeWorker.failToStart = false; (globalThis as { Worker?: unknown }).Worker = FakeWorker; });
afterEach(() => { delete (globalThis as { Worker?: unknown }).Worker; });

describe('WorkerRpc', () => {
  it('gives each ask a fresh id and resolves it with the reply that carries it, whatever the order', async () => {
    const w = new FakeWorker('x');
    const rpc = new WorkerRpc<{ q: string }, { id?: number; a: string }>(w as unknown as Worker);
    const first = rpc.ask({ q: 'one' });
    const second = rpc.ask({ q: 'two' });
    expect(w.posted.map((p) => p.msg)).toEqual([{ q: 'one', id: 1 }, { q: 'two', id: 2 }]);
    expect(rpc.open).toBe(2);
    w.reply({ id: 2, a: 'B' });
    w.reply({ id: 1, a: 'A' });
    expect(await second).toEqual({ id: 2, a: 'B' });
    expect(await first).toEqual({ id: 1, a: 'A' });
    expect(rpc.open).toBe(0);
  });

  it('routes a message with no pending id to onEvent, and post() sends without an id', () => {
    const w = new FakeWorker('x');
    const events: unknown[] = [];
    const rpc = new WorkerRpc<{ t: string }, { id?: number; t?: string }>(w as unknown as Worker, { onEvent: (m) => events.push(m) });
    rpc.post({ t: 'init' });
    expect(w.posted[0]!.msg).toEqual({ t: 'init' });
    w.reply({ t: 'progress' });
    w.reply({ id: 99, t: 'stale' }); // an id nobody waits on is an event too, not a crash
    expect(events).toEqual([{ t: 'progress' }, { id: 99, t: 'stale' }]);
  });

  it('a worker error rejects every open ask with the worker\'s name and tells onError', async () => {
    const w = new FakeWorker('x');
    const onError = vi.fn();
    const rpc = new WorkerRpc<{ q: number }, { id?: number }>(w as unknown as Worker, { name: 'test worker', onError });
    const a = rpc.ask({ q: 1 }), b = rpc.ask({ q: 2 });
    w.die('gone');
    await expect(a).rejects.toThrow('test worker: gone');
    await expect(b).rejects.toThrow('test worker: gone');
    expect(rpc.open).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('passes the transfer list through', () => {
    const w = new FakeWorker('x');
    const rpc = new WorkerRpc<{ buf: ArrayBuffer }, { id?: number }>(w as unknown as Worker);
    const buf = new ArrayBuffer(8);
    void rpc.ask({ buf }, [buf]);
    expect(w.posted[0]!.transfer).toEqual([buf]);
  });
});

describe('EOCrossClient', () => {
  it('starts the worker once, on first use, with the move model from cube/pieces.ts', async () => {
    const c = new EOCrossClient();
    expect(c.status).toBe('off');
    expect(c.ensure()).toBe(true);
    expect(c.ensure()).toBe(true);
    expect(FakeWorker.made).toHaveLength(1);
    expect(c.status).toBe('building');
    const init = FakeWorker.made[0]!.posted[0]!.msg;
    expect(init.type).toBe('init');
    expect(init.perm).toHaveLength(18);
    expect(init.flip).toHaveLength(18);
  });

  it('queues requests behind the build, repaints on progress and ready, and answers by id', async () => {
    const c = new EOCrossClient();
    const repaints = vi.fn();
    c.onStatus = repaints;
    const p = c.dists([{ eo: 0, slots: [0, 1, 2, 3] }]);
    const w = FakeWorker.made[0]!;
    expect(w.posted[1]!.msg).toMatchObject({ type: 'dists', id: 1 });
    w.reply({ type: 'progress', depth: 4 });
    expect(c.depth).toBe(4);
    w.reply({ type: 'ready' });
    expect(c.status).toBe('ready');
    expect(repaints).toHaveBeenCalledTimes(2);
    w.reply({ id: 1, ds: [3] });
    expect(await p).toEqual([3]);
  });

  it('a worker that cannot start fails once and every later request rejects without a retry', async () => {
    FakeWorker.failToStart = true;
    const c = new EOCrossClient();
    expect(c.ensure()).toBe(false);
    expect(c.status).toBe('failed');
    await expect(c.dists([])).rejects.toThrow();
    FakeWorker.failToStart = false;
    expect(c.ensure()).toBe(false);
    expect(FakeWorker.made).toHaveLength(0);
    expect(c.note()).toMatch(/could not start/);
  });

  it('a worker that dies mid-build fails the client and rejects what was waiting', async () => {
    const c = new EOCrossClient();
    const p = c.dists([]);
    FakeWorker.made[0]!.die();
    await expect(p).rejects.toThrow('eocross worker');
    expect(c.status).toBe('failed');
    expect(c.ensure()).toBe(false);
  });
});

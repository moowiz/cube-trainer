// SamplerClient: at most maxInFlight frames out to the sampling worker at
// once, further frames are dropped (never queued), and replies drive
// onSampled and the ms EMA. A fake Worker on globalThis records
// postMessage calls and lets the test reply through onmessage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SamplerClient } from '../src/colour/sampler';
import type { SampleResponse } from '../src/colour/sample.worker';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<SampleResponse>) => void) | null = null;
  posted: { msg: unknown; transfer?: Transferable[] }[] = [];
  constructor(public url: unknown, public opts?: unknown) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown, transfer?: Transferable[]): void {
    this.posted.push({ msg, transfer });
  }
  terminate(): void { /* not used by SamplerClient */ }

  reply(data: SampleResponse): void {
    this.onmessage?.({ data } as MessageEvent<SampleResponse>);
  }
}

function pixels(): ArrayBuffer {
  return new ArrayBuffer(4);
}

function response(overrides: Partial<SampleResponse> = {}): SampleResponse {
  return { type: 'sampled', frame: 0, quads: [], refined: [], ms: 5, ...overrides };
}

describe('SamplerClient', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  });
  afterEach(() => {
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  function worker(): FakeWorker {
    return FakeWorker.instances[0]!;
  }

  it('posts and returns true while fewer than maxInFlight frames are out', () => {
    const client = new SamplerClient(2);
    expect(client.sample(1, 100, 2, 2, pixels(), [], false)).toBe(true);
    expect(client.sample(2, 101, 2, 2, pixels(), [], false)).toBe(true);
    expect(worker().posted).toHaveLength(2);
    expect(client.dropped).toBe(0);
  });

  it('drops (does not post) the (maxInFlight + 1)th sample', () => {
    const client = new SamplerClient(2);
    client.sample(1, 100, 2, 2, pixels(), [], false);
    client.sample(2, 101, 2, 2, pixels(), [], false);
    const ok = client.sample(3, 102, 2, 2, pixels(), [], false);
    expect(ok).toBe(false);
    expect(worker().posted).toHaveLength(2); // nothing posted for the dropped frame
    expect(client.dropped).toBe(1);
  });

  it('a reply frees a slot for another sample', () => {
    const client = new SamplerClient(1);
    client.sample(1, 100, 2, 2, pixels(), [], false);
    expect(client.sample(2, 101, 2, 2, pixels(), [], false)).toBe(false);
    worker().reply(response({ frame: 1, ms: 5 }));
    expect(client.sample(3, 102, 2, 2, pixels(), [], false)).toBe(true);
    expect(worker().posted).toHaveLength(2);
  });

  it('busy reflects the in-flight count', () => {
    const client = new SamplerClient(2);
    expect(client.busy).toBe(false);
    client.sample(1, 100, 2, 2, pixels(), [], false);
    expect(client.busy).toBe(false);
    client.sample(2, 101, 2, 2, pixels(), [], false);
    expect(client.busy).toBe(true);
    worker().reply(response({ frame: 1 }));
    expect(client.busy).toBe(false);
  });

  it('onSampled gets every reply, in order', () => {
    const client = new SamplerClient(3);
    const seen: number[] = [];
    client.onSampled = (r) => seen.push(r.frame);
    client.sample(1, 0, 2, 2, pixels(), [], false);
    client.sample(2, 1, 2, 2, pixels(), [], false);
    client.sample(3, 2, 2, 2, pixels(), [], false);
    worker().reply(response({ frame: 1 }));
    worker().reply(response({ frame: 2 }));
    worker().reply(response({ frame: 3 }));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('msEma equals the first reply, then follows 0.2*ms + 0.8*prev', () => {
    const client = new SamplerClient(3);
    client.sample(1, 0, 2, 2, pixels(), [], false);
    worker().reply(response({ ms: 10 }));
    expect(client.msEma).toBe(10);
    client.sample(2, 1, 2, 2, pixels(), [], false);
    worker().reply(response({ ms: 20 }));
    expect(client.msEma).toBeCloseTo(0.2 * 20 + 0.8 * 10, 10);
    client.sample(3, 2, 2, 2, pixels(), [], false);
    const prev = client.msEma;
    worker().reply(response({ ms: 5 }));
    expect(client.msEma).toBeCloseTo(0.2 * 5 + 0.8 * prev, 10);
  });

  it('transfers the pixel buffer', () => {
    const client = new SamplerClient(2);
    const buf = pixels();
    client.sample(1, 0, 2, 2, buf, [], false);
    expect(worker().posted[0]!.transfer).toEqual([buf]);
  });
});

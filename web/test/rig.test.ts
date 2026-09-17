// The recording rig's client (src/rig/stream.ts): requests go out in order,
// to the right paths, appends flagged, a failure retried once then counted,
// and the probe says whether a sink exists.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingSession, sessionName } from '../src/rig/session';
import { RecordingStream } from '../src/rig/stream';

type Call = { url: string; method?: string; body?: unknown };

function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method, body: init?.body };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = () => new Response('ok', { status: 200 });

describe('RecordingStream', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sends appends and puts in order to the session folder', async () => {
    const { f, calls } = fakeFetch(ok);
    globalThis.fetch = f;
    const s = new RecordingStream('2026-09-21-1200', '/cube-trainer/');
    void s.append('video.webm', new Blob([new Uint8Array([1, 2, 3])]));
    void s.append('cube.jsonl', '{"kind":"move"}\n');
    void s.put('meta.json', '{}');
    await s.flush();
    expect(calls.map((c) => c.url)).toEqual([
      '/cube-trainer/__recording/2026-09-21-1200/video.webm?append=1',
      '/cube-trainer/__recording/2026-09-21-1200/cube.jsonl?append=1',
      '/cube-trainer/__recording/2026-09-21-1200/meta.json',
    ]);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
    expect(s.count()).toBe(3);
    expect(s.failed()).toBe(0);
  });

  it('retries a failed request once, then counts it, and keeps going', async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => (++n === 1 ? new Response('no', { status: 500 }) : ok()));
    globalThis.fetch = f;
    const s = new RecordingStream('s', '/');
    await s.append('a.bin', 'x');
    expect(calls).toHaveLength(2);
    expect(s.failed()).toBe(0);
    n = -10; // the next two attempts both fail
    const { f: f2 } = fakeFetch(() => { n++; return new Response('no', { status: 500 }); });
    globalThis.fetch = f2;
    await s.append('b.bin', 'y');
    expect(s.failed()).toBe(1);
    expect(s.count()).toBe(1);
  });

  it('a session names its files, keeps the meta current, and closes with the failure count', async () => {
    const { f, calls } = fakeFetch(ok);
    globalThis.fetch = f;
    const s = new RecordingSession(new RecordingStream('2026-09-21-120400', '/'), { now: () => 1000, device: 'test' });
    await s.writeMeta();
    await s.videoChunk(new Blob(['v']), 1500.4);
    await s.videoChunk(new Blob(['w']), 2500);
    await s.cubeHeader({ version: 1 }, { name: 'GAN', protocol: 'gen2', scheme: { U: 'white' } });
    await s.cubeHeader({ version: 1 }, { name: 'GAN', protocol: 'gen2', scheme: { U: 'white' } }); // once
    await s.cubeEvent({ kind: 'move', t: 2000, move: 'R' });
    await s.solve({ id: 'a', when: 1, t0: 1500, t1: 2500, scramble: 'R', time: 1000 });
    await s.evidence('{"log":[]}');
    const meta = await s.stop();
    expect(calls.map((c) => c.url.replace('/__recording/2026-09-21-120400/', ''))).toEqual([
      'meta.json', 'video.webm?append=1', 'video.webm?append=1', 'cube.jsonl?append=1', 'cube.jsonl?append=1', 'solves.jsonl?append=1', 'evidence.json', 'meta.json',
    ]);
    expect(calls[3].body).toBe('{"header":{"version":1}}\n');
    expect(meta).toMatchObject({ version: 2, session: '2026-09-21-120400', t0: 1000, device: 'test', chunks: 2, chunkT: [1500, 2500], solves: 1, failed: 0, cube: { name: 'GAN' } });
    expect(typeof meta.endedAt).toBe('number');
    expect(JSON.parse(String(calls[7].body)).endedAt).toBe(meta.endedAt);
  });

  it('names a session from the clock', () => {
    expect(sessionName(new Date(2026, 8, 21, 12, 4, 9))).toBe('2026-09-21-120409');
  });

  it('refuses bad names and probes the sink', async () => {
    expect(() => new RecordingStream('../etc', '/')).toThrow();
    const s = new RecordingStream('ok', '/');
    await expect(s.append('../x', 'y')).rejects.toThrow();
    const { f } = fakeFetch(() => new Response(JSON.stringify({ ok: true, dir: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await RecordingStream.available('/', f)).toBe(true);
    const { f: gone } = fakeFetch(() => new Response('', { status: 404 }));
    expect(await RecordingStream.available('/', gone)).toBe(false);
  });
});

// FrameRing: recent frames frozen into per-slot canvases with a running
// index. No real canvas in node - document.createElement('canvas') is
// stubbed to a plain object that tracks width/height assignments and a
// no-op drawImage, and the "video" is just { videoWidth, videoHeight }.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameRing } from '../src/framering';

interface FakeCanvas {
  width: number;
  height: number;
  widthWrites: number;
  heightWrites: number;
  getContext(): { drawImage(): void };
}

function fakeCanvas(): FakeCanvas {
  let w = 0;
  let h = 0;
  const c: FakeCanvas = {
    get width() { return w; },
    set width(v: number) { w = v; c.widthWrites++; },
    get height() { return h; },
    set height(v: number) { h = v; c.heightWrites++; },
    widthWrites: 0,
    heightWrites: 0,
    getContext: () => ({ drawImage() { /* no-op */ } }),
  };
  return c;
}

function fakeVideo(videoWidth: number, videoHeight: number) {
  return { videoWidth, videoHeight } as unknown as HTMLVideoElement;
}

describe('FrameRing', () => {
  let created: FakeCanvas[] = [];
  beforeEach(() => {
    created = [];
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
        const c = fakeCanvas();
        created.push(c);
        return c;
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('head is -1 before the first push and the pushed index after', () => {
    const ring = new FrameRing(3);
    expect(ring.head).toBe(-1);
    const f = ring.push(fakeVideo(640, 480), 100);
    expect(f.index).toBe(0);
    expect(ring.head).toBe(0);
  });

  it('get() returns the frozen frame while in the ring, null once overwritten', () => {
    const size = 3;
    const ring = new FrameRing(size);
    const video = fakeVideo(640, 480);
    for (let i = 0; i <= size; i++) ring.push(video, i * 10); // size + 1 pushes: 0..size
    expect(ring.get(0)).toBeNull(); // overwritten by the wraparound push
    const f1 = ring.get(1);
    expect(f1).not.toBeNull();
    expect(f1!.index).toBe(1);
  });

  it('get() is null for negative and future indices', () => {
    const ring = new FrameRing(3);
    ring.push(fakeVideo(640, 480), 0);
    expect(ring.get(-1)).toBeNull();
    expect(ring.get(ring.head + 1)).toBeNull();
  });

  it('indices stay monotonic across more than one lap; get(head) is always the last pushed', () => {
    const size = 4;
    const ring = new FrameRing(size);
    const video = fakeVideo(320, 240);
    const seen: number[] = [];
    for (let i = 0; i < 3 * size; i++) {
      const f = ring.push(video, i);
      seen.push(f.index);
      expect(ring.head).toBe(f.index);
      const got = ring.get(ring.head);
      expect(got).not.toBeNull();
      expect(got!.index).toBe(f.index);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
  });

  it('resizes the canvas only when the video size changes', () => {
    const ring = new FrameRing(1); // one slot, reused every push
    const a = fakeVideo(640, 480);
    ring.push(a, 0);
    const canvas = created[0]!;
    expect(canvas.widthWrites).toBe(1); // first push always sizes the fresh canvas
    ring.push(a, 1); // same size again: no resize
    expect(canvas.widthWrites).toBe(1);
    ring.push(a, 2);
    expect(canvas.widthWrites).toBe(1);
    const b = fakeVideo(320, 240); // size changed: resize once
    ring.push(b, 3);
    expect(canvas.widthWrites).toBe(2);
    ring.push(b, 4); // same new size: no further resize
    expect(canvas.widthWrites).toBe(2);
  });

  it('reset() makes every earlier index unreachable and the next push starts at 0', () => {
    const ring = new FrameRing(3);
    const video = fakeVideo(640, 480);
    ring.push(video, 0);
    ring.push(video, 1);
    ring.push(video, 2);
    ring.reset();
    expect(ring.head).toBe(-1);
    expect(ring.get(0)).toBeNull();
    expect(ring.get(1)).toBeNull();
    expect(ring.get(2)).toBeNull();
    const f = ring.push(video, 10);
    expect(f.index).toBe(0);
    expect(ring.head).toBe(0);
    expect(ring.get(0)).not.toBeNull();
  });
});

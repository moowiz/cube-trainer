// The smart cube as a MoveSource (docs/smart-cube-design.md 3.1): capture
// events in (from the adapter live, or from a capture replayed), the
// belief and the two-clock fit kept, MoveSource items out. Nothing here
// touches Bluetooth; the adapter does, and a replay needs none.

import type { MoveEvent, MoveSource, ResyncItem, SourceItem } from '../moves/source';
import type { ColorName, FaceId } from '../types';
import { Capture, type CaptureEvent, type CaptureHeader } from './capture';
import { ClockFit } from './clock';
import { EMPTY_STATUS, reduce, type CubeStatus } from './belief';

export class CubeSource implements MoveSource {
  readonly kind: 'cube' | 'replay';
  readonly capture: Capture;
  readonly clock = new ClockFit();
  private status_: CubeStatus = EMPTY_STATUS;
  private readonly items_: SourceItem[] = [];
  private readonly subs = new Set<(item: SourceItem) => void>();
  private readonly now: () => number;

  constructor(readonly colourOf: Record<FaceId, ColorName>, opts: { kind?: 'cube' | 'replay'; now?: () => number; header?: Partial<CaptureHeader> } = {}) {
    this.kind = opts.kind ?? 'cube';
    this.now = opts.now ?? (() => performance.now());
    const t0 = this.now();
    this.capture = new Capture({ version: 1, startedAt: Date.now(), t0, scheme: colourOf, ...opts.header });
  }

  status(): CubeStatus { return this.status_; }
  state(): string | null { return this.status_.belief; }
  items(): readonly SourceItem[] { return this.items_; }

  /** An event from the cube (or a replayed capture): recorded, reduced, and turned into items. */
  feed(e: CaptureEvent): void {
    this.capture.push(e);
    this.status_ = reduce(this.status_, e);
    if (e.kind === 'move') {
      const ev: MoveEvent = { kind: 'move', move: e.move, t: e.t, sure: true };
      if (e.tRaw !== null) { this.clock.add(e.tRaw, e.t); ev.tRaw = e.tRaw; }
      this.emit(ev);
    } else if (e.kind === 'resync') {
      this.emit({ kind: 'resync', t: e.t, facelets: e.facelets, how: e.how });
    } else if (e.kind === 'facelets' && this.status_.movesSinceSync === 0 && this.items_.length === 0) {
      // the first report is the state everything starts from: consumers hear it as a resync
      this.emit({ kind: 'resync', t: e.t, facelets: e.facelets, how: 'report' });
    }
  }

  resync(facelets: string, how: ResyncItem['how']): void {
    this.feed({ kind: 'resync', t: this.now(), facelets, how });
  }

  /** A free note into the capture (a measurement, a remark). */
  note(text: string): void { this.feed({ kind: 'note', t: this.now(), text }); }

  subscribe(cb: (item: SourceItem) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  dispose(): void { this.subs.clear(); }

  private emit(item: SourceItem): void {
    this.items_.push(item);
    for (const cb of this.subs) cb(item);
  }
}

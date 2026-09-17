// A drill driven by a MoveSource (docs/smart-cube-design.md 3.4). The
// cube in your hands has to be scrambled first, and those turns are not
// the attempt: the driver ARMS when the source's belief reaches the
// stage's expected state (csTimer's "mark scrambled", automatic), then
// every turn is part of the attempt until the stage says it is done.
// Coming back to the scramble state re-arms (an undo: the box clears); a
// new scramble or tab starts over; a resync or a gap disarms (the belief
// moved without turns) until the scramble state is seen again.
//
// Pure: the host feeds it the source's items and the expected state in
// the source's letters, and it says what to put in the moves box.

import type { Move } from './moves';
import type { MoveSource, SourceItem } from './source';

export interface Feed {
  /** the attempt's turns so far, in the source's letters (empty on a re-arm: clear the box) */
  moves: Move[];
  /** host time of the last turn (of the re-arm when moves is empty) */
  t: number;
}

export class DrillDriver {
  private key: string | null = null;
  private armed = false;
  private done = false;
  private cursor = 0; // items consumed
  private start = 0;  // the item index the attempt begins at

  isArmed(): boolean { return this.armed && !this.done; }

  /** Forget everything (the source changed): the next step() starts over from that source's current items. */
  reset(): void { this.key = null; this.armed = false; this.done = false; this.cursor = 0; this.start = 0; }

  /** The attempt ended (the stage judged it): further turns are ignored until the next scramble. */
  finish(): void { this.done = true; }

  /**
   * Consume the source's new items. `expected` is the stage's scramble state
   * in the source's letters (null when no stage is up); `key` identifies the
   * scramble (tab + scramble text) so a new one starts over. Returns the
   * feeds to make, in order.
   */
  step(source: Pick<MoveSource, 'state' | 'items'>, expected: string | null, key: string | null): Feed[] {
    const out: Feed[] = [];
    const items = source.items();
    if (key !== this.key) { this.key = key; this.armed = false; this.done = false; this.cursor = items.length; this.start = items.length; }
    if (expected === null) { this.cursor = items.length; return out; }
    for (let i = this.cursor; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind !== 'move') { this.armed = false; continue; }
      if (this.armed && !this.done) out.push({ moves: movesBetween(items, this.start, i), t: it.t });
    }
    this.cursor = items.length;
    if (!this.done && source.state() === expected) {
      if (!this.armed) { this.armed = true; this.start = items.length; }
      else if (this.start < items.length) {
        // back at the scramble: whatever was turned since is void
        out.push({ moves: [], t: timeOf(items[items.length - 1]!) });
        this.start = items.length;
      }
    }
    return out;
  }
}

const timeOf = (it: SourceItem): number => (it.kind === 'gap' ? it.t1 : it.t);

function movesBetween(items: readonly SourceItem[], from: number, to: number): Move[] {
  const ms: Move[] = [];
  for (let i = from; i <= to; i++) { const it = items[i]!; if (it.kind === 'move') ms.push(it.move); }
  return ms;
}

// Per-frame illumination as a nuisance parameter (design 3.4). A frame's
// readings share one white balance and one colour cast; against a palette
// and an assignment, the frame's chromatic translation is a weighted
// least-squares residual with a prior pulling it to zero. The prior gets
// stronger the fewer distinct colours the frame shows: a frame of one colour
// cannot pin its own gain and would happily "correct" red into orange, so
// it gets no correction at all.

import type { Embedding } from './colorspace';
import { embedQuadObs } from './evidence';
import type { EvidenceLog, Palette } from './types';

export type Gains = Map<number, [number, number]>;

/**
 * `colourOf(track, cell)` is the current decoded colour of that reading's
 * slot, or null when the track is unassigned. Returns one gain per frame
 * that had any assigned reading; frames without one get no entry (= zero).
 */
export function fitFrameGains(
  log: EvidenceLog,
  embedding: Embedding,
  palette: Palette,
  colourOf: (track: number, cell: number) => number | null,
  gainPrior: number,
  gainMax: number,
): Gains {
  const [c0, c1] = embedding.chroma;
  const acc = new Map<number, { s0: number; s1: number; w: number; colours: Set<number> }>();
  for (const q of log.quads) {
    const xs = embedQuadObs(q, embedding, undefined);
    q.readings.forEach((r, i) => {
      if (r.w <= 0) return;
      const c = colourOf(q.track, r.cell);
      if (c === null) return;
      const p = palette.centres[c];
      if (!p) return;
      let a = acc.get(q.frame);
      if (!a) acc.set(q.frame, (a = { s0: 0, s1: 0, w: 0, colours: new Set() }));
      const x = xs[i]!;
      a.s0 += r.w * (x[c0] - p[c0]);
      a.s1 += r.w * (x[c1] - p[c1]);
      a.w += r.w;
      a.colours.add(c);
    });
  }
  const out: Gains = new Map();
  for (const [frame, a] of acc) {
    const d = a.colours.size;
    // DECISION: prior strength 100x for a single-colour frame, 3/(d-1) for the
    // rest - three colours in view pin the gain about as well as the readings
    // themselves, one colour not at all.
    const lambda = gainPrior * (d <= 1 ? 100 : 3 / (d - 1));
    let g0 = a.s0 / (a.w + lambda);
    let g1 = a.s1 / (a.w + lambda);
    const n = Math.hypot(g0, g1);
    if (n > gainMax) { g0 *= gainMax / n; g1 *= gainMax / n; }
    out.set(frame, [g0, g1]);
  }
  return out;
}

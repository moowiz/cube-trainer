// Legal neighbours of a legal cube, for the delta certificate. A runner-up
// cube is never one sticker swap away (a swap breaks two pieces); the
// cheapest legal alternatives are the cube group's elementary moves on the
// STICKER colouring:
//
//   two edges flipped              (66 pairs)
//   two corners twisted +/-        (28 pairs x 2)
//   an edge pair swapped together with a corner pair (parity)   (66 x 28 x 6 orientations)
//   a 3-cycle of edges             (220 triples x 2 directions x 4 flip patterns)
//   a 3-cycle of corners           (56 triples x 2 directions x 9 twist patterns)
//
// Every one of them keeps the state legal (counts, distinct centres, real
// pieces, parity), so their cost deltas are exact and the minimum is an
// exhaustive certificate over this class - unlike a budgeted search that
// reports "no runner-up found" when it merely ran out of pops. The same
// enumeration is a legal hill-climb: a negative delta means the search
// stopped short of the cheapest legal cube.

import { CENTER_INDICES, CORNER_FACELETS, EDGE_FACELETS } from '../state';

type Cost = readonly (readonly number[])[];

/** Cost change of assigning `colours[from[i]]` to slot `to[i]` for all i (slots distinct). */
function moveDelta(cost: Cost, colours: readonly number[], to: readonly number[], from: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < to.length; i++) d += cost[to[i]!]![colours[from[i]!]!]! - cost[to[i]!]![colours[to[i]!]!]!;
  return d;
}

function apply(colours: number[], to: readonly number[], from: readonly number[]): void {
  const vals = from.map((s) => colours[s]!);
  to.forEach((s, i) => { colours[s] = vals[i]!; });
}

/** Cyclic shift of a 3-slot corner by k (its stickers rotate around the piece). */
const rot3 = (p: readonly number[], k: number): number[] => [p[k % 3]!, p[(k + 1) % 3]!, p[(k + 2) % 3]!];

export interface Neighbour { delta: number; to: number[]; from: number[] }

/**
 * Enumerate every elementary legal move; `visit` gets the delta and the
 * move. Centre swaps are the one class not legal by construction (two
 * centres exchanging colours relabels every sticker of those two colours;
 * it is a real cube only sometimes - it was on capture 1789323275149,
 * where red and orange centres were 1.4 apart), so they are offered only
 * when `legal` accepts them.
 */
export function forEachLegalNeighbour(cost: Cost, colours: readonly number[], visit: (n: Neighbour) => void, legal?: (c: readonly number[]) => boolean): void {
  const E = EDGE_FACELETS;
  const C = CORNER_FACELETS;
  const emit = (to: number[], from: number[]) => visit({ delta: moveDelta(cost, colours, to, from), to, from });

  if (legal) {
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const to = [CENTER_INDICES[a]!, CENTER_INDICES[b]!];
      const from = [CENTER_INDICES[b]!, CENTER_INDICES[a]!];
      const c = colours.slice();
      apply(c, to, from);
      if (legal(c)) emit(to, from);
    }
  }

  // two edges flipped
  for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) {
    emit([E[a]![0], E[a]![1], E[b]![0], E[b]![1]], [E[a]![1], E[a]![0], E[b]![1], E[b]![0]]);
  }
  // two corners twisted in opposite directions
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    emit([...C[a]!, ...C[b]!], [...rot3(C[a]!, 1), ...rot3(C[b]!, 2)]);
    emit([...C[a]!, ...C[b]!], [...rot3(C[a]!, 2), ...rot3(C[b]!, 1)]);
  }
  // an edge pair swapped with a corner pair (each an odd permutation; together even)
  for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) {
    for (const flip of [0, 1]) {
      const ea = flip ? [E[a]![1], E[a]![0]] : [E[a]![0], E[a]![1]];
      const eb = flip ? [E[b]![1], E[b]![0]] : [E[b]![0], E[b]![1]];
      for (let c = 0; c < 8; c++) for (let d = c + 1; d < 8; d++) {
        for (let k = 0; k < 3; k++) {
          emit([E[a]![0], E[a]![1], E[b]![0], E[b]![1], ...C[c]!, ...C[d]!], [...eb, ...ea, ...rot3(C[d]!, k), ...rot3(C[c]!, (3 - k) % 3)]);
        }
      }
    }
  }
  // 3-cycles of edges: A -> B -> C -> A with an even number of flips
  for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) for (let c = b + 1; c < 12; c++) {
    for (const [x, y, z] of [[a, b, c], [a, c, b]]) {
      for (const flips of [[0, 0, 0], [1, 1, 0], [1, 0, 1], [0, 1, 1]]) {
        const src = (i: number, f: number) => (f ? [E[i]![1], E[i]![0]] : [E[i]![0], E[i]![1]]);
        emit([...E[y!]!, ...E[z!]!, ...E[x!]!], [...src(x!, flips[0]!), ...src(y!, flips[1]!), ...src(z!, flips[2]!)]);
      }
    }
  }
  // 3-cycles of corners with twists summing to 0 mod 3
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) for (let c = b + 1; c < 8; c++) {
    for (const [x, y, z] of [[a, b, c], [a, c, b]]) {
      for (let k1 = 0; k1 < 3; k1++) for (let k2 = 0; k2 < 3; k2++) {
        const k3 = (6 - k1 - k2) % 3;
        emit([...C[y!]!, ...C[z!]!, ...C[x!]!], [...rot3(C[x!]!, k1), ...rot3(C[y!]!, k2), ...rot3(C[z!]!, k3)]);
      }
    }
  }
}

/** Cheapest elementary legal neighbour (delta may be negative: a better legal cube exists next door). */
function cheapestNeighbour(cost: Cost, colours: readonly number[], legal?: (c: readonly number[]) => boolean): Neighbour | null {
  let best: Neighbour | null = null;
  forEachLegalNeighbour(cost, colours, (n) => { if (!best || n.delta < best.delta) best = n; }, legal);
  return best;
}

/** Hill-climb over elementary legal moves from a legal state; returns the improved colouring and the runner-up delta. */
export function refineLegal(cost: Cost, start: readonly number[], legal?: (c: readonly number[]) => boolean, maxSteps = 8): { colours: number[]; delta: number; steps: number } {
  const colours = start.slice();
  let steps = 0;
  for (;;) {
    const n = cheapestNeighbour(cost, colours, legal);
    if (!n) return { colours, delta: Infinity, steps };
    if (n.delta >= -1e-9 || steps >= maxSteps) return { colours, delta: Math.max(0, n.delta), steps };
    apply(colours, n.to, n.from);
    steps++;
  }
}

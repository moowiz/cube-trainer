// Exact constrained decoder for the colour pipeline: turns a 54x6 cost
// matrix (per-slot -log softmax of colour evidence) into the cheapest
// LEGAL cube, plus a confidence certificate (delta to the runner-up,
// per-slot margins). Written from the spec in the redesign docs; it is a
// port in spirit of the MIT rubiks-vision project's exactDecode, not a
// transcription (no access to that source).
//
// Everything here is colour-name-agnostic: colours are ids 0..5, and the
// only thing that ties an id to a face letter is which centre slot carries
// it (coloursToFacelets, used only to call the `legal` oracle).

import type { DecodeResult } from './types';
import { FACE_ORDER } from '../types';
import type { FaceId } from '../types';
import { solveAssignment } from '../color';
import { CORNER_COLORS, CORNER_FACELETS, EDGE_COLORS, EDGE_FACELETS } from '../cube/pieces';
import { completeFacelets } from './complete';
import { refineLegal } from './neighbours';

export interface DecodeOptions {
  /** Wall-clock cap on the legality search (ms); the pop budgets still apply. */
  maxMs?: number;
  /** Check the 20 pieces on colour ids before calling `legal` and focus the expansion on broken ones (default true; off when `legal` is trivial). */
  checkPieces?: boolean;
  /** Best-first pops before giving up on legality. */
  maxPops?: number;
  /** Extra pops after the best legal state, looking for the runner-up. */
  secondPops?: number;
  /** Cheapest 2-swaps expanded per popped node. */
  swapsPerNode?: number;
}

const N_SLOTS = 54;
const N_COLOURS = 6;
const CENTER_SLOTS: readonly number[] = [4, 13, 22, 31, 40, 49];

const IS_CENTRE: readonly boolean[] = (() => {
  const a = new Array<boolean>(N_SLOTS).fill(false);
  for (const s of CENTER_SLOTS) a[s] = true;
  return a;
})();

/**
 * letter of each slot: colour c gets the letter of the face whose centre
 * slot carries c. Precondition: the six centre colours are distinct.
 */
export function coloursToFacelets(colours: readonly number[]): string {
  const colourLetter = new Array<FaceId | undefined>(N_COLOURS);
  for (let k = 0; k < CENTER_SLOTS.length; k++) {
    const c = colours[CENTER_SLOTS[k]!]!;
    if (colourLetter[c] !== undefined) {
      throw new Error('coloursToFacelets: centre colours are not distinct');
    }
    colourLetter[c] = FACE_ORDER[k]!;
  }
  let out = '';
  for (let s = 0; s < colours.length; s++) out += colourLetter[colours[s]!]!;
  return out;
}

// ---------- step 1: free per-row argmin ----------

function computeArgmin(cost: readonly (readonly number[])[]): number[] {
  const argmin = new Array<number>(N_SLOTS);
  for (let s = 0; s < N_SLOTS; s++) {
    let best = 0;
    let bestVal = cost[s]![0]!;
    for (let c = 1; c < N_COLOURS; c++) {
      const v = cost[s]![c]!;
      if (v < bestVal) {
        bestVal = v;
        best = c;
      }
    }
    argmin[s] = best;
  }
  return argmin;
}

// ---------- step 2: centres, exactly distinct, brute force over 6! ----------

function bruteForceCentres(cost: readonly (readonly number[])[]): { colours: number[]; cost: number } {
  const perm = [0, 1, 2, 3, 4, 5];
  let bestPerm: number[] | null = null;
  let bestCost = Infinity;

  // Standard swap-based permutation generator (Heap's algorithm variant):
  // all 720 orderings of "colour assigned to CENTER_SLOTS[i]".
  const permute = (k: number): void => {
    if (k === perm.length) {
      let total = 0;
      for (let i = 0; i < CENTER_SLOTS.length; i++) total += cost[CENTER_SLOTS[i]!]![perm[i]!]!;
      if (total < bestCost) {
        bestCost = total;
        bestPerm = perm.slice();
      }
      return;
    }
    for (let i = k; i < perm.length; i++) {
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      permute(k + 1);
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
    }
  };
  permute(0);
  return { colours: bestPerm!, cost: bestCost };
}

// ---------- step 3: the other 48 slots, exactly 8 of each colour ----------

function assignRemaining48(
  cost: readonly (readonly number[])[],
  nonCentreSlots: readonly number[],
): { colours: number[]; cost: number } {
  const n = nonCentreSlots.length; // 48
  const cost48: number[][] = new Array(n);
  for (let r = 0; r < n; r++) {
    const slot = nonCentreSlots[r]!;
    const row = new Array<number>(n);
    for (let c = 0; c < N_COLOURS; c++) {
      const v = cost[slot]![c]!;
      const base = c * 8;
      for (let k = 0; k < 8; k++) row[base + k] = v;
    }
    cost48[r] = row;
  }
  const rowToCol = solveAssignment(cost48);
  const colours = new Array<number>(n);
  let total = 0;
  for (let r = 0; r < n; r++) {
    const colour = Math.floor(rowToCol[r]! / 8);
    colours[r] = colour;
    total += cost[nonCentreSlots[r]!]![colour]!;
  }
  return { colours, cost: total };
}

function buildBalanced(cost: readonly (readonly number[])[]): { colours: number[]; cost: number } {
  const centre = bruteForceCentres(cost);
  const nonCentreSlots: number[] = [];
  for (let s = 0; s < N_SLOTS; s++) if (!IS_CENTRE[s]) nonCentreSlots.push(s);
  const rest = assignRemaining48(cost, nonCentreSlots);

  const colours = new Array<number>(N_SLOTS).fill(-1);
  for (let i = 0; i < CENTER_SLOTS.length; i++) colours[CENTER_SLOTS[i]!] = centre.colours[i]!;
  for (let i = 0; i < nonCentreSlots.length; i++) colours[nonCentreSlots[i]!] = rest.colours[i]!;
  return { colours, cost: centre.cost + rest.cost };
}

// ---------- piece check on colour ids ----------
//
// The search visits thousands of states; building a facelet string and
// running validateState on each cost ~25 us and dominated the search. This
// checks the 20 pieces directly on the colour ids (letters come from the
// six centres) with bitmask lookups and reports the slots of the pieces
// that are impossible or duplicated. Parity is left to validateState,
// which only runs once every piece is a real, unique piece.

const FACE_IDX: Record<string, number> = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const maskOf = (letters: readonly string[]) => letters.reduce((m, l) => m | (1 << FACE_IDX[l]!), 0);
const CORNER_MASKS = new Set(CORNER_COLORS.map(maskOf));
const EDGE_MASKS = new Set(EDGE_COLORS.map(maskOf));
const PIECE_SLOTS: readonly (readonly number[])[] = [...CORNER_FACELETS, ...EDGE_FACELETS];
const PIECE_IS_CORNER = PIECE_SLOTS.map((p) => p.length === 3);
const colourFace = new Int32Array(6);
const seenMask = new Int32Array(64);

/** Slots belonging to impossible or duplicated pieces; empty when every piece is real and unique. */
function badPieceSlots(colours: readonly number[]): number[] {
  for (let fi = 0; fi < 6; fi++) colourFace[colours[CENTER_SLOTS[fi]!]!] = fi;
  seenMask.fill(-1);
  const bad: number[] = [];
  for (let p = 0; p < PIECE_SLOTS.length; p++) {
    const slots = PIECE_SLOTS[p]!;
    let mask = 0;
    let bits = 0;
    for (const s of slots) {
      const b = 1 << colourFace[colours[s]!]!;
      if (mask & b) { bits = -1; break; } // two stickers of one piece the same colour
      mask |= b;
      bits++;
    }
    const real = bits > 0 && (PIECE_IS_CORNER[p] ? CORNER_MASKS.has(mask) : EDGE_MASKS.has(mask));
    if (!real) { bad.push(...slots); continue; }
    // a corner mask has three bits and an edge mask two, so one table serves both
    const prev = seenMask[mask]!;
    if (prev >= 0) bad.push(...PIECE_SLOTS[prev]!, ...slots);
    else seenMask[mask] = p;
  }
  return bad;
}

// ---------- 2-swap search over the balanced optimum ----------

/**
 * A swap between i and j is only allowed if the six centres stay distinct
 * afterwards: centre<->centre is always fine (it's a permutation of the
 * same six colours); centre<->non-centre is fine only if the non-centre's
 * colour isn't already sitting on a *different* centre.
 */
function isAllowedSwap(colours: readonly number[], i: number, j: number): boolean {
  if (colours[i] === colours[j]) return false;
  const ci = IS_CENTRE[i]!;
  const cj = IS_CENTRE[j]!;
  if (ci === cj) return true; // both centres, or neither: unconstrained
  const centreSlot = ci ? i : j;
  const incomingColour = ci ? colours[j]! : colours[i]!;
  for (const c of CENTER_SLOTS) {
    if (c !== centreSlot && colours[c] === incomingColour) return false;
  }
  return true;
}

function swapDelta(cost: readonly (readonly number[])[], colours: readonly number[], i: number, j: number): number {
  return cost[i]![colours[j]!]! + cost[j]![colours[i]!]! - cost[i]![colours[i]!]! - cost[j]![colours[j]!]!;
}

// Scratch buffers reused across collectSwaps calls: 54 choose 2 = 1431
// candidate pairs at most per node, no per-candidate object churn until
// the final (capped at swapsPerNode) selection.
const MAX_PAIRS = (N_SLOTS * (N_SLOTS - 1)) / 2;
const candI = new Int32Array(MAX_PAIRS);
const candJ = new Int32Array(MAX_PAIRS);
const candDelta = new Float64Array(MAX_PAIRS);
const candOrder = new Int32Array(MAX_PAIRS);

interface Swap {
  i: number;
  j: number;
  delta: number;
}

function collectSwaps(cost: readonly (readonly number[])[], colours: readonly number[], swapsPerNode: number, focus: ReadonlySet<number> | null): Swap[] {
  let n = 0;
  for (let i = 0; i < N_SLOTS; i++) {
    const ci = colours[i]!;
    const costIci = cost[i]![ci]!;
    const iFocus = focus === null || focus.has(i);
    for (let j = i + 1; j < N_SLOTS; j++) {
      const cj = colours[j]!;
      if (cj === ci) continue;
      // from an illegal state only a swap that touches a broken piece can
      // make progress; the rest keep it broken and only cost more
      if (!iFocus && !focus!.has(j)) continue;
      if (!isAllowedSwap(colours, i, j)) continue;
      candI[n] = i;
      candJ[n] = j;
      candDelta[n] = cost[i]![cj]! + cost[j]![ci]! - costIci - cost[j]![cj]!;
      candOrder[n] = n;
      n++;
    }
  }
  const order = candOrder.subarray(0, n);
  // the heap orders the children; the sort only matters when there are
  // more candidates than the cap and the cheapest must be kept
  if (n > swapsPerNode) order.sort((a, b) => candDelta[a]! - candDelta[b]!);
  const take = Math.min(swapsPerNode, n);
  const out = new Array<Swap>(take);
  for (let k = 0; k < take; k++) {
    const idx = order[k]!;
    out[k] = { i: candI[idx]!, j: candJ[idx]!, delta: candDelta[idx]! };
  }
  return out;
}

interface HeapNode {
  cost: number;
  colours: number[];
}

/** Real binary min-heap keyed on `cost` — the frontier can hold tens of thousands of entries. */
class MinHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.cost <= items[i]!.cost) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): HeapNode | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && items[l]!.cost < items[smallest]!.cost) smallest = l;
        if (r < n && items[r]!.cost < items[smallest]!.cost) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

function keyOf(colours: readonly number[]): string {
  // Colours are single digits 0..5, so plain concatenation is a safe, cheap key.
  return colours.join('');
}

interface PopResult {
  found: HeapNode | null;
  pops: number;
}

/**
 * Pop from `heap` (shared across phases, together with `seen`) up to `budget`
 * times, expanding each freshly-seen node's 2-swap children, until a node
 * that is both legal and satisfies `isTarget` is popped, or the budget runs
 * out. Every heap.pop() call counts against the budget, including pops of
 * already-seen states.
 */
function popUntil(
  heap: MinHeap,
  seen: Set<string>,
  cost: readonly (readonly number[])[],
  legal: (colours: readonly number[]) => boolean,
  budget: number,
  swapsPerNode: number,
  isTarget: (colours: readonly number[]) => boolean,
  deadline = Infinity,
  checkPieces = true,
): PopResult {
  let pops = 0;
  while (pops < budget) {
    if ((pops & 63) === 0 && performance.now() > deadline) break;
    const node = heap.pop();
    if (!node) break;
    pops++;
    const key = keyOf(node.colours);
    if (seen.has(key)) continue;
    seen.add(key);
    const bad = checkPieces ? badPieceSlots(node.colours) : [];
    if (bad.length === 0 && legal(node.colours) && isTarget(node.colours)) {
      return { found: node, pops };
    }
    // a piece failure focuses the expansion on its slots; a parity failure
    // (all pieces real) can be fixed by swaps anywhere
    const swaps = collectSwaps(cost, node.colours, swapsPerNode, bad.length ? new Set(bad) : null);
    for (const sw of swaps) {
      const child = node.colours.slice();
      const tmp = child[sw.i]!;
      child[sw.i] = child[sw.j]!;
      child[sw.j] = tmp;
      // DECISION: skip pushing a child whose key is already seen, rather
      // than pushing it and discarding it at pop time. Cuts heap growth a
      // lot in the common case without changing which state is found first.
      if (seen.has(keyOf(child))) continue;
      heap.push({ cost: node.cost + sw.delta, colours: child });
    }
  }
  return { found: null, pops };
}

function countChanged(colours: readonly number[], argmin: readonly number[], skip: ReadonlySet<number> = new Set()): number {
  let n = 0;
  for (let s = 0; s < colours.length; s++) if (!skip.has(s) && colours[s] !== argmin[s]) n++;
  return n;
}

function computeMargins(cost: readonly (readonly number[])[], colours: readonly number[]): number[] {
  const margins = new Array<number>(N_SLOTS).fill(Infinity);
  for (let s = 0; s < N_SLOTS; s++) {
    let min = Infinity;
    for (let j = 0; j < N_SLOTS; j++) {
      if (j === s || colours[j] === colours[s]) continue;
      if (!isAllowedSwap(colours, s, j)) continue;
      const delta = swapDelta(cost, colours, s, j);
      if (delta < min) min = delta;
    }
    margins[s] = min;
  }
  return margins;
}

/** Slots whose cost row is all zero: no evidence, free for the constraints to decide. */
function freeSlots(cost: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (let s = 0; s < N_SLOTS; s++) if (cost[s]!.every((c) => c === 0)) out.push(s);
  return out;
}

// DECISION: a sticker the pieces force carries this margin - the cost of
// any 2-swap that keeps the cube legal is at least one evidenced sticker's
// cost, and 30 is the cost cap of the matrix.
const FORCED_MARGIN = 30;

export function decode(
  cost: readonly (readonly number[])[],
  legal: (colours: readonly number[]) => boolean,
  opts: DecodeOptions = {},
): DecodeResult {
  const maxPops = opts.maxPops ?? 30000;
  const secondPops = opts.secondPops ?? 12000;
  const swapsPerNode = opts.swapsPerNode ?? 120;
  const t0 = performance.now();
  const maxMs = opts.maxMs ?? Infinity;
  const checkPieces = opts.checkPieces ?? true;

  const argmin = computeArgmin(cost);
  const balanced = buildBalanced(cost);

  // Unseen stickers: the balanced step gave them the colours the counts
  // demand, in an arbitrary arrangement. The pieces decide the arrangement;
  // when they force it the completion is the answer for those slots and
  // each carries FORCED_MARGIN, when they do not the slots are ambiguous
  // (margin 0) and no lock can pass.
  const free = freeSlots(cost);
  const freeSet = new Set(free); // a free slot has no nearest colour to move from
  let completion: DecodeResult['completion'] = free.length ? 'none' : 'n/a';
  const forced = new Set<number>();
  if (free.length) {
    const letters = coloursToFacelets(balanced.colours).split('');
    const letterOf = new Map<number, string>();
    CENTER_SLOTS.forEach((slot, fi) => letterOf.set(balanced.colours[slot]!, 'URFDLB'[fi]!));
    for (const s of free) if (!CENTER_SLOTS.includes(s)) letters[s] = '?';
    const c = completeFacelets(letters.join(''));
    if (c.facelets) {
      completion = 'unique';
      const colourOf = new Map([...letterOf].map(([col, l]) => [l, col]));
      for (const s of free) { balanced.colours[s] = colourOf.get(c.facelets[s]!)!; forced.add(s); }
    } else if (c.solutions >= 2 || c.overflow) {
      completion = 'ambiguous';
    }
  }
  const withFree = (margins: number[]): number[] => {
    for (const s of free) margins[s] = forced.has(s) ? FORCED_MARGIN : 0;
    return margins;
  };

  const heap = new MinHeap();
  heap.push({ cost: balanced.cost, colours: balanced.colours });
  const seen = new Set<string>();

  let best: HeapNode | null;
  let popsA: number;
  if (legal(balanced.colours)) {
    // Fast path: the balanced optimum is already legal, no swap search
    // needed to find it. Its own node is still on the heap (unpopped, not
    // marked seen), so the delta search below naturally starts by popping
    // it and expanding its children.
    best = { cost: balanced.cost, colours: balanced.colours };
    popsA = 0;
  } else {
    const resultA = popUntil(heap, seen, cost, legal, maxPops, swapsPerNode, () => true, t0 + maxMs, checkPieces);
    best = resultA.found;
    popsA = resultA.pops;
  }

  if (!best) {
    return {
      colours: null,
      argmin,
      cost: balanced.cost,
      changed: countChanged(balanced.colours, argmin, freeSet),
      delta: Infinity,
      margins: withFree(computeMargins(cost, balanced.colours)),
      legal: false,
      pops: popsA,
      free: free.length,
      completion,
    };
  }

  // The runner-up: the cheapest elementary legal move away from the best
  // (neighbours.ts) - exhaustive over the moves that matter, exact, and a
  // few ms, where the old budgeted search reported "no runner-up found"
  // when it had merely run out of pops (a lock on a 7-changed answer with
  // delta = Infinity, webcam capture 1789338323368). The same enumeration
  // climbs if the best-first search stopped short of the cheapest legal cube.
  // An ambiguous completion IS a runner-up at equal cost (the unseen slots
  // rearranged), whatever the neighbours say.
  const climbed = checkPieces ? refineLegal(cost, best.colours, legal) : { colours: best.colours.slice(), delta: Infinity, steps: 0 };
  const finalColours = climbed.colours;
  const finalCost = best.cost + (checkPieces ? finalColours.reduce((s, c, i) => s + cost[i]![c]! - cost[i]![best!.colours[i]!]!, 0) : 0);
  const delta = completion === 'ambiguous' ? 0 : climbed.delta;
  void secondPops;

  return {
    colours: finalColours,
    argmin,
    cost: finalCost,
    changed: countChanged(finalColours, argmin, freeSet),
    delta,
    margins: withFree(computeMargins(cost, finalColours)),
    legal: true,
    pops: popsA,
    free: free.length,
    completion,
  };
}

// 54-sticker vote model: face stabilization, cluster assembly into a facelet
// string, from-scratch cube-piece validation, and cubejs-backed solving.
//
// cubejs is NOT trustworthy for validation (see validateState below) so the
// cubie-level checks here are implemented from the facelet string directly,
// cross-checked in tests against real cubejs states.

/// <reference path="./cubejs.d.ts" />
import Cube from 'cubejs';
import {
  assignBalanced,
  labDistance,
  labMean,
  labMedian,
  kmeans,
  nearestCentroid,
} from './color';
import { FACE_ORDER } from './types';
import type { FaceId, Lab } from './types';

// ---------- FaceStabilizer ----------

/** One captured face: 9 cells row-major as scanned; index 4 is the center. */
export interface FaceCapture {
  face: FaceId;
  cells: Lab[];
}

/** Detects when the 9 sampled cells of a face have been stable long enough. */
export class FaceStabilizer {
  private readonly stableFrames: number;
  private readonly minStableMs: number;
  private readonly maxCellDrift: number;
  private buffer: Lab[][] = [];
  private counter = 0;
  private windowStart = 0;

  constructor(opts?: { stableFrames?: number; minStableMs?: number; maxCellDrift?: number }) {
    // DECISION: a face is "stable" only when BOTH hold: >= 8 consecutive
    // consistent frames AND >= 700ms of wall-clock stability. The frame gate
    // alone is far too quick on a 60fps phone (8 frames ≈ 0.13s — a face
    // would lock before the user has even settled); the time gate alone would
    // let a 15fps low-end phone lock off just 2-3 noisy frames. 6.0
    // Lab-distance is the per-cell drift budget between frames — loose enough
    // to absorb sensor noise/small camera shake, tight enough to reject a
    // face that's still sliding into place.
    this.stableFrames = opts?.stableFrames ?? 8;
    this.minStableMs = opts?.minStableMs ?? 700;
    this.maxCellDrift = opts?.maxCellDrift ?? 6.0;
  }

  /**
   * Call once per frame with the 9 Lab samples.
   * `moved` is true when this frame broke a run of consistent frames — the
   * scanner uses it to require real scene motion between two face captures.
   */
  push(cells: readonly Lab[], now: number = Date.now()): { stable: boolean; progress: number; moved: boolean } {
    const frame = cells.map((c) => ({ ...c }));
    const prev = this.buffer[this.buffer.length - 1];
    let moved = false;
    if (prev === undefined) {
      this.counter = 0;
      this.windowStart = now;
    } else {
      let consistent = frame.length === prev.length;
      for (let i = 0; consistent && i < frame.length; i++) {
        if (labDistance(frame[i]!, prev[i]!) >= this.maxCellDrift) consistent = false;
      }
      if (consistent) {
        this.counter++;
      } else {
        moved = true;
        this.counter = 0;
        this.windowStart = now;
      }
    }
    this.buffer.push(frame);
    if (this.buffer.length > this.stableFrames) this.buffer.shift();

    const elapsed = now - this.windowStart;
    const stable = this.counter >= this.stableFrames && elapsed >= this.minStableMs;
    const progress = Math.min(
      1,
      Math.min(
        this.counter / this.stableFrames,
        this.minStableMs === 0 ? 1 : elapsed / this.minStableMs,
      ),
    );
    return { stable, progress, moved };
  }

  /** Per-cell median over the stable window. Throws if never pushed. */
  result(): Lab[] {
    if (this.buffer.length === 0) throw new Error('FaceStabilizer.result: no frames pushed yet');
    const n = this.buffer[0]!.length;
    const out: Lab[] = [];
    for (let i = 0; i < n; i++) {
      out.push(labMedian(this.buffer.map((f) => f[i]!)));
    }
    return out;
  }

  reset(): void {
    this.buffer = [];
    this.counter = 0;
  }
}

// ---------- assembleState ----------

// DECISION: cluster in an exposure-normalized space — subtract each face's
// median L (cancels the camera's auto-exposure drift between captures) and
// weight the residual L by 0.15 (color identity lives mostly in a/b; after
// per-face centering, L residual depends on what else shares the face — it is
// more noise dimension than signal, and keeping it heavy lets k-means split
// clusters along it or drown a small a/b separation). On the backlit-kitchen
// frame fixtures normalization fixes a red→orange miss that plain Lab makes,
// and accuracy holds at 44/45 for any L weight from 1 down to 0.15 (see
// test/lowlight.test.ts); well-lit colors stay separated because they differ
// strongly in a/b anyway.
export const CLUSTER_L_WEIGHT = 0.15;

/**
 * Lightness weight for naming a face against fixed exemplars.
 *
 * MEASURED: CLUSTER_L_WEIGHT is right for its own job — clustering all 54
 * stickers RELATIVE to each other, where crushing L cancels auto-exposure
 * drift between captures and lets chroma do the separating. Reusing it to
 * match against an absolute exemplar throws away the one dimension that
 * separates white from a dark color: white sits at a*~0 b*~0, so any weakly
 * chromatic sample lands nearest it. On a phone capture a blue center at
 * L* 18 a* +2 b* -28 (face median L 18) ranked white 29.4 / blue 41.8 at
 * weight 0.15, and white 43.3 / blue 45.7 at weight 1.0 — the crush, not the
 * color, is what named it white. Naming keeps the median-L subtraction (still
 * exposure-invariant) but pays full price for lightness.
 */
export const NAME_L_WEIGHT = 1.0;

/**
 * Map one face's 9 cells into a normalized space: subtract the face's own
 * median lightness (this is what cancels exposure drift) and scale what is
 * left. Default weight is the clustering one assembleState uses; naming
 * passes NAME_L_WEIGHT.
 */
export function normalizeFaceCells(cells: readonly Lab[], lWeight = CLUSTER_L_WEIGHT): Lab[] {
  const medL = labMedian(cells).L;
  return cells.map((c) => ({ L: (c.L - medL) * lWeight, a: c.a, b: c.b }));
}

/**
 * Chroma above this is compressed by CHROMA_SLOPE before stickers are
 * classified. MEASURED 2026-09-13 on the phone sessions: a sticker's chroma
 * swings with illumination far more than its hue - the same blue read
 * (16, -61) lit and (6, -28) in shadow, and in plain ab the shadowed one
 * sat nearer white (27) than blue (34); a pale yellow (-10, 40) was a coin
 * flip between yellow and white. Halving chromatic differences beyond the
 * knee keeps neutrals linear (white vs a dim blue still separates by
 * chroma) while a colour seen dim stays with its hue.
 */
export const CHROMA_KNEE = 20;
export const CHROMA_SLOPE = 0.5;

/** The classification space: normalized Lab with chroma compressed past the knee. */
export function compressChroma(c: Lab): Lab {
  const ch = Math.hypot(c.a, c.b);
  if (ch <= CHROMA_KNEE) return c;
  const s = (CHROMA_KNEE + (ch - CHROMA_KNEE) * CHROMA_SLOPE) / ch;
  return { L: c.L, a: c.a * s, b: c.b * s };
}

// DECISION: two capture centers closer than this in the normalized space are
// treated as the same physical face scanned twice (the scanner's duplicate
// guard uses the same constant). Calibrated on fixtures: genuinely duplicated
// or unusable center pairs sit at ~6 (cube-scan-1789101879130), while the
// hardest legitimate pair seen — white under a blue monitor cast vs a real
// blue center (cube-scan-1789102942492) — sits at 12.8 and must assemble.
export const CENTER_MIN_DIST = 10;

export interface AssembledState {
  facelets: string; // 54 chars, faces in U R F D L B order, cubejs facelet convention
  stickerFaces: FaceId[]; // length 54, classification of each sticker
  confidences: number[]; // length 54, in [0,1]: 1 - dist/secondDist to cluster centroids, clamped
  centroids: Record<FaceId, Lab>; // measured color of each face's cluster
  /** length 54: each sticker's runner-up colour (the second-nearest cluster), for piece resolution */
  secondFaces: FaceId[];
  /** facelet indices whose colour was flipped to its runner-up by resolveByPieces */
  flipped?: number[];
  /** quarter turns applied per face (U R F D L B order) by resolveByRotation */
  turned?: number[];
  /** the nine-per-colour constraint had to be enforced to reach a valid state */
  balanced?: boolean;
}

/** Row-major 3x3 cell index after k quarter turns: rotated[i] = cells[ROT3[k][i]]. */
export const ROT3: readonly (readonly number[])[] = (() => {
  const once = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // 90 deg: new (r, c) = old (2 - c, r)
  const out: number[][] = [[0, 1, 2, 3, 4, 5, 6, 7, 8]];
  for (let k = 1; k < 4; k++) out.push(out[k - 1]!.map((_, i) => out[k - 1]![once[i]!]!));
  return out;
})();

export function rotateCells<T>(cells: readonly T[], k: number): T[] {
  return ROT3[k & 3]!.map((j) => cells[j]!);
}

/**
 * The in-plane rotation of each face is the least certain part of a scan
 * (it comes from shared-edge geometry, not from colour), and a face turned
 * a quarter keeps its nine colours but breaks every corner and edge piece
 * it touches. When a state has the right colour counts but invalid pieces,
 * search the 4^6 per-face rotations: the piece constraints are so tight
 * that at most one assignment is valid in practice (the screenshot session
 * of 2026-09-13: L turned 1, B turned 2, unique among 4096). Returns the
 * state with the fewest faces turned if exactly one valid assignment has
 * that count, else the input unchanged.
 */
export function resolveByRotation(state: AssembledState): AssembledState {
  if (validateState(state.facelets).ok) return state;
  const counts = new Map<string, number>();
  for (const f of state.stickerFaces) counts.set(f, (counts.get(f) ?? 0) + 1);
  if (FACE_ORDER.some((f) => counts.get(f) !== 9)) return state; // rotation cannot fix a colour count
  let best: { turns: number[]; changed: number } | null = null;
  let tie = false;
  const faces = FACE_ORDER.map((_, fi) => state.stickerFaces.slice(fi * 9, fi * 9 + 9));
  for (let code = 1; code < 4096; code++) {
    const turns = FACE_ORDER.map((_, i) => (code >> (2 * i)) & 3);
    const changed = turns.filter((t) => t !== 0).length;
    if (best && changed > best.changed) continue;
    const facelets = faces.map((cells, i) => rotateCells(cells, turns[i]!).join('')).join('');
    if (!validateState(facelets).ok) continue;
    if (best && changed === best.changed) { tie = true; continue; }
    best = { turns, changed };
    tie = false;
  }
  if (!best || tie) return state;
  const turn = <T>(arr: readonly T[]): T[] => faces.flatMap((_, i) => rotateCells(arr.slice(i * 9, i * 9 + 9), best!.turns[i]!));
  const stickerFaces = turn(state.stickerFaces);
  return {
    ...state,
    stickerFaces,
    facelets: stickerFaces.join(''),
    confidences: turn(state.confidences),
    secondFaces: turn(state.secondFaces),
    flipped: state.flipped,
    turned: best.turns,
  };
}

/**
 * captures: exactly 6, one per face, any order but must cover all of FACE_ORDER.
 * K-means (k=6) over all 54 Lab samples, SEEDED from the six center cells
 * (index 4 of each capture) — seeding from centers is what keeps red/orange apart.
 * Cluster -> FaceId mapping: the final label of each capture's center cell.
 * If two centers end in the same cluster, throw an Error with a human-friendly
 * message. Center facelet positions (index 4 of each face) are forced to their
 * face id.
 */
export function assembleState(captures: readonly FaceCapture[], opts: { balanced?: boolean } = {}): AssembledState {
  if (captures.length !== 6) {
    throw new Error(`assembleState: expected 6 face captures, got ${captures.length}.`);
  }
  const byFace = new Map<FaceId, FaceCapture>();
  for (const cap of captures) {
    if (cap.cells.length !== 9) {
      throw new Error(`assembleState: face ${cap.face} has ${cap.cells.length} cells, expected 9.`);
    }
    if (byFace.has(cap.face)) {
      throw new Error(`assembleState: duplicate capture for face ${cap.face}.`);
    }
    byFace.set(cap.face, cap);
  }
  for (const face of FACE_ORDER) {
    if (!byFace.has(face)) {
      throw new Error(`assembleState: missing capture for face ${face}.`);
    }
  }

  // Samples in canonical facelet order: U R F D L B, 9 cells each — this is
  // exactly the facelet-string index order, so sample index === facelet index.
  const samples: Lab[] = [];
  const centerIndex = {} as Record<FaceId, number>;
  for (let f = 0; f < FACE_ORDER.length; f++) {
    const face = FACE_ORDER[f]!;
    const cells = byFace.get(face)!.cells;
    const base = f * 9;
    centerIndex[face] = base + 4;
    for (let c = 0; c < 9; c++) samples.push(cells[c]!);
  }

  const plain: Lab[] = [];
  for (let f = 0; f < FACE_ORDER.length; f++) {
    plain.push(...normalizeFaceCells(samples.slice(f * 9, f * 9 + 9)));
  }
  // classification happens with chroma compressed; the centre-distinctness
  // check below keeps the plain space its threshold was calibrated in
  const normalized = plain.map(compressChroma);

  // Indistinguishable centers mean the same face was scanned twice (or a
  // capture is unusable) — no clustering can recover from that.
  for (let i = 0; i < FACE_ORDER.length; i++) {
    for (let j = i + 1; j < FACE_ORDER.length; j++) {
      const a = FACE_ORDER[i]!;
      const b = FACE_ORDER[j]!;
      if (labDistance(plain[centerIndex[a]]!, plain[centerIndex[b]]!) < CENTER_MIN_DIST) {
        throw new Error(`Couldn't tell the ${a} and ${b} centers apart — rescan in better light.`);
      }
    }
  }

  // Anchored k-means: each center cell stays pinned to its own cluster, so a
  // strong color cast can degrade per-sticker confidence but can never
  // collapse two faces into one.
  const anchors = FACE_ORDER.map((face) => centerIndex[face]);
  const seeds = anchors.map((i) => normalized[i]!);
  // `labels` comes straight from kmeans because it honours `anchors`: a center
  // cell stays pinned to its own cluster. Recomputing labels by nearest
  // centroid afterwards looks equivalent and is not - it lets a center be
  // relabelled, which costs a sticker on the monitor-cast fixture.
  const km = kmeans(normalized, 6, seeds, 32, anchors);
  const centroids = km.centroids;
  let labels = km.labels;
  // Nine of each colour, enforced on request when the free assignment
  // breaks it. MEASURED 2026-09-13: on the phone sessions the one to five
  // wrong stickers were exactly the surplus ("U appears 10") and the
  // cheapest rebalancing by squared distance was the right sticker; on two
  // older single-frame fixtures it moves the wrong ones (52 -> 50 of 54).
  // So assembleResolved tries it second and keeps it only if the result is
  // a real cube.
  if (opts.balanced) {
    const counts = new Array<number>(6).fill(0);
    for (const l of labels) counts[l]!++;
    if (counts.some((n) => n !== 9)) {
      const pinned = new Map<number, number>();
      anchors.forEach((i, cluster) => pinned.set(i, cluster));
      labels = assignBalanced(normalized, centroids, 9, pinned);
    }
  }

  // Everything from here to the very end works in CLUSTER indices - "the six
  // colors this cube shows" - never in face letters. A cluster is not a face:
  // it becomes one only in the mapping below, and only because each capture
  // told us which face its center belonged to. Keeping the two apart is what
  // lets a cube with a non-standard color scheme assemble at all.
  // MEASURED 2026-09-13, and the reason the nine-per-color constraint is NOT
  // applied here: `assignBalanced` (color.ts) solves exactly the assignment
  // color-notes.md item 3 proposes, and on the fixtures it is a wash - the
  // monitor-cast scan goes 43 -> 44 of 54, but the matte-cube scan goes
  // 52 -> 50, swapping two near-tie pairs (R<->L, F<->U). Squared cost, which
  // makes the solver pay quadratically to move a confident sticker, gives
  // byte-identical results.
  //
  // WHY it cannot help, measured on the same fixtures: rank the true color of
  // each WRONG sticker among the six centroids by distance. On the
  // monitor-cast scan only 5 of 11 have their true color even in second
  // place - 2 are third, 2 are fourth, and 2 are DEAD LAST of six. An
  // assignment rule can only shuffle stickers between colors; it can never
  // pick a color that the distance metric ranks sixth, because the cost of
  // that move is enormous. More than half these errors are unreachable by
  // any decision rule, balanced or not.
  //
  // And the centroids themselves are fine: their minimum pairwise separation
  // is 22.8 (median 78.5), so the clusters have NOT collapsed into each
  // other. It is individual SAMPLES that land in the wrong region - glare,
  // shading and the cast fall unevenly across one face's nine stickers. So
  // the fix has to change the representation, not the decision rule:
  // color-notes item 2 (classify against same-frame center exemplars, which
  // share that sticker's illuminant) and item 4 (project onto the axis
  // between the two rival centers). Revisit this constraint after those,
  // when the remaining errors are near-ties it can actually arbitrate. The
  // solver stays tested in color.ts.

  const nearest = normalized.map((s) => nearestCentroid(s, centroids));
  const confidences: number[] = nearest.map(({ dist, secondDist }) => {
    if (secondDist <= 0) return dist === 0 ? 1 : 0;
    return Math.min(1, Math.max(0, 1 - dist / secondDist));
  });

  // THE BINDING, and the only place it happens: cluster -> face letter. Each
  // capture's center defines its cluster, so the letter a sticker ends up with
  // is "the letter of the face whose center is this color", never "the letter
  // white is supposed to have". cubejs needs U R F D L B and gets it here.
  const clusterToFace = new Map<number, FaceId>();
  FACE_ORDER.forEach((face, cluster) => clusterToFace.set(cluster, face));
  const stickerFaces: FaceId[] = labels.map((l) => clusterToFace.get(l)!);

  // Report centroids in the original (un-normalized) Lab space — they are the
  // measured face colors, meant for display and debugging.
  const centroidsByFace = {} as Record<FaceId, Lab>;
  for (const [label, face] of clusterToFace) {
    const members = samples.filter((_, i) => labels[i] === label);
    centroidsByFace[face] = labMean(members);
  }

  return {
    facelets: stickerFaces.join(''),
    stickerFaces,
    confidences,
    centroids: centroidsByFace,
    secondFaces: nearest.map((n) => clusterToFace.get(n.secondIndex >= 0 ? n.secondIndex : n.index)!),
  };
}

/** A sticker below this confidence may be flipped to its runner-up colour by resolveByPieces. */
export const PIECE_AMBIGUOUS_CONF = 0.35;
const PIECE_MAX_FLIPS = 10;

/**
 * Piece-uniqueness resolution (2026-09-13). Every corner of a cube is a
 * unique colour triple and every edge a unique pair, and validateState
 * knows the full set. Rather than failing an assembly that reads (white,
 * red, green) twice, try flipping the least confident stickers to their
 * runner-up colour - red/orange and white/yellow near-ties are exactly the
 * ones that produce impossible pieces - and keep the cheapest combination
 * that validates. Centres are never flipped. Returns the input untouched
 * when it already validates or when no combination does.
 */
export function resolveByPieces(state: AssembledState, maxFlips = PIECE_MAX_FLIPS): AssembledState {
  if (validateState(state.facelets).ok) return state;
  const candidates = state.confidences
    .map((c, i) => ({ i, c }))
    .filter(({ i, c }) => !CENTER_INDICES.includes(i) && c < PIECE_AMBIGUOUS_CONF && state.secondFaces[i] !== state.stickerFaces[i])
    .sort((a, b) => a.c - b.c)
    .slice(0, maxFlips);
  if (!candidates.length) return state;
  const base = state.stickerFaces.slice();
  let best: { faces: FaceId[]; flipped: number[]; cost: number } | null = null;
  const n = candidates.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const faces = base.slice();
    const flipped: number[] = [];
    let cost = 0;
    for (let k = 0; k < n; k++) {
      if (!(mask & (1 << k))) continue;
      const { i, c } = candidates[k]!;
      faces[i] = state.secondFaces[i]!;
      flipped.push(i);
      cost += 1 + c; // prefer fewer flips, then the least confident ones
    }
    if (best && cost >= best.cost) continue;
    // cheap filter before the full check: nine of each colour
    const counts: Record<string, number> = {};
    for (const f of faces) counts[f] = (counts[f] ?? 0) + 1;
    if (FACE_ORDER.some((f) => counts[f] !== 9)) continue;
    if (validateState(faces.join('')).ok) best = { faces, flipped, cost };
  }
  if (!best) return state;
  return { ...state, facelets: best.faces.join(''), stickerFaces: best.faces, flipped: best.flipped };
}

// ---------- validateState ----------
//
// Verified against the installed cubejs (1.3.2) source (lib/cube.js):
// facelet index = faceOffset + (positionOnFace - 1), with faceOffset
// U=0 R=9 F=18 D=27 L=36 B=45, and center facelets at [4,13,22,31,40,49].
// Corner/edge facelet tables below are transcribed straight from cubejs's
// own cornerFacelet/edgeFacelet tables (see cube.js), not re-derived, so
// orientation/permutation math here agrees with what Cube.fromString does —
// except we additionally *validate* (cubejs's fromString silently accepts
// garbage; see module docs above).

export interface ValidationResult {
  ok: boolean;
  error?: string;
  badStickers?: number[];
}

const CENTER_INDICES: readonly number[] = [4, 13, 22, 31, 40, 49];

// Each triple starts with the slot's U/D facelet, listed clockwise.
const CORNER_FACELETS: readonly (readonly [number, number, number])[] = [
  [8, 9, 20], // URF
  [6, 18, 38], // UFL
  [0, 36, 47], // ULB
  [2, 45, 11], // UBR
  [29, 26, 15], // DFR
  [27, 44, 24], // DLF
  [33, 53, 42], // DBL
  [35, 17, 51], // DRB
];

const CORNER_COLORS: readonly (readonly [string, string, string])[] = [
  ['U', 'R', 'F'], // URF
  ['U', 'F', 'L'], // UFL
  ['U', 'L', 'B'], // ULB
  ['U', 'B', 'R'], // UBR
  ['D', 'F', 'R'], // DFR
  ['D', 'L', 'F'], // DLF
  ['D', 'B', 'L'], // DBL
  ['D', 'R', 'B'], // DRB
];

// Each pair is [primary, secondary]: primary = U/D facelet for U/D edges,
// F/B facelet for equator edges (FR, FL, BL, BR).
const EDGE_FACELETS: readonly (readonly [number, number])[] = [
  [5, 10], // UR
  [7, 19], // UF
  [3, 37], // UL
  [1, 46], // UB
  [32, 16], // DR
  [28, 25], // DF
  [30, 43], // DL
  [34, 52], // DB
  [23, 12], // FR
  [21, 41], // FL
  [50, 39], // BL
  [48, 14], // BR
];

const EDGE_COLORS: readonly (readonly [string, string])[] = [
  ['U', 'R'],
  ['U', 'F'],
  ['U', 'L'],
  ['U', 'B'],
  ['D', 'R'],
  ['D', 'F'],
  ['D', 'L'],
  ['D', 'B'],
  ['F', 'R'],
  ['F', 'L'],
  ['B', 'L'],
  ['B', 'R'],
];

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== new Set(a).size) return false; // a has a repeated letter -> can't equal a real piece's set
  const bs = new Set(b);
  if (bs.size !== a.length) return false;
  return a.every((c) => bs.has(c));
}

/** Parity (0 even, 1 odd) of a permutation given as slot -> piece-index. */
function permParity(perm: readonly number[]): number {
  const seen = new Array<boolean>(perm.length).fill(false);
  let parity = 0;
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    let j = i;
    while (!seen[j]) {
      seen[j] = true;
      j = perm[j]!;
      len++;
    }
    if (len > 0) parity += len - 1;
  }
  return parity % 2;
}

const PIECE_MISMATCH_ERROR = "These stickers don't form a real cube piece — tap to fix them.";

/** Full solvability check. NEVER uses cubejs solve() for this (see module docs). */
export function validateState(facelets: string): ValidationResult {
  if (facelets.length !== 54) {
    return { ok: false, error: `Expected 54 stickers, got ${facelets.length}.` };
  }
  if (!/^[URFDLB]{54}$/.test(facelets)) {
    return { ok: false, error: 'Invalid sticker colors found — expected only U, R, F, D, L, B.' };
  }
  for (const face of FACE_ORDER) {
    let count = 0;
    for (let i = 0; i < 54; i++) if (facelets[i] === face) count++;
    if (count !== 9) {
      return { ok: false, error: `Face color ${face} appears ${count} times — should be exactly 9.` };
    }
  }
  const centerColors = CENTER_INDICES.map((i) => facelets[i]!);
  if (new Set(centerColors).size !== 6) {
    return { ok: false, error: 'The six center stickers must all be different colors — rescan in better light.' };
  }

  // Corners.
  const cp = new Array<number>(8).fill(-1);
  const co = new Array<number>(8).fill(0);
  const cornerSlotOf = new Array<number>(8).fill(-1); // piece -> slot
  for (let slot = 0; slot < 8; slot++) {
    const idxs = CORNER_FACELETS[slot]!;
    const letters = idxs.map((idx) => facelets[idx]!);
    let piece = -1;
    for (let j = 0; j < 8; j++) {
      if (setEquals(letters, CORNER_COLORS[j]!)) {
        piece = j;
        break;
      }
    }
    if (piece === -1) {
      return { ok: false, error: PIECE_MISMATCH_ERROR, badStickers: [...idxs] };
    }
    if (cornerSlotOf[piece] !== -1) {
      return {
        ok: false,
        error: PIECE_MISMATCH_ERROR,
        badStickers: [...CORNER_FACELETS[cornerSlotOf[piece]]!, ...idxs],
      };
    }
    cornerSlotOf[piece] = slot;
    cp[slot] = piece;
    let ori = -1;
    for (let n = 0; n < 3; n++) {
      if (letters[n] === 'U' || letters[n] === 'D') {
        ori = n;
        break;
      }
    }
    co[slot] = ori;
  }

  // Edges.
  const ep = new Array<number>(12).fill(-1);
  const eo = new Array<number>(12).fill(0);
  const edgeSlotOf = new Array<number>(12).fill(-1); // piece -> slot
  for (let slot = 0; slot < 12; slot++) {
    const idxs = EDGE_FACELETS[slot]!;
    const letters = idxs.map((idx) => facelets[idx]!);
    let piece = -1;
    for (let j = 0; j < 12; j++) {
      if (setEquals(letters, EDGE_COLORS[j]!)) {
        piece = j;
        break;
      }
    }
    if (piece === -1) {
      return { ok: false, error: PIECE_MISMATCH_ERROR, badStickers: [...idxs] };
    }
    if (edgeSlotOf[piece] !== -1) {
      return {
        ok: false,
        error: PIECE_MISMATCH_ERROR,
        badStickers: [...EDGE_FACELETS[edgeSlotOf[piece]]!, ...idxs],
      };
    }
    edgeSlotOf[piece] = slot;
    ep[slot] = piece;
    eo[slot] = letters[0] === EDGE_COLORS[piece]![0] ? 0 : 1;
  }

  // Parity.
  const coSum = co.reduce((a, b) => a + b, 0) % 3;
  if (coSum !== 0) {
    return { ok: false, error: 'A corner is twisted — tap to fix it.' };
  }
  const eoSum = eo.reduce((a, b) => a + b, 0) % 2;
  if (eoSum !== 0) {
    return { ok: false, error: 'An edge is flipped — tap to fix it.' };
  }
  if (permParity(cp) !== permParity(ep)) {
    return { ok: false, error: 'Two pieces are swapped — tap to fix them.' };
  }

  return { ok: true };
}

// ---------- solveState / warmSolver / inverseMoves ----------

interface SolveRequest {
  id: number;
  facelets?: string;
  warm?: boolean;
}
interface SolveResponse {
  id: number;
  solution?: string;
  warm?: boolean;
  error?: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (solution: string) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    // Vite worker pattern — this URL must be written literally like this.
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as SolveResponse;
      const p = pending.get(data.id);
      if (!p) return; // e.g. a warm ack with no pending caller
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.solution ?? '');
    };
  }
  return worker;
}

let nodeSolverReady = false;
function ensureNodeSolver(): void {
  if (!nodeSolverReady) {
    Cube.initSolver();
    nodeSolverReady = true;
  }
}

/** Kociemba solution via cubejs. Only call with a validateState-ok state. */
export function solveState(facelets: string): Promise<string> {
  if (typeof Worker !== 'undefined') {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req: SolveRequest = { id, facelets };
      getWorker().postMessage(req);
    });
  }
  // Node / vitest fallback: direct synchronous solve, lazy memoized initSolver.
  ensureNodeSolver();
  try {
    const solution = Cube.fromString(facelets).solve();
    return Promise.resolve(solution);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Pre-warm the solver (kick off initSolver in the worker) — fire and forget. */
export function warmSolver(): void {
  if (typeof Worker !== 'undefined') {
    const id = nextId++;
    const req: SolveRequest = { id, warm: true };
    getWorker().postMessage(req);
  } else {
    ensureNodeSolver();
  }
}

/** Inverse of a move sequence (use Cube.inverse from cubejs). */
export function inverseMoves(alg: string): string {
  return Cube.inverse(alg);
}

/**
 * The lock-time cascade: free classification, near-tie flips by piece
 * uniqueness, per-face orientation from the pieces; and when that is still
 * not a cube, the same with the nine-per-colour constraint enforced. The
 * result is the first that validates, else the free one (its error message
 * is the honest one).
 */
export function assembleResolved(captures: readonly FaceCapture[]): AssembledState {
  const free = resolveByRotation(resolveByPieces(assembleState(captures)));
  if (validateState(free.facelets).ok) return free;
  const balanced = resolveByRotation(resolveByPieces(assembleState(captures, { balanced: true })));
  if (validateState(balanced.facelets).ok) return { ...balanced, balanced: true };
  return free;
}

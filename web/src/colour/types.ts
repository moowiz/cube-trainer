// Contracts of the colour pipeline (docs/colour-pipeline-design.md).
//
// Everything downstream of the tracker is a pure function of an EvidenceLog:
// readings in, a Solution out. Nothing in here knows a colour's name; letters
// are decided last (naming.ts) and colours are abstract ids 0..5 until then.

import type { FaceId, Lab } from '../types';

export type Vec3 = [number, number, number];
export type RGB = [number, number, number];

/** Robust statistics of one sampled patch (colour/patch.ts samplePatchStats). */
export interface PatchStats {
  /** Per-channel median after trimming the brightest and darkest deciles, 0..255. */
  rgb: RGB;
  lab: Lab;
  /** Fraction of pixels with any channel >= 250 (glare). */
  clipFrac: number;
  /** Fraction of pixels with luminance below 8% (seam, shadow, black plastic). */
  darkFrac: number;
  /** Median absolute Lab distance of the pixels to the patch median. */
  spread: number;
  /** Per channel: the median itself sits at 0 or 255 (a bound, not a value). */
  censored: [boolean, boolean, boolean];
  /** Pixels counted. */
  n: number;
}

/** One sticker cell of one quad in one detection frame. */
export interface Reading {
  /** 0..8 row-major in the TRACK's own corner order (stable for the track's life). */
  cell: number;
  rgb: RGB;
  lab: Lab;
  clipFrac: number;
  darkFrac: number;
  spread: number;
  censored: [boolean, boolean, boolean];
  /** Quality weight in [0,1], the product of evidence.ts's factors. */
  w: number;
}

/** One tracked quad in one detection frame, with its nine readings. */
export interface QuadObs {
  /** Detection-frame index (monotonic per session). */
  frame: number;
  /** Wall-clock ms. */
  t: number;
  track: number;
  /** Source px, in the track's corner order. */
  corners: [number, number][];
  conf: number;
  /** Variance of the Laplacian of the 90x90 grey warp (sharpness). */
  blur: number;
  /** Foreshortening: shorter mid-line over longer, 1 = square on. */
  viewCos: number;
  /** Longest edge in source px. */
  edgePx: number;
  /** Corner speed, px/ms, from the track's previous detection. */
  speed: number;
  /** Detections so far in this track, 1 = first. */
  nth: number;
  readings: Reading[];
}

/**
 * Two quads sharing an image-space edge in one frame: edge (edgeA, edgeA+1)
 * of track a coincides with edge (edgeB, edgeB+1) of track b traversed the
 * other way. Letter-free; which cube edge it is follows once letters exist.
 */
export interface Pairing {
  frame: number;
  a: number;
  b: number;
  edgeA: number;
  edgeB: number;
  /** Corner mismatch of the match in px, and the tolerance it passed. */
  cost: number;
  tol: number;
}

export interface TrackEvent {
  frame: number;
  t: number;
  track: number;
  kind: 'born' | 'died';
  /** Centroid at the event, source px. */
  at: [number, number];
}

/** The capture format: everything the solver sees. Append-only per frame. */
export interface EvidenceLog {
  quads: QuadObs[];
  pairings: Pairing[];
  events: TrackEvent[];
  /** Detection frames seen (including frames with no quads). */
  frames: number;
}

/** A track's cell after temporal aggregation (evidence.ts aggregateTrack). */
export interface Aggregate {
  /** Robust centre of the embedded, illumination-corrected readings; null if no evidence. */
  value: Vec3 | null;
  /** Display colour: the same robust centre in raw Lab. */
  lab: Lab | null;
  /** Effective evidence, min(sum of w, N_SAT). */
  nEff: number;
  /** Weighted MAD of the inliers around `value`, embedding units. */
  spread: number;
}

export interface TrackSignature {
  track: number;
  cells: Aggregate[]; // 9, in the track's own corner order
  /** Frames this track appears in. */
  frames: number[];
  /** Total nEff over the nine cells. */
  nEff: number;
}

export interface Palette {
  /** Six centres in embedding space (empty colours are null). */
  centres: (Vec3 | null)[];
  /** Per-colour scale of the Student-t likelihood, embedding units. */
  sigma: number[];
  /** Display Lab per colour, from the readings assigned to it. */
  lab: (Lab | null)[];
}

export interface FaceGroup {
  id: number;
  /** Member tracks; the first is the reference whose corner order defines the group's cells. */
  tracks: number[];
  /** track -> quarter turns k such that rotateCells(trackCells, k) is in the group's reference order. */
  rotation: Map<number, number>;
  /** Group's nine cells in reference order, each summed over member tracks. */
  cells: Aggregate[];
  nEff: number;
  /** Assigned by naming.ts; null for an unassigned (junk / seventh) group. */
  letter: FaceId | null;
  /** Quarter turns from the reference order to the letter's sticker layout (null if never paired). */
  absRotation: number | null;
  /** Per member track: its absolute cell rotation (layout = rotateCells(raw, k)) once reconciled; absent when the face has no geometry at all. */
  trackAbs: Map<number, number>;
  /** Per member track: its own pairings' votes for its absolute rotation. */
  trackVotes: Map<number, [number, number, number, number]>;
  /** Votes for the group's absRotation, one per paired track weighted by its pairings; contradictions mean a wrong merge. */
  rotationVotes: [number, number, number, number];
}

export interface DecodeResult {
  /** Best legal colouring, 54 abstract colour ids; null if none found within budget. */
  colours: number[] | null;
  /** The free per-slot argmin (what a nearest-centroid classifier would say). */
  argmin: number[];
  /** Total cost of `colours`. */
  cost: number;
  /** Slots where `colours` differs from `argmin`. */
  changed: number;
  /** cost(second legal) - cost(best legal); Infinity when no second was found within budget. */
  delta: number;
  /** Per slot: cheapest cost increase of any 2-swap that moves this slot's colour. */
  margins: number[];
  legal: boolean;
  /** Search effort spent, for the stats line. */
  pops: number;
  /** Slots with no evidence at all (all-zero rows). */
  free: number;
  /** How the free slots were filled: forced by the pieces ('unique'), not forced ('ambiguous'), no completion or budget out ('none'), or nothing to fill. */
  completion: 'unique' | 'ambiguous' | 'none' | 'n/a';
}

export interface Solution {
  /** URFDLB facelet string of the best legal cube, or null. */
  facelets: string | null;
  decode: DecodeResult | null;
  /** Per slot 0..53: effective evidence behind the row. */
  nEff: number[];
  /** Per slot: display Lab of the aggregated reading (null if unobserved). */
  slotLab: (Lab | null)[];
  /** Per slot: the letter decoded, or null. */
  slotLetter: (FaceId | null)[];
  palette: Palette;
  /** Colour id -> letter of the face whose centre carries it (after decode). */
  colourLetter: (FaceId | null)[];
  groups: FaceGroup[];
  centresSeen: number;
  lockable: boolean;
  /** Why not lockable (or 'ok'). */
  reason: string;
  /** Which colour space produced this solution. */
  embedding: string;
  /** Debug: the ordinal names of the palette colours and the best letter maps considered. */
  naming: { names: (string | null)[]; top: { letters: string; penalty: number; mismatches: number }[]; hinted: boolean; lab: (Lab | null)[] };
  /** Milliseconds spent. */
  ms: number;
  /** Per-frame chromatic gains actually applied (debug). */
  gains: Map<number, [number, number]>;
  /** The balanced optimum before the legality search, as letters (debug; null before the final round). */
  balanced: string | null;
}

export interface SolveParams {
  /** Evidence saturation per track-cell. */
  nSat: number;
  /** Evidence below which a slot counts as unseen: its row is freed for the pieces to decide. */
  freeBelow: number;
  /** Evidence a slot needs for the UI to call it full. */
  nMin: number;
  /** Lock gates. */
  kMax: number;
  deltaMin: number;
  marginMin: number;
  /** Student-t degrees of freedom. */
  nu: number;
  /** Illumination prior strength (in units of summed weight) and clamp (embedding units). */
  gainPrior: number;
  gainMax: number;
  /** Track-merge acceptance score in [0,1]. */
  mergeMin: number;
  /** EM rounds. */
  rounds: number;
}

// Shared types for the cube scanner.
// Face order and sticker indexing follow cubejs's facelet string:
// U1..U9 R1..R9 F1..F9 D1..D9 L1..L9 B1..B9, each face row-major as seen
// in the standard Kociemba net (U scanned with F at the bottom, D with F
// at the top, all side faces with U on top).

export type FaceId = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';

export const FACE_ORDER: readonly FaceId[] = ['U', 'R', 'F', 'D', 'L', 'B'];

/** CIE Lab color (D65). All sticker comparisons happen in Lab, never RGB. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** One sampled sticker cell: averaged patch in both spaces (rgb kept for display only). */
export interface CellSample {
  lab: Lab;
  rgb: [number, number, number];
}

/**
 * The six colour words a user thinks in. The detector layer (identify.ts)
 * surfaces this — not FaceId — as the primary user-visible label: a face
 * letter asserts a cube orientation the app has not established yet, but
 * "this is the white face" is just a fact about a center sticker's color.
 */
export type ColorName = 'white' | 'yellow' | 'red' | 'orange' | 'green' | 'blue';

/** Default scheme names, for UI prompts only — centers define the real scheme. */
export const DEFAULT_SCHEME_NAMES: Record<FaceId, ColorName> = {
  U: 'white',
  R: 'red',
  F: 'green',
  D: 'yellow',
  L: 'orange',
  B: 'blue',
};

/** Default scheme hex, for UI display before/instead of measured centroids. */
export const DEFAULT_SCHEME_HEX: Record<FaceId, string> = {
  U: '#FBFBF9',
  R: '#E2433C',
  F: '#33B15D',
  D: '#F5D63D',
  L: '#F58F2A',
  B: '#2E6CE0',
};

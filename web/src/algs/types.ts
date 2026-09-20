// The algs sheet's content model: a puzzle, its sections, its cases. The
// data (data.ts) is a static table; the sheet (sheet.ts) draws it; the
// test (test/algs.test.ts) runs every NxN alg on the n×n model and checks
// the claim each case makes about what it touches, so a typo in an alg
// cannot ship as a "parity" that scrambles the cube.

export type PuzzleId = '222' | '444' | '555' | 'pyra' | 'skewb' | 'fto';

/** What an NxN alg is allowed to change on a solved cube (checked by test). */
export interface Check {
  /** the piece types the alg may move; anything else must stay put */
  only?: ('corner' | 'edge' | 'centre')[];
  /** the alg may only change stickers in the top layer */
  top?: boolean;
  /** the alg does change something (the default); false for a pure rotation check */
  changes?: boolean;
}

export interface AlgCase {
  name: string;
  /** the alg that SOLVES the case, in the notation the puzzle's `notation` paragraph explains (WCA for the cubes) */
  alg: string;
  /** other algs people use for the same case */
  alt?: string[];
  /** what it does, or how to recognise it: one or two sentences, in colours not letters */
  note?: string;
  /** NxN only: the picture is the case (the alg's inverse on a solved cube) - top view with one row of each side
   *  (`top`), with two rows (`top2`, the whole 2x2 but its bottom), the three-face view (`iso`), or none */
  pic?: 'top' | 'top2' | 'iso' | 'none';
  /** NxN only: a rotation the picture is turned by, so the pieces the alg moves are in view (the check ignores it) */
  setup?: string;
  /** NxN only: the claim the test verifies */
  check?: Check;
  /** where the alg came from */
  source?: string;
}

export interface AlgSection {
  title: string;
  /** one or two sentences: when this section applies, what to know */
  blurb?: string;
  cases: AlgCase[];
}

export interface Puzzle {
  id: PuzzleId;
  /** the tab label */
  name: string;
  /** cubes: the layer count; the pictures and the checks exist only for these */
  n?: number;
  /** the notation the algs use, and how the puzzle is held, in a short paragraph */
  notation: string;
  /** two or three sentences on what is worth memorising and what is not */
  intro?: string;
  sections: AlgSection[];
  /** the puzzle name alg.cubing.net (cubes, pyraminx, skewb) or twizzle (fto) wants in its URL */
  viewer?: string;
}

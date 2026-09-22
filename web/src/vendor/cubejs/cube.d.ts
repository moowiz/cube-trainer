// Hand-written types for the vendored cubejs (it ships none). The solver half
// (initSolver, solve, random, inverse, scramble) is added by ./solve.js, but
// it is declared here so one file describes the whole class.
export default class Cube {
  constructor(state?: unknown);
  /** which corner cubie sits in each of the 8 corner slots (URF UFL ULB UBR DFR DLF DBL DRB), and its twist */
  cp: number[];
  co: number[];
  /** which edge cubie sits in each of the 12 edge slots (UR UF UL UB DR DF DL DB FR FL BL BR), and its flip */
  ep: number[];
  eo: number[];
  static initSolver(): void;
  static scramble(): string;
  static inverse(alg: string): string;
  static random(): Cube;
  static fromString(facelets: string): Cube;
  move(alg: string): this;
  asString(): string;
  solve(maxDepth?: number): string;
  isSolved(): boolean;
  randomize(): void;
}

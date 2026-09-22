// Types for the npm `cubejs` package, which ships none. The APP does not use
// the package any more - it uses the vendored copy in src/vendor/cubejs (which
// has its own types). This declaration is for the TESTS, which keep the real
// package as an independent oracle to check our cube code against.
declare module 'cubejs' {
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
}

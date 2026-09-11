declare module 'cubejs' {
  export default class Cube {
    constructor(state?: unknown);
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

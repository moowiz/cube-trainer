// The 3x3 grid of a face's cells as read off a quad: rotating it by quarter
// turns is what the evidence log, the face grouping, the solver and the move
// reader's anchor all do to line one reading up with another. Not a cube
// rotation: nine cells of one face, row-major.

/** Row-major 3x3 cell index after k quarter turns: rotated[i] = cells[ROT3[k][i]]. */
const ROT3: readonly (readonly number[])[] = (() => {
  const once = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // 90 deg: new (r, c) = old (2 - c, r)
  const out: number[][] = [[0, 1, 2, 3, 4, 5, 6, 7, 8]];
  for (let k = 1; k < 4; k++) out.push(out[k - 1]!.map((_, i) => out[k - 1]![once[i]!]!));
  return out;
})();

export function rotateCells<T>(cells: readonly T[], k: number): T[] {
  return ROT3[k & 3]!.map((j) => cells[j]!);
}

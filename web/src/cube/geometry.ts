// Where each facelet sits in 3D: the sticker's centre position on the unit
// cube and its face normal, indexed by facelet order (U1..U9 R1..R9 ...).
// Everything geometric - the 3D and net pictures, piece positions, face
// names - reads this one table.

export type Vec = readonly [number, number, number];

export interface Sticker {
  /** facelet index 0..53 */
  idx: number;
  face: string;
  /** centre of the sticker: the cubie position plus half the normal, in cubie units */
  pos: Vec;
  n: Vec;
}

export const NORMAL: Record<string, Vec> = { U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1], R: [1, 0, 0], L: [-1, 0, 0] };

/** The cubie position of face `face`'s facelet number k (0..8): Kociemba reads each face in rows, with a fixed "up" per face. */
function cubiePos(face: string, k: number): Vec {
  const r = Math.floor(k / 3), c = k % 3;
  switch (face) {
    case 'U': return [c - 1, 1, r - 1];
    case 'R': return [1, 1 - r, 1 - c];
    case 'F': return [c - 1, 1 - r, 1];
    case 'D': return [c - 1, -1, 1 - r];
    case 'L': return [-1, 1 - r, c - 1];
    default: return [1 - c, 1 - r, -1]; // B
  }
}

export const STICKERS: readonly Sticker[] = 'URFDLB'.split('').flatMap((face, fi) =>
  Array.from({ length: 9 }, (_, k) => ({ idx: fi * 9 + k, face, pos: cubiePos(face, k), n: NORMAL[face] })),
);

export const key = (p: Vec): string => p.join(',');

/** A cubie position as a name: U/D first, then F/B, then R/L ('UFR', 'DL', 'F'). */
export function posName(p: Vec): string {
  const [x, y, z] = p;
  return (y === 1 ? 'U' : y === -1 ? 'D' : '') + (z === 1 ? 'F' : z === -1 ? 'B' : '') + (x === 1 ? 'R' : x === -1 ? 'L' : '');
}

export function pieceType(p: Vec): 'corner' | 'edge' | 'center' {
  const n = Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]);
  return n === 3 ? 'corner' : n === 2 ? 'edge' : 'center';
}

/** Facelet indices of the stickers on the cubie at position `p` (1, 2 or 3 of them). */
export function facesAt(p: Vec): number[] {
  return STICKERS.filter((s) => key(s.pos) === key(p)).map((s) => s.idx);
}

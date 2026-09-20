// Pictures of an n×n case for the algs sheet, as inner SVG (viewBox 0 0
// 200 200): the top view (the top face with a strip of each side, the
// last-layer picture the OCLL / PLL drills use, generalised to n and to
// deeper strips so a whole 2x2 fits) and the three-face view (top, front,
// right in parallel projection, for centres and edges that a top view
// hides). Colours follow the trainer's scheme (white down, the chosen
// colour in front) through faceHex, so a case looks like the user's cube.

import { stickerPos, type Face } from '../cube/nxn';
import { faceHex } from '../cube/scheme';

const rect = (x: number, y: number, w: number, h: number, letter: string, r = 2.5) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" fill="${faceHex(letter)}"/>`;

/** Every sticker of `state` with where it sits, once per call (n ≤ 7: at most 294 of them). */
function stickers(n: number, state: string): { face: Face; x: number; y: number; z: number; letter: string }[] {
  const out = [];
  for (let i = 0; i < state.length; i++) out.push({ ...stickerPos(n, i), letter: state[i]! });
  return out;
}

/**
 * The top view: the top face n×n in the middle, and `rows` rows of each side around it (row 0 nearest the top
 * face). The front is at the bottom of the picture, so the left strip is the left face and the back strip
 * reads left to right as the cube's left to right.
 */
export function picTop(n: number, state: string, rows = 1): string {
  const pad = 4, t = rows === 1 ? 14 : 12, gap = 4;
  const strip = rows * t + gap, size = 200 - 2 * (pad + strip), cell = size / n, o = pad + strip;
  let out = '';
  for (const s of stickers(n, state)) {
    const row = n - 1 - s.y; // 0 = the top layer, for the side strips
    if (s.face === 'U') out += rect(o + s.x * cell + 1, o + s.z * cell + 1, cell - 2, cell - 2, s.letter);
    else if (row >= rows || s.face === 'D') continue;
    else if (s.face === 'F') out += rect(o + s.x * cell + 1, o + size + gap + row * t, cell - 2, t - 2, s.letter);
    else if (s.face === 'B') out += rect(o + s.x * cell + 1, o - gap - (row + 1) * t + 2, cell - 2, t - 2, s.letter);
    else if (s.face === 'L') out += rect(o - gap - (row + 1) * t + 2, o + s.z * cell + 1, t - 2, cell - 2, s.letter);
    else if (s.face === 'R') out += rect(o + size + gap + row * t, o + s.z * cell + 1, t - 2, cell - 2, s.letter);
  }
  return out;
}

/** The three-face view: top, front and right faces in parallel projection, the front-top-right corner in the middle. */
export function picIso(n: number, state: string): string {
  // screen axes: x runs right-and-down, z (toward the viewer) left-and-down, y straight up; scaled so 2n units fill the height
  const k = 200 / (2 * n), cx = 100, cy = 100;
  const P = (x: number, y: number, z: number): string => `${(cx + (x - z) * 0.866 * k).toFixed(1)},${(cy + ((x + z) * 0.5 - y) * k).toFixed(1)}`;
  const quad = (pts: [number, number, number][], letter: string) => `<polygon points="${pts.map((p) => P(...p)).join(' ')}" fill="${faceHex(letter)}" stroke="#2b3340" stroke-width="1.2" stroke-linejoin="round"/>`;
  const e = 0.06; // the gap between stickers, in cubie units
  let out = '';
  for (const s of stickers(n, state)) {
    const { x, y, z } = s;
    if (s.face === 'U') out += quad([[x + e, n, z + e], [x + 1 - e, n, z + e], [x + 1 - e, n, z + 1 - e], [x + e, n, z + 1 - e]], s.letter);
    else if (s.face === 'F') out += quad([[x + e, y + e, n], [x + 1 - e, y + e, n], [x + 1 - e, y + 1 - e, n], [x + e, y + 1 - e, n]], s.letter);
    else if (s.face === 'R') out += quad([[n, y + e, z + e], [n, y + e, z + 1 - e], [n, y + 1 - e, z + 1 - e], [n, y + 1 - e, z + e]], s.letter);
  }
  return out;
}

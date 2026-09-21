// Pictures of an n×n case for the algs sheet, as inner SVG (viewBox 0 0
// 200 200): the top view (the top face with a strip of each side, the
// last-layer picture the OCLL / PLL drills use, generalised to n and to
// deeper strips so a whole 2x2 fits) and the three-face view (top, front,
// right in parallel projection, for centres and edges that a top view
// hides). Colours follow the trainer's scheme (white down, the chosen
// colour in front) through faceHex, so a case looks like the user's cube.
// The FTO has its own view (picFto): the four faces around the front
// corner as a square, the back faces as strips around it, in twizzle's
// colours.

import { FTO_CORNERS, FTO_FACES, FTO_HEX, FTO_STICKERS, type FtoFace, type FtoState } from '../cube/fto';
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

/**
 * The FTO from the front corner (Ben's hold): the four faces around it fill a square, U at the top, F at the
 * bottom, L and R at the sides, each a triangle with its apex at the centre. Around the square, a strip for each
 * back face: the row of five stickers it has along the edge it shares with the square (B above U, D below F, BL
 * left of L, BR right of R), so a last-layer case on U shows its corners' other stickers and the triangles that
 * ride with them.
 */
export function picFto(state: FtoState): string {
  const t = 13, gap = 3, s = t + gap + 1, e = 200 - s, mid = 100;
  const P: Record<string, [number, number]> = { N: [mid, mid], ul: [s, s], ur: [e, s], dl: [s, e], dr: [e, e] };
  // the back corner K folds out differently behind each strip: three strip heights past the edge, so the row nearest the edge is one strip tall
  const K: Partial<Record<FtoFace, [number, number]>> = { B: [mid, s - gap - 3 * t], D: [mid, e + gap + 3 * t], BL: [s - gap - 3 * t, mid], BR: [e + gap + 3 * t, mid] };
  let out = '';
  for (const st of FTO_STICKERS) {
    const back = K[st.face];
    const corners = FTO_CORNERS[st.face].map((c) => (c === 'K' ? back! : P[c]!));
    if (back && st.bary.some((w) => w[0] > 1 / 3 + 1e-9)) continue; // K is the first corner of every back face: keep the row along the edge
    const pts = st.bary.map((w) => [w[0] * corners[0]![0] + w[1] * corners[1]![0] + w[2] * corners[2]![0], w[0] * corners[0]![1] + w[1] * corners[1]![1] + w[2] * corners[2]![1]] as [number, number]);
    const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3, cy = (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3;
    const inset = pts.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy), k = Math.min(0.5, 1.7 / d); return `${(x + (cx - x) * k).toFixed(1)},${(y + (cy - y) * k).toFixed(1)}`; });
    out += `<polygon points="${inset.join(' ')}" fill="${FTO_HEX[FTO_FACES[state[st.idx]!]!]}" stroke="#2b3340" stroke-width="1" stroke-linejoin="round"/>`;
  }
  return out;
}

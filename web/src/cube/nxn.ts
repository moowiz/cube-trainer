// An n×n×n facelet cube (2 ≤ n ≤ 7) for the algs sheet: the 2x2, 4x4 and
// 5x5 cases are drawn from it and their claims are tested on it. The state
// is a string of 6·n·n letters in the same order as the 3x3's facelet
// string (U R F D L B, each face read in rows with cubejs's per-face "up"),
// so for n=3 it reproduces cubejs move for move (test/nxn.test.ts anchors
// every axis and slice to it). The parser reads WCA big-cube notation
// (Rw, 3Rw, 2R, 2-3Rw, Uw2, x) and SiGN's lowercase wide moves (r, 3r),
// plus commutator and conjugate brackets and repeated groups. It is not
// cube/alg.ts (the 3x3 parser cubejs feeds on) because 2R and 3Rw are not
// cubejs tokens; the 3x3 trainers keep using that one.

export type Face = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';
export const FACES: readonly Face[] = ['U', 'R', 'F', 'D', 'L', 'B'];

/** Solved n×n: each face's n·n letters in U R F D L B order. */
export function solvedNxN(n: number): string {
  return FACES.map((f) => f.repeat(n * n)).join('');
}

/** Where sticker `idx` sits: its face and its cubie in integer coordinates x 0..n-1 (L→R), y 0..n-1 (D→U), z 0..n-1 (B→F). */
export function stickerPos(n: number, idx: number): { face: Face; x: number; y: number; z: number } {
  const face = FACES[Math.floor(idx / (n * n))]!;
  const k = idx % (n * n), r = Math.floor(k / n), c = k % n, m = n - 1;
  // the same per-face reading as geometry.ts cubiePos, with 0..n-1 instead of -1..1
  switch (face) {
    case 'U': return { face, x: c, y: m, z: r };
    case 'R': return { face, x: m, y: m - r, z: m - c };
    case 'F': return { face, x: c, y: m - r, z: m };
    case 'D': return { face, x: c, y: 0, z: m - r };
    case 'L': return { face, x: 0, y: m - r, z: c };
    default: return { face, x: m - c, y: m - r, z: 0 };
  }
}

/** corner / edge / centre by how many of the cubie's coordinates are on the boundary (0 or n-1): 3 / 2 / 1. */
export function pieceTypeNxN(n: number, idx: number): 'corner' | 'edge' | 'centre' {
  const s = stickerPos(n, idx);
  const b = [s.x, s.y, s.z].filter((v) => v === 0 || v === n - 1).length;
  return b === 3 ? 'corner' : b === 2 ? 'edge' : 'centre';
}

// ---- notation: brackets, commutators, repeats -> flat tokens ----

type Node = { t: 'move'; s: string } | { t: 'seq'; items: Node[]; times: number; inv: boolean } | { t: 'comm' | 'conj'; a: Node; b: Node; times: number; inv: boolean };

/** The alg as flat move tokens: brackets and parentheses removed, `[A, B]` = A B A' B', `[A: B]` = A B A', `(A)k` and `(A)k'` expanded. */
export function expandNxN(alg: string): string[] {
  const src = alg;
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const suffix = (): { times: number; inv: boolean } => {
    const m = /^(\d*)('?)/.exec(src.slice(i))!;
    i += m[0].length;
    return { times: m[1] ? Number(m[1]) : 1, inv: m[2] === "'" };
  };
  const seq = (stop: string): Node[] => {
    const items: Node[] = [];
    for (;;) {
      skip();
      const ch = peek();
      if (ch === undefined || stop.includes(ch)) return items;
      if (ch === '(') {
        i++;
        const inner = seq(')');
        if (peek() !== ')') throw new Error('Could not read: ( without )');
        i++;
        items.push({ t: 'seq', items: inner, ...suffix() });
      } else if (ch === '[') {
        i++;
        const a = seq(',:]');
        const sep = peek();
        if (sep !== ',' && sep !== ':') throw new Error('Could not read: [ without , or :');
        i++;
        const b = seq(']');
        if (peek() !== ']') throw new Error('Could not read: [ without ]');
        i++;
        items.push({ t: sep === ',' ? 'comm' : 'conj', a: { t: 'seq', items: a, times: 1, inv: false }, b: { t: 'seq', items: b, times: 1, inv: false }, ...suffix() });
      } else {
        let j = i;
        while (j < src.length && !/[\s()[\],:]/.test(src[j]!)) j++;
        items.push({ t: 'move', s: src.slice(i, j) });
        i = j;
      }
    }
  };
  const nodes = seq('');
  if (i < src.length) throw new Error(`Could not read: ${src.slice(i)}`);
  const flat = (node: Node): string[] => {
    if (node.t === 'move') return [node.s];
    let body: string[];
    if (node.t === 'seq') body = node.items.flatMap(flat);
    else {
      const a = flat(node.a), b = flat(node.b);
      body = node.t === 'comm' ? [...a, ...b, ...invertTokens(a), ...invertTokens(b)] : [...a, ...b, ...invertTokens(a)];
    }
    if (node.inv) body = invertTokens(body);
    const out: string[] = [];
    for (let k = 0; k < node.times; k++) out.push(...body);
    return out;
  };
  return nodes.flatMap(flat);
}

/** The inverse of a token list: reversed, each suffix flipped (`R`↔`R'`, `R2` and `R2'` stay half turns). */
export function invertTokens(tokens: readonly string[]): string[] {
  return [...tokens].reverse().map((t) => (t.endsWith("2'") ? t.slice(0, -1) : t.endsWith('2') ? t : t.endsWith("'") ? t.slice(0, -1) : `${t}'`));
}

// ---- moves: axis, layers, quarter turns ----

interface Turn { axis: 0 | 1 | 2; layers: number[]; times: number }

const FACE_AXIS: Record<Face, 0 | 1 | 2> = { R: 0, L: 0, U: 1, D: 1, F: 2, B: 2 };
const POSITIVE: Record<Face, boolean> = { R: true, U: true, F: true, L: false, D: false, B: false }; // R U F turn the positive way about their axis
const SLICE_LIKE: Record<string, Face> = { M: 'L', E: 'D', S: 'F' };
const ROT_LIKE: Record<string, Face> = { x: 'R', y: 'U', z: 'F' };

/** `token` as a turn on an n×n, or throws. */
function parseTurn(n: number, token: string): Turn {
  const m = /^(?:(\d+)-)?(\d+)?([URFDLBurfdlbMESxyz])(w?)(2'|'|2)?$/.exec(token);
  if (!m) throw new Error(`Could not read: ${token}`);
  const [, from, depth, letter, w, suf] = m;
  const times = suf === "'" ? 3 : suf ? 2 : 1;
  const lower = letter! >= 'a' && letter! <= 'z' && !(letter! in ROT_LIKE);
  const face: Face = letter! in SLICE_LIKE ? SLICE_LIKE[letter!]! : letter! in ROT_LIKE ? ROT_LIKE[letter!]! : (letter!.toUpperCase() as Face);
  const axis = FACE_AXIS[face];
  const q = POSITIVE[face] ? times : (4 - times) % 4;
  // layer k (1 = the named face) sits at coordinate n-k for R U F and k-1 for L D B
  const coord = (k: number) => (POSITIVE[face] ? n - k : k - 1);
  let layers: number[];
  if (letter! in ROT_LIKE) {
    if (from || depth || w) throw new Error(`Could not read: ${token}`);
    layers = Array.from({ length: n }, (_, k) => k);
  } else if (letter! in SLICE_LIKE) {
    if (from || depth || w) throw new Error(`Could not read: ${token}`);
    // DECISION: the single middle layer on an odd cube (cubing.js reads M on a 5x5 that way); the two innermost on an even one
    layers = n % 2 ? [(n - 1) / 2] : [n / 2 - 1, n / 2];
  } else if (from) {
    // a-bRw: layers a..b
    const a = Number(from), b = Number(depth);
    if (!(w || lower) || !(a >= 1 && a <= b && b <= n)) throw new Error(`Could not read: ${token}`);
    layers = Array.from({ length: b - a + 1 }, (_, k) => coord(a + k));
  } else if (w || lower) {
    // kRw / kr: the outer k layers (k = 2 when unwritten); k = n is a rotation, which is allowed
    const k = depth ? Number(depth) : 2;
    if (k < 1 || k > n) throw new Error(`Could not read: ${token}`);
    layers = Array.from({ length: k }, (_, j) => coord(j + 1));
  } else {
    // R or kR: one layer; kR with k ≥ n would be the opposite face
    const k = depth ? Number(depth) : 1;
    if (k < 1 || k >= n) throw new Error(`Could not read: ${token}`);
    layers = [coord(k)];
  }
  return { axis, layers, times: q };
}

// the positive quarter turn about each axis, in coordinates doubled and centred so they stay integers: (x, y, z) -> ...
const ROT: ((p: [number, number, number]) => [number, number, number])[] = [
  ([x, y, z]) => [x, z, -y], // R: front goes up
  ([x, y, z]) => [-z, y, x], // U: front goes left
  ([x, y, z]) => [y, -x, z], // F: top goes right
];
const NORMAL: Record<Face, [number, number, number]> = { U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1], R: [1, 0, 0], L: [-1, 0, 0] };

const permCache = new Map<string, number[]>();
/** Where each sticker goes under `turn`: dest[i] is the index sticker i lands on. */
function permutation(n: number, turn: Turn): number[] {
  const key = `${n}:${turn.axis}:${turn.layers.join(',')}:${turn.times}`;
  const hit = permCache.get(key);
  if (hit) return hit;
  const total = 6 * n * n;
  const at = new Map<string, number>();
  const pos: { p: [number, number, number]; nrm: [number, number, number]; layer: number }[] = [];
  for (let i = 0; i < total; i++) {
    const s = stickerPos(n, i);
    const p: [number, number, number] = [2 * s.x - (n - 1), 2 * s.y - (n - 1), 2 * s.z - (n - 1)];
    const nrm = NORMAL[s.face];
    at.set(`${p.join(',')}|${nrm.join(',')}`, i);
    pos.push({ p, nrm, layer: [s.x, s.y, s.z][turn.axis]! });
  }
  const rot = ROT[turn.axis]!;
  const dest = new Array<number>(total);
  const layers = new Set(turn.layers);
  for (let i = 0; i < total; i++) {
    const { p, nrm, layer } = pos[i]!;
    if (!layers.has(layer)) { dest[i] = i; continue; }
    let q = p, m = nrm;
    for (let k = 0; k < turn.times; k++) { q = rot(q); m = rot(m); }
    const j = at.get(`${q.join(',')}|${m.join(',')}`);
    if (j === undefined) throw new Error('rotation left the cube'); // cannot happen
    dest[i] = j;
  }
  permCache.set(key, dest);
  return dest;
}

function applyTokens(n: number, tokens: readonly string[], state: string): string {
  let cur = state;
  for (const t of tokens) {
    const dest = permutation(n, parseTurn(n, t));
    const out = new Array<string>(cur.length);
    for (let i = 0; i < cur.length; i++) out[dest[i]!] = cur[i]!;
    cur = out.join('');
  }
  return cur;
}

/** Stickers after `alg` from `state` (default solved), rotations applied literally. Throws `Could not read: <token>` on a bad move. */
export function rawNxN(n: number, alg: string, state = solvedNxN(n)): string {
  if (state.length !== 6 * n * n) throw new Error(`state is not a ${n}x${n} cube`);
  return applyTokens(n, expandNxN(alg), state);
}

const isRotation = (t: string) => /^[xyz]/.test(t);
const centreIdx = (n: number, f: number) => f * n * n + (n * n - 1) / 2;
const centresHome = (n: number, s: string) => FACES.every((f, i) => s[centreIdx(n, i)] === f);

// the 24 whole-cube rotations as token lists, found once per n by their effect on the solved cube
const rotCache = new Map<number, string[][]>();
function allRotations(n: number): string[][] {
  const hit = rotCache.get(n);
  if (hit) return hit;
  const seen = new Map<string, string[]>();
  const turns = ['', 'x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];
  for (const a of turns) for (const b of turns) {
    const toks = [a, b].filter(Boolean);
    const key = applyTokens(n, toks, solvedNxN(n));
    if (!seen.has(key)) seen.set(key, toks);
  }
  const out = [...seen.values()];
  rotCache.set(n, out);
  return out;
}

/**
 * Like rawNxN, in the frame the alg started in. The net of the alg's explicit rotations is undone, and then the
 * whole-cube rotation that homes the cube is applied: on an odd cube the one that homes the centres (the rule of
 * state() in cube/state.ts: Rw on a 3x3 carries the middle layer away), on an even cube, which has no fixed centre,
 * the one that leaves the fewest stickers away from solved, the identity winning ties. The second rule is what makes
 * a wide-move alg with an x in it (the 4x4 OLL parity) come out as the flipped edge and not as a rotated cube.
 */
export function applyNxN(n: number, alg: string, state = solvedNxN(n)): string {
  const tokens = expandNxN(alg);
  const out = applyTokens(n, [...tokens, ...invertTokens(tokens.filter(isRotation))], state);
  if (n % 2) {
    if (centresHome(n, out)) return out;
    const fix = allRotations(n).find((r) => centresHome(n, applyTokens(n, r, out)));
    if (!fix) throw new Error('no rotation brings the centres home'); // cannot happen for a real cube
    return applyTokens(n, fix, out);
  }
  const solved = solvedNxN(n);
  let best = out, bestAway = diffNxN(solved, out).length;
  for (const r of allRotations(n)) {
    if (!r.length) continue;
    const s = applyTokens(n, r, out);
    const away = diffNxN(solved, s).length;
    if (away < bestAway) { best = s; bestAway = away; }
  }
  return best;
}

/** Indices of the stickers that differ between two states of the same size. */
export function diffNxN(a: string, b: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

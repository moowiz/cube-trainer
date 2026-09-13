// Completion of unseen stickers from the cube's constraints. Every corner
// and edge piece is unique, so once most of the cube is known the rest is
// forced: with five faces seen, each sticker of the sixth is the one colour
// that makes its piece a real, unused piece. This is what lets a scan lock
// without ever showing every face - and the same search says when the
// unseen part is NOT forced (two unseen faces usually leave pieces that
// could swap), which is a refusal, not a guess.

import { CENTER_INDICES, CORNER_COLORS, CORNER_FACELETS, EDGE_COLORS, EDGE_FACELETS, validateState } from '../state';
import { FACE_ORDER } from '../types';

export interface Completion {
  /** The unique completion, or null when there is none or more than one. */
  facelets: string | null;
  /** Completions found: 0, 1, or 2 (= "at least two"). */
  solutions: number;
  /** The node budget ran out before the count was settled. */
  overflow: boolean;
}

interface Piece { slots: readonly number[]; colours: readonly (readonly string[])[] }

const PIECES: Piece[] = [
  ...CORNER_FACELETS.map((slots) => ({ slots, colours: CORNER_COLORS })),
  ...EDGE_FACELETS.map((slots) => ({ slots, colours: EDGE_COLORS })),
];
const PIECE_OF_SLOT: (number | null)[] = new Array<number | null>(54).fill(null);
PIECES.forEach((p, i) => p.slots.forEach((s) => { PIECE_OF_SLOT[s] = i; }));

/** Index of the real piece with exactly this colour set, or -1. */
function pieceId(colours: readonly (readonly string[])[], letters: readonly string[]): number {
  if (new Set(letters).size !== letters.length) return -1;
  for (let i = 0; i < colours.length; i++) {
    const c = colours[i]!;
    if (c.length === letters.length && letters.every((l) => c.includes(l))) return i;
  }
  return -1;
}

/**
 * Fill every '?' of a 54-char facelet string (URFDLB order) so that the
 * result is a real cube. Centres: an unknown centre takes a letter no other
 * centre has. Counts: nine of each letter. Pieces: every fully assigned
 * corner/edge must be a real piece, each at most once. Parity and
 * orientation are checked by validateState at the leaves. Search order is
 * most-constrained-first; the count stops at two solutions.
 */
export function completeFacelets(partial: string, opts: { maxNodes?: number } = {}): Completion {
  const maxNodes = opts.maxNodes ?? 20000;
  const cells = partial.split('');
  const remaining: Record<string, number> = {};
  for (const f of FACE_ORDER) remaining[f] = 9;
  for (const c of cells) if (c !== '?') remaining[c] = (remaining[c] ?? 0) - 1;
  if (Object.values(remaining).some((n) => n < 0)) return { facelets: null, solutions: 0, overflow: false };

  const free = cells.map((c, i) => (c === '?' ? i : -1)).filter((i) => i >= 0);
  if (!free.length) {
    const ok = validateState(cells.join('')).ok;
    return { facelets: ok ? cells.join('') : null, solutions: ok ? 1 : 0, overflow: false };
  }
  // most constrained first: centres, then slots whose piece has the most known stickers
  const known = (s: number): number => {
    const p = PIECE_OF_SLOT[s];
    return p === null ? 9 : PIECES[p]!.slots.filter((x) => cells[x] !== '?').length;
  };
  free.sort((a, b) => known(b) - known(a));

  const usedCorner = new Set<number>();
  const usedEdge = new Set<number>();
  // pieces fully known at the start
  for (let i = 0; i < PIECES.length; i++) {
    const p = PIECES[i]!;
    if (p.slots.some((s) => cells[s] === '?')) continue;
    const id = pieceId(p.colours, p.slots.map((s) => cells[s]!));
    if (id < 0) return { facelets: null, solutions: 0, overflow: false };
    (p.slots.length === 3 ? usedCorner : usedEdge).add(id);
  }

  let nodes = 0;
  let solutions = 0;
  let found: string | null = null;
  let overflow = false;

  const pieceOk = (s: number): { ok: boolean; id: number; corner: boolean } => {
    const pi = PIECE_OF_SLOT[s]!;
    const p = PIECES[pi]!;
    if (p.slots.some((x) => cells[x] === '?')) return { ok: true, id: -1, corner: false };
    const id = pieceId(p.colours, p.slots.map((x) => cells[x]!));
    const corner = p.slots.length === 3;
    if (id < 0) return { ok: false, id, corner };
    return { ok: !(corner ? usedCorner : usedEdge).has(id), id, corner };
  };

  const rec = (i: number): void => {
    if (solutions >= 2 || overflow) return;
    if (++nodes > maxNodes) { overflow = true; return; }
    if (i === free.length) {
      if (validateState(cells.join('')).ok) { solutions++; if (!found) found = cells.join(''); }
      return;
    }
    const s = free[i]!;
    const isCentre = CENTER_INDICES.includes(s);
    for (const f of FACE_ORDER) {
      if (remaining[f]! <= 0) continue;
      if (isCentre && CENTER_INDICES.some((c) => c !== s && cells[c] === f)) continue;
      cells[s] = f;
      remaining[f]!--;
      let pushed: { id: number; corner: boolean } | null = null;
      let ok = true;
      if (!isCentre) {
        const r = pieceOk(s);
        ok = r.ok;
        if (ok && r.id >= 0) { (r.corner ? usedCorner : usedEdge).add(r.id); pushed = r; }
      }
      if (ok) rec(i + 1);
      if (pushed) (pushed.corner ? usedCorner : usedEdge).delete(pushed.id);
      remaining[f]!++;
      cells[s] = '?';
      if (solutions >= 2 || overflow) return;
    }
  };
  rec(0);
  return { facelets: solutions === 1 && !overflow ? found : null, solutions, overflow };
}

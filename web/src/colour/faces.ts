// Track -> physical face grouping (design 3.7). A track is an anonymous
// face; over a session the same face is re-acquired under new track ids
// after every coast. Two tracks are the same face when their nine-cell
// signatures agree at some quarter turn, evaluated as colour MEMBERSHIPS
// (so lighting is already normalised out) - and never when they were seen
// in the same frame, which is the strongest negative evidence there is and
// the one thing the old cluster ids could not express.
//
// Rotations compose additively: rotateCells(rotateCells(c, a), b) is
// rotateCells(c, a + b) (state.ts ROT3 is the cyclic group of quarter turns),
// so a union-find with a rotation label per edge carries every member's
// offset to the group's reference order.

import { rotateCells } from '../state';
import type { Aggregate, FaceGroup, TrackSignature, Vec3 } from './types';

export interface GroupingInput {
  signatures: readonly TrackSignature[];
  /** soft memberships over the six colours, or null for an empty aggregate */
  member: (x: Vec3 | null) => number[] | null;
  /** "a,b" keys of track pairs seen in one frame */
  coVisible: ReadonlySet<string>;
  /** acceptance score in [0,1] */
  mergeMin: number;
  /** absolute cell rotations already known from geometry (previous round's pairings); two paired tracks are aligned by these, never by colour */
  absRot?: ReadonlyMap<number, number>;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Agreement of signature b rotated by k with signature a (weighted mean membership dot product). */
export function matchAt(
  a: readonly (number[] | null)[], na: readonly number[],
  b: readonly (number[] | null)[], nb: readonly number[],
  k: number,
): { score: number; cells: number } {
  const rb = rotateCells(b, k);
  const rn = rotateCells(nb, k);
  let num = 0;
  let den = 0;
  let cells = 0;
  for (let i = 0; i < 9; i++) {
    const x = a[i];
    const y = rb[i];
    if (!x || !y) continue;
    const w = Math.min(na[i]!, rn[i]!);
    if (w <= 0) continue;
    num += w * dot(x, y);
    den += w;
    cells++;
  }
  // DECISION: three cells compared is the floor for a comparison to mean
  // anything; below it the score is 0 and the tracks stay apart. And the
  // centre is rotation-free, so two tracks whose centres disagree are two
  // faces however alike their edges look (a scrambled cube can repeat an
  // outer pattern; it cannot repeat a centre).
  const centreOk = !a[4] || !b[4] || dot(a[4], b[4]) >= 0.5;
  return { score: cells >= 3 && den > 0 && centreOk ? num / den : 0, cells };
}

/** Best-rotation agreement of two signatures: k such that rotateCells(b, k) matches a. */
export function signatureMatch(
  a: readonly (number[] | null)[], na: readonly number[],
  b: readonly (number[] | null)[], nb: readonly number[],
  forceK?: number,
): { score: number; k: number; cells: number } {
  let best = { score: 0, k: forceK ?? 0, cells: 0 };
  for (let k = 0; k < 4; k++) {
    if (forceK !== undefined && k !== forceK) continue;
    const m = matchAt(a, na, b, nb, k);
    if (m.score > best.score) best = { score: m.score, k, cells: m.cells };
  }
  return best;
}

/**
 * Reconcile the rotations of a face's tracks (after letters exist).
 * Geometry (a track's own pairings) and colour (its cells against its
 * face-mates) fail differently: a near-symmetric sticker pattern ties the
 * colour match, while a stale or slid track carries pairings that are
 * unanimous and wrong (#1 and #36 in scan-debug-1789321540510). So:
 *
 *   1. the RELATIVE rotation between tracks comes from colour where it is
 *      unambiguous (best rotation ahead of the runner-up by
 *      RECONCILE_MARGIN), settled one track at a time against the already
 *      settled ones, strongest evidence first; where colour cannot say, the
 *      previous geometric relation stands;
 *   2. the ABSOLUTE rotation of the whole face is the one offset that
 *      agrees with the most pairing votes summed over all its tracks.
 *
 * A face with no pairings at all keeps only the relative alignment (its
 * absolute rotation is resolved by legality later).
 */
export function reconcileRotations(
  groups: FaceGroup[],
  signatures: readonly TrackSignature[],
  member: (x: Vec3 | null) => number[] | null,
): number {
  const RECONCILE_MARGIN = 0.15;
  const sig = new Map(signatures.map((s) => [s.track, s]));
  let changed = 0;
  for (const g of groups) {
    if (!g.letter) continue;
    const before = (t: number): number | null => {
      const own = g.trackAbs.get(t);
      if (own !== undefined) return own;
      return g.absRotation === null ? null : (g.rotation.get(t)! + g.absRotation) % 4;
    };
    const order = g.tracks.slice().sort((x, y) => sig.get(y)!.nEff - sig.get(x)!.nEff);
    const mem = new Map(g.tracks.map((t) => [t, sig.get(t)!.cells.map((c) => member(c.value))]));
    const nEff = new Map(g.tracks.map((t) => [t, sig.get(t)!.cells.map((c) => c.nEff)]));
    // 1. relative rotations: layout-ish order of the anchor
    const rel = new Map<number, number>();
    const anchor = order[0]!;
    rel.set(anchor, 0);
    for (const t of order.slice(1)) {
      const cons: (number[] | null)[] = Array.from({ length: 9 }, () => null);
      const consW = new Array<number>(9).fill(0);
      for (const [o, ko] of rel) {
        const m = rotateCells(mem.get(o)!, ko);
        const n = rotateCells(nEff.get(o)!, ko);
        for (let i = 0; i < 9; i++) {
          const x = m[i];
          if (!x || n[i]! <= 0) continue;
          const acc = cons[i] ?? (cons[i] = new Array<number>(x.length).fill(0));
          for (let c = 0; c < x.length; c++) acc[c]! += n[i]! * x[c]!;
          consW[i]! += n[i]!;
        }
      }
      for (let i = 0; i < 9; i++) if (cons[i]) for (let c = 0; c < cons[i]!.length; c++) cons[i]![c]! /= consW[i]!;
      const scores = [0, 1, 2, 3].map((k) => matchAt(cons, consW, mem.get(t)!, nEff.get(t)!, k).score);
      const ranked = [0, 1, 2, 3].sort((x, y) => scores[y]! - scores[x]!);
      const clear = scores[ranked[0]!]! > 0 && scores[ranked[0]!]! - scores[ranked[1]!]! >= RECONCILE_MARGIN;
      const bt = before(t);
      const ba = before(anchor);
      // colour where it is clear; else the geometric relation; else the merge offset
      const k = clear ? ranked[0]! : bt !== null && ba !== null ? ((bt - ba) % 4 + 4) % 4 : ((g.rotation.get(t)! - g.rotation.get(anchor)!) % 4 + 4) % 4;
      rel.set(t, k);
    }
    // 2. absolute offset by the geometric majority over every track's pairings
    const total = [0, 0, 0, 0];
    for (const [t, k] of rel) {
      const v = g.trackVotes.get(t);
      if (!v) continue;
      for (let d = 0; d < 4; d++) total[d]! += v[(k + d) % 4]!;
    }
    const top = Math.max(...total);
    if (top <= 0) {
      // no geometry: keep the colour alignment as the merge offsets (anchor = reference) for the legality fallback
      g.trackAbs = new Map();
      g.tracks = order;
      g.rotation = new Map(rel);
      g.absRotation = null;
      g.rotationVotes = [0, 0, 0, 0];
      continue;
    }
    const delta = total.indexOf(top);
    for (const [t, k] of rel) {
      const abs = (k + delta) % 4;
      if (g.trackAbs.get(t) !== abs) changed++;
      g.trackAbs.set(t, abs);
    }
    g.rotationVotes = total as [number, number, number, number];
    // the group's own rotation is now redundant with trackAbs; keep it consistent for display
    g.absRotation = (rel.get(g.tracks[0]!)! + delta) % 4;
  }
  return changed;
}

function combine(members: { cells: Aggregate[] }[]): Aggregate[] {
  const out: Aggregate[] = [];
  for (let i = 0; i < 9; i++) {
    let n = 0;
    let v: Vec3 = [0, 0, 0];
    let lab = { L: 0, a: 0, b: 0 };
    let spread = 0;
    for (const m of members) {
      const c = m.cells[i]!;
      if (!c.value || c.nEff <= 0) continue;
      n += c.nEff;
      v = [v[0] + c.nEff * c.value[0], v[1] + c.nEff * c.value[1], v[2] + c.nEff * c.value[2]];
      lab = { L: lab.L + c.nEff * c.lab!.L, a: lab.a + c.nEff * c.lab!.a, b: lab.b + c.nEff * c.lab!.b };
      spread = Math.max(spread, c.spread);
    }
    out.push(n > 0
      ? { value: [v[0] / n, v[1] / n, v[2] / n], lab: { L: lab.L / n, a: lab.a / n, b: lab.b / n }, nEff: n, spread }
      : { value: null, lab: null, nEff: 0, spread: 0 });
  }
  return out;
}

/**
 * Agglomerative grouping in descending signature agreement, honouring the
 * co-visibility veto between any two members. Returns groups ordered by
 * total evidence; letters and absolute rotations are left null for
 * naming.ts.
 */
export function groupTracks(input: GroupingInput): FaceGroup[] {
  const sigs = input.signatures;
  const n = sigs.length;
  const mem = sigs.map((s) => s.cells.map((c) => input.member(c.value)));
  const nEff = sigs.map((s) => s.cells.map((c) => c.nEff));

  const parent = sigs.map((_, i) => i);
  const rot = sigs.map(() => 0); // rotation from this node's order to its parent's order
  const members = sigs.map((_, i) => [i]);
  const find = (i: number): { root: number; k: number } => {
    let k = 0;
    let x = i;
    while (parent[x] !== x) { k += rot[x]!; x = parent[x]!; }
    return { root: x, k: ((k % 4) + 4) % 4 };
  };
  const vetoed = (ra: number, rb: number): boolean => {
    for (const a of members[ra]!) {
      for (const b of members[rb]!) {
        const ta = sigs[a]!.track;
        const tb = sigs[b]!.track;
        if (input.coVisible.has(ta < tb ? `${ta},${tb}` : `${tb},${ta}`)) return true;
      }
    }
    return false;
  };

  const pairs: { i: number; j: number; score: number; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ta = sigs[i]!.track;
      const tb = sigs[j]!.track;
      if (input.coVisible.has(ta < tb ? `${ta},${tb}` : `${tb},${ta}`)) continue;
      // DECISION: when geometry already knows both tracks' absolute rotations
      // the relative one is fixed - layout = rotate(raw_a, ka) = rotate(raw_b,
      // kb), so rotate(raw_b, kb - ka) is raw_a - and colour only says
      // whether they are the same face. A near-symmetric sticker pattern
      // ties the colour match across rotations and merged tracks a quarter
      // turn apart on the phone (scan-debug-1789321540510).
      const ka = input.absRot?.get(ta);
      const kb = input.absRot?.get(tb);
      const forced = ka !== undefined && kb !== undefined ? ((kb - ka) % 4 + 4) % 4 : undefined;
      const m = signatureMatch(mem[i]!, nEff[i]!, mem[j]!, nEff[j]!, forced);
      if (m.score >= input.mergeMin) pairs.push({ i, j, score: m.score, k: m.k });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    const fi = find(p.i);
    const fj = find(p.j);
    if (fi.root === fj.root) continue;
    if (vetoed(fi.root, fj.root)) continue;
    // rotateCells(cells_j, k) is in i's order; i's order + fi.k is ri's order;
    // rj's order is cells_j + fj.k, so rj -> ri is k + fi.k - fj.k.
    parent[fj.root] = fi.root;
    rot[fj.root] = ((p.k + fi.k - fj.k) % 4 + 4) % 4;
    members[fi.root]!.push(...members[fj.root]!);
    members[fj.root] = [];
  }

  const groups: FaceGroup[] = [];
  let id = 0;
  for (let r = 0; r < n; r++) {
    if (parent[r] !== r) continue;
    const rotation = new Map<number, number>();
    const rotated: { cells: Aggregate[] }[] = [];
    const tracks: number[] = [];
    // the root first: its order is the reference
    const order = [r, ...members[r]!.filter((m) => m !== r)];
    for (const m of order) {
      const { k } = find(m);
      rotation.set(sigs[m]!.track, k);
      rotated.push({ cells: rotateCells(sigs[m]!.cells, k) });
      tracks.push(sigs[m]!.track);
    }
    const cells = combine(rotated);
    groups.push({
      id: id++,
      tracks,
      rotation,
      cells,
      nEff: cells.reduce((s, c) => s + c.nEff, 0),
      letter: null,
      absRotation: null,
      trackAbs: new Map(),
      trackVotes: new Map(),
      rotationVotes: [0, 0, 0, 0],
    });
  }
  groups.sort((a, b) => b.nEff - a.nEff);
  groups.forEach((g, i) => { g.id = i; });
  return groups;
}

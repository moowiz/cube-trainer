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
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Best-rotation agreement of two signatures: k such that rotateCells(b, k) matches a. */
export function signatureMatch(
  a: readonly (number[] | null)[], na: readonly number[],
  b: readonly (number[] | null)[], nb: readonly number[],
): { score: number; k: number; cells: number } {
  let best = { score: 0, k: 0, cells: 0 };
  for (let k = 0; k < 4; k++) {
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
    const score = cells >= 3 && den > 0 && centreOk ? num / den : 0;
    if (score > best.score) best = { score, k, cells };
  }
  return best;
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
      const m = signatureMatch(mem[i]!, nEff[i]!, mem[j]!, nEff[j]!);
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
      rotationVotes: [0, 0, 0, 0],
    });
  }
  groups.sort((a, b) => b.nEff - a.nEff);
  groups.forEach((g, i) => { g.id = i; });
  return groups;
}

// Letters last (design 3.10). Two separate decisions live here and must not
// be confused:
//
//   1. which abstract colour is which NAMED colour - only needed to choose a
//      viewing convention (white on top, green in front). Decided from the
//      ORDINAL properties of the six palette centres (least chromatic is
//      white, most negative b is blue, ...), solved as a 6x6 rank assignment
//      so it is always a bijection and never a predicate with an absolute
//      number in it;
//   2. which face GROUP is which letter - a geometric question. Shared-edge
//      pairings between groups say which faces are adjacent and pin every
//      group's absolute rotation; the names are only a prior that breaks the
//      ties geometry leaves (all of them, on a dead-on-only scan). A cube
//      with a non-standard scheme gets the letters its geometry dictates.

import { solveAssignment } from '../color';
import { sharedEdge } from '../detect/orient';
import type { ColorName, FaceId, Lab } from '../types';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';
import type { FaceGroup, Pairing } from './types';

const NAMES: readonly ColorName[] = ['white', 'yellow', 'red', 'orange', 'green', 'blue'];

function ranks(values: readonly (number | null)[], desc: boolean): number[] {
  const idx = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  idx.sort((a, b) => (desc ? b.v! - a.v! : a.v! - b.v!));
  const out = values.map(() => values.length);
  idx.forEach((x, r) => { out[x.i] = r; });
  return out;
}

/**
 * Name the palette colours by rank. White is the least chromatic; the other
 * five are ordered by HUE - blue, red, orange, yellow, green - which is the
 * one ordering that held across every phone session (MEASURED: red at hue
 * 33-45 and orange 44-55 in every session, while "red has the larger a"
 * failed on the kitchen-evening scan where red read (38, 26) and orange
 * (44, 41)). Each colour gets the name whose rank it fits best under a
 * one-to-one assignment; null colours stay null.
 */
export function ordinalNames(lab: readonly (Lab | null)[]): (ColorName | null)[] {
  const n = lab.length;
  const chroma = lab.map((c) => (c ? Math.hypot(c.a, c.b) : null));
  const rChroma = ranks(chroma, false);
  // hue in (-180, 180]: blue lands near -80, red ~35, orange ~48, yellow ~100,
  // green ~150; the least chromatic colour has no meaningful hue and is left
  // out of the hue ranking
  const white = rChroma.indexOf(0);
  const hue = lab.map((c, i) => (c && i !== white ? (Math.atan2(c.b, c.a) * 180) / Math.PI : null));
  const rHue = ranks(hue, false);
  const ORDER: Record<ColorName, number> = { blue: 0, red: 1, orange: 2, yellow: 3, green: 4, white: -1 };
  const cost: number[][] = [];
  for (let c = 0; c < n; c++) {
    if (!lab[c]) { cost.push(NAMES.map(() => 1e3)); continue; }
    cost.push(NAMES.map((name) => (name === 'white' ? rChroma[c]! : c === white ? 10 : Math.abs(rHue[c]! - ORDER[name]))));
  }
  const rowToCol = solveAssignment(cost);
  return lab.map((c, i) => (c ? NAMES[rowToCol[i]!]! : null));
}

/** Letter whose default-scheme colour is `name`. */
export function letterOfName(name: ColorName): FaceId {
  return FACE_ORDER.find((f) => DEFAULT_SCHEME_NAMES[f] === name)!;
}

interface TrackPairing {
  /** tracks and their RAW edges, with the groups they belong to */
  a: number;
  b: number;
  ga: number;
  gb: number;
  ea: number;
  eb: number;
  count: number;
}

/** Pairings between tracks of two different groups, aggregated by (track, edge) pair. */
export function trackPairings(groups: readonly FaceGroup[], pairings: readonly Pairing[]): TrackPairing[] {
  const groupOf = new Map<number, number>();
  for (const g of groups) for (const t of g.tracks) groupOf.set(t, g.id);
  const acc = new Map<string, TrackPairing>();
  for (const p of pairings) {
    const ga = groupOf.get(p.a);
    const gb = groupOf.get(p.b);
    if (ga === undefined || gb === undefined || ga === gb) continue;
    const key = `${p.a},${p.b},${p.edgeA},${p.edgeB}`;
    let e = acc.get(key);
    if (!e) acc.set(key, (e = { a: p.a, b: p.b, ga, gb, ea: p.edgeA, eb: p.edgeB, count: 0 }));
    e.count++;
  }
  return [...acc.values()];
}

export interface LetterResult {
  /** total pairing penalty of the chosen map (non-adjacent letters + rotation contradictions) */
  penalty: number;
  /** name-prior mismatches of the chosen map */
  mismatches: number;
  maps: number;
}

/**
 * Assign letters and absolute rotations to at most six groups. Candidates
 * are the groups with the most evidence; their centre colours are made
 * distinct by assignment. Every injective map is scored: one point per
 * pairing frame that puts non-adjacent letters on the pair or contradicts
 * the TRACK's own majority rotation, plus PRIOR_WEIGHT per group whose
 * colour name disagrees with the default scheme for its letter. Rotation
 * is decided per track from its own pairings (raw edge i on layout edge ia
 * means layout = rotateCells(raw, ia - i)); the group's rotation is the
 * majority of what its paired tracks imply through their merge offsets,
 * and a minority there is a wrong merge, not a wrong letter. Mutates the
 * groups.
 */
export function assignLetters(
  groups: FaceGroup[],
  pairings: readonly Pairing[],
  centreMembership: (g: FaceGroup) => number[] | null,
  names: readonly (ColorName | null)[],
): LetterResult {
  // DECISION: geometry outranks the name prior - one pairing frame outweighs
  // every name mismatch put together (6 * 0.1 < 1) - so a non-standard
  // scheme follows its edges, and the prior only decides what geometry left
  // open.
  const PRIOR_WEIGHT = 0.1;
  for (const g of groups) { g.letter = null; g.absRotation = null; g.trackAbs = new Map(); g.trackVotes = new Map(); g.rotationVotes = [0, 0, 0, 0]; }
  // Which groups are the six faces: an assignment of ALL groups with a
  // centre to the six colours plus "unassigned" columns, each colour taken
  // exactly once. A group pays -log(membership) for a colour and
  // log(1 + evidence) to stay unassigned, so a second orange-centred group
  // yields to the bigger one instead of stealing a colour from the yellow
  // face (scan-debug-1789321540510: six candidates were cut by evidence
  // BEFORE the distinctness rule, and the sixth colour had no face).
  const withCentre = groups.map((g) => ({ g, m: centreMembership(g) })).filter((x) => x.m !== null);
  const colourOf = new Map<number, number>();
  if (withCentre.length) {
    const n = Math.max(withCentre.length, 6);
    const sq: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row = new Array<number>(n).fill(0);
      if (i < withCentre.length) {
        const { g, m } = withCentre[i]!;
        for (let c = 0; c < 6; c++) row[c] = -Math.log(Math.max(m![c]!, 1e-9));
        for (let c = 6; c < n; c++) row[c] = Math.log(1 + g.nEff);
      }
      sq.push(row);
    }
    const rowToCol = solveAssignment(sq);
    withCentre.forEach(({ g }, i) => { const c = rowToCol[i]!; if (c < 6) colourOf.set(g.id, c); });
  }
  const cands = groups.filter((g) => colourOf.has(g.id));
  const centreColour = (g: FaceGroup): number | null => colourOf.get(g.id) ?? null;
  const tp = trackPairings(groups, pairings);

  interface Best { cost: number; letters: FaceId[]; votes: Map<number, number[]>; penalty: number; mismatches: number }
  const found: { best: Best | null } = { best: null };
  let maps = 0;
  const letters: FaceId[] = [];
  const used = new Set<FaceId>();
  const score = (): void => {
    maps++;
    const letterOf = new Map<number, FaceId>();
    cands.forEach((g, i) => letterOf.set(g.id, letters[i]!));
    const votes = new Map<number, number[]>();
    let penalty = 0;
    for (const e of tp) {
      const la = letterOf.get(e.ga);
      const lb = letterOf.get(e.gb);
      if (!la || !lb) continue;
      const se = sharedEdge(la, lb);
      if (!se) { penalty += e.count; continue; }
      for (const [t, k] of [[e.a, ((se.ia - e.ea) % 4 + 4) % 4], [e.b, ((se.jb - e.eb) % 4 + 4) % 4]] as [number, number][]) {
        let v = votes.get(t);
        if (!v) votes.set(t, (v = [0, 0, 0, 0]));
        v[k]! += e.count;
      }
    }
    for (const v of votes.values()) penalty += v.reduce((s, x) => s + x, 0) - Math.max(...v);
    let mismatches = 0;
    cands.forEach((g, i) => {
      const c = centreColour(g);
      const name = c === null ? null : names[c];
      if (name && DEFAULT_SCHEME_NAMES[letters[i]!] !== name) mismatches++;
    });
    const cost = penalty + PRIOR_WEIGHT * mismatches;
    if (!found.best || cost < found.best.cost) found.best = { cost, letters: letters.slice(), votes, penalty, mismatches };
  };
  const rec = (i: number): void => {
    if (i === cands.length) { score(); return; }
    for (const f of FACE_ORDER) {
      if (used.has(f)) continue;
      used.add(f);
      letters[i] = f;
      rec(i + 1);
      used.delete(f);
    }
  };
  rec(0);
  const b = found.best;
  if (!b) return { penalty: 0, mismatches: 0, maps };
  cands.forEach((g, i) => {
    g.letter = b.letters[i]!;
    const groupVotes: [number, number, number, number] = [0, 0, 0, 0];
    for (const t of g.tracks) {
      const v = b.votes.get(t);
      if (!v) continue;
      const top = Math.max(...v);
      const kAbs = v.indexOf(top);
      g.trackAbs.set(t, kAbs);
      g.trackVotes.set(t, v as [number, number, number, number]);
      // layout = rotate(raw, kAbs) = rotate(rotate(raw, k_T), K)  =>  K = kAbs - k_T
      groupVotes[((kAbs - g.rotation.get(t)!) % 4 + 4) % 4] += top;
    }
    g.rotationVotes = groupVotes;
    const top = Math.max(...groupVotes);
    g.absRotation = top > 0 ? groupVotes.indexOf(top) : null;
  });
  return { penalty: b.penalty, mismatches: b.mismatches, maps };
}

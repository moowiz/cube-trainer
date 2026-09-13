// The solve (design section 2): a pure function of the evidence log.
//
//   aggregate per track-cell -> fit palette -> group tracks into faces ->
//   letters and rotations -> 54x6 costs -> exact constrained decode ->
//   refit palette from the constrained assignment, refit illumination ->
//   repeat -> certificates -> lock policy.
//
// The objective minimised end to end is the decoder's total cost: a palette
// in which red has swallowed orange cannot satisfy nine of each and is
// rejected by the constraint that used to be the fallback.

import { validateState, rotateCells } from '../state';
import type { FaceId, Lab } from '../types';
import { FACE_ORDER } from '../types';
import { DEFAULT_EMBEDDING, LAB_CRUSHED, LAB_HALF, LOGCHROMA, type Embedding } from './colorspace';
import { coloursToFacelets, decode } from './decode';
import { aggregateTracks, coVisible } from './evidence';
import { groupTracks, reconcileRotations } from './faces';
import { fitFrameGains, type Gains } from './illum';
import { assignLetters, ordinalNames } from './naming';
import { farthestPointSeeds, fitPalette, memberships, studentLogLik } from './palette';
import { dist3, robustCentre, weightedMedian } from './robust';
import type { Aggregate, DecodeResult, EvidenceLog, FaceGroup, Palette, Solution, SolveParams, TrackSignature, Vec3 } from './types';

export const DEFAULT_PARAMS: SolveParams = {
  // DECISION: starting points from the design; the lock gates are to be
  // calibrated on evidence-log fixtures with the no-wrong-lock rule first.
  nSat: 12,
  // DECISION: a sticker glimpsed once at a glancing angle (nEff 0.1-0.5)
  // is not evidence, it is a junk row that sends the legality search
  // flailing for a second per solve (both first-day phone captures spent
  // 100+ frames there). Below 1 the pieces decide the slot instead.
  freeBelow: 1,
  nMin: 6,
  kMax: 4,
  deltaMin: 3,
  marginMin: 1,
  nu: 3,
  gainPrior: 10,
  gainMax: 15,
  mergeMin: 0.6,
  rounds: 3,
};

const SIGMA_FLOOR = 2;
/** Cost of a colour with no centre (the softmax gives it probability 0). */
const COST_CAP = 30;

function paletteLab(sigs: readonly TrackSignature[], labelOf: (t: number, cell: number) => number | null): (Lab | null)[] {
  const L: number[][] = Array.from({ length: 6 }, () => []);
  const A: number[][] = Array.from({ length: 6 }, () => []);
  const B: number[][] = Array.from({ length: 6 }, () => []);
  const W: number[][] = Array.from({ length: 6 }, () => []);
  for (const s of sigs) {
    s.cells.forEach((c, k) => {
      if (!c.lab || c.nEff <= 0) return;
      const l = labelOf(s.track, k);
      if (l === null || l < 0 || l >= 6) return;
      L[l]!.push(c.lab.L); A[l]!.push(c.lab.a); B[l]!.push(c.lab.b); W[l]!.push(c.nEff);
    });
  }
  return L.map((ls, c) => (ls.length ? { L: weightedMedian(ls, W[c]!), a: weightedMedian(A[c]!, W[c]!), b: weightedMedian(B[c]!, W[c]!) } : null));
}

interface SlotEvidence {
  /** per slot: the aggregates feeding it */
  members: { track: number; cell: number; agg: Aggregate }[][];
}

/** Which slot each (track, cell) lands in under the current letters and rotations. */
function slotMap(groups: readonly FaceGroup[], sigs: readonly TrackSignature[]): { slotOf: Map<string, number>; ev: SlotEvidence } {
  const slotOf = new Map<string, number>();
  const members: SlotEvidence['members'] = Array.from({ length: 54 }, () => []);
  const sigOf = new Map(sigs.map((s) => [s.track, s]));
  for (const g of groups) {
    if (!g.letter) continue;
    const fi = FACE_ORDER.indexOf(g.letter);
    const K = g.absRotation ?? 0;
    for (const t of g.tracks) {
      const s = sigOf.get(t)!;
      const k = g.rotation.get(t)!;
      // A track paired in some frame knows its own absolute rotation and
      // uses it; an unpaired one is carried by the group (merge offset plus
      // the group's rotation). rotateCells maps out[i] = in[ROT3[k][i]], so
      // rotating the index list gives, per layout slot, the raw cell in it.
      const own = g.trackAbs.get(t);
      const idx = own !== undefined ? rotateCells([0, 1, 2, 3, 4, 5, 6, 7, 8], own) : rotateCells(rotateCells([0, 1, 2, 3, 4, 5, 6, 7, 8], k), K);
      for (let i = 0; i < 9; i++) {
        const raw = idx[i]!;
        const slot = fi * 9 + i;
        slotOf.set(`${t}:${raw}`, slot);
        const agg = s.cells[raw]!;
        if (agg.value && agg.nEff > 0) members[slot]!.push({ track: t, cell: raw, agg });
      }
    }
  }
  return { slotOf, ev: { members } };
}

function costMatrix(ev: SlotEvidence, palette: Palette, nu: number, freeBelow: number): { cost: number[][]; nEff: number[]; lab: (Lab | null)[] } {
  const cost: number[][] = [];
  const nEff: number[] = [];
  const lab: (Lab | null)[] = [];
  for (let s = 0; s < 54; s++) {
    const ms = ev.members[s]!;
    const E = new Array<number>(6).fill(0);
    let n = 0;
    let L = 0, A = 0, B = 0;
    for (const { agg } of ms) {
      n += agg.nEff;
      L += agg.nEff * agg.lab!.L; A += agg.nEff * agg.lab!.a; B += agg.nEff * agg.lab!.b;
      for (let c = 0; c < 6; c++) {
        const p = palette.centres[c];
        E[c] += p ? agg.nEff * studentLogLik(dist3(agg.value!, p), palette.sigma[c]!, nu) : -Infinity;
      }
    }
    nEff.push(n);
    lab.push(n > 0 ? { L: L / n, a: A / n, b: B / n } : null);
    if (n < freeBelow) { cost.push(new Array<number>(6).fill(0)); continue; }
    const m = Math.max(...E);
    const Z = E.reduce((z, e) => z + (e === -Infinity ? 0 : Math.exp(e - m)), 0);
    cost.push(E.map((e) => (e === -Infinity ? COST_CAP : Math.min(COST_CAP, -(e - m - Math.log(Z))))));
  }
  return { cost, nEff, lab };
}

/**
 * Groups that were never paired have no absolute rotation. Search the
 * quarter turns of those faces for the (unique, fewest-turn) combination
 * under which the balanced colouring is a real cube; today's dead-on-only
 * behaviour (state.ts resolveByRotation), restricted to the unknown faces.
 */
function resolveUnknownRotations(groups: FaceGroup[], colours: readonly number[]): void {
  const unknown = groups.filter((g) => g.letter && g.absRotation === null);
  if (!unknown.length) return;
  const base = coloursToFacelets(colours);
  const faces = FACE_ORDER.map((_, fi) => base.slice(fi * 9, fi * 9 + 9).split(''));
  const fis = unknown.map((g) => FACE_ORDER.indexOf(g.letter!));
  let best: { turns: number[]; changed: number } | null = null;
  let tie = false;
  const total = 1 << (2 * fis.length);
  for (let code = 0; code < total; code++) {
    const turns = fis.map((_, i) => (code >> (2 * i)) & 3);
    const changed = turns.filter((t) => t !== 0).length;
    if (best && changed > best.changed) continue;
    const f = faces.map((c) => c.slice());
    fis.forEach((fi, i) => { f[fi] = rotateCells(faces[fi]!, turns[i]!); });
    if (!validateState(f.map((c) => c.join('')).join('')).ok) continue;
    if (best && changed === best.changed) { tie = true; continue; }
    best = { turns, changed };
    tie = false;
  }
  if (!best || tie) return;
  // rotating the letters of face fi by t means the layout order is the
  // reference order turned by t: absRotation += t
  unknown.forEach((g, i) => { g.absRotation = best!.turns[i]!; });
}

export interface SolveOptions {
  embedding?: Embedding;
  params?: Partial<SolveParams>;
  /** Skip the legality search (balanced optimum only); for bake-offs. */
  quick?: boolean;
}

export function solve(log: EvidenceLog, opts: SolveOptions = {}): Solution {
  const t0 = performance.now();
  const embedding = opts.embedding ?? DEFAULT_EMBEDDING;
  const P: SolveParams = { ...DEFAULT_PARAMS, ...opts.params };
  const covis = coVisible(log);
  let gains: Gains = new Map();
  let seeds: (Vec3 | null)[] | undefined;

  let groups: FaceGroup[] = [];
  let palette: Palette = { centres: [null, null, null, null, null, null], sigma: [1, 1, 1, 1, 1, 1], lab: [null, null, null, null, null, null] };
  let result: DecodeResult | null = null;
  let nEff: number[] = new Array<number>(54).fill(0);
  let slotLab: (Lab | null)[] = new Array<Lab | null>(54).fill(null);
  let balancedFacelets: string | null = null;
  // absolute rotations the previous round's pairings established, so the
  // next grouping aligns paired tracks by geometry rather than by colour
  let knownAbs = new Map<number, number>();

  for (let round = 0; round < P.rounds; round++) {
    const last = round === P.rounds - 1;
    const sigs: TrackSignature[] = aggregateTracks(log, embedding, gains, P.nSat);
    const points: { x: Vec3; w: number; track: number; cell: number }[] = [];
    for (const s of sigs) s.cells.forEach((c, k) => { if (c.value && c.nEff > 0) points.push({ x: c.value, w: c.nEff, track: s.track, cell: k }); });
    if (!points.length) break;

    // 1. free fit, seeded by the previous constrained refit or, the first
    //    time, by farthest-point over the CENTRE cells only: tracks of one
    //    face land on the same point, so six faces seen means six colours
    //    seeded, and no glare-struck outer sticker can found a colour
    if (!seeds) {
      const centres = sigs.filter((s) => s.cells[4]!.value && s.cells[4]!.nEff > 0);
      seeds = farthestPointSeeds(centres.map((s) => s.cells[4]!.value!), centres.map((s) => s.cells[4]!.nEff), 6);
    }
    const fit = fitPalette(points, 6, { seeds, nu: P.nu, sigmaFloor: SIGMA_FLOOR });
    // a point whose cluster died (total weight under minWeight, early in a
    // session when every reading still carries a low quality weight) has
    // label -1 and belongs to no colour
    const labelByKey = new Map<string, number>();
    points.forEach((p, i) => { const l = fit.labels[i]!; if (l >= 0) labelByKey.set(`${p.track}:${p.cell}`, l); });
    palette = { centres: fit.centres, sigma: fit.sigma, lab: paletteLab(sigs, (t, k) => labelByKey.get(`${t}:${k}`) ?? null) };
    const member = (x: Vec3 | null) => (x ? memberships(x, palette, P.nu) : null);

    // 2. faces
    groups = groupTracks({ signatures: sigs, member, coVisible: covis, mergeMin: P.mergeMin, absRot: knownAbs });
    assignLetters(groups, log.pairings, (g) => member(g.cells[4]!.value), ordinalNames(palette.lab));
    reconcileRotations(groups, sigs, member);
    knownAbs = new Map();
    for (const g of groups) for (const [t, k] of g.trackAbs) knownAbs.set(t, k);

    // 3. costs and decode; the legality search only on the final round -
    //    rotation does not change which colour an aggregate is, only which
    //    slot it sits in, and the refit needs only the colours
    let { ev } = slotMap(groups, sigs);
    let cm = costMatrix(ev, palette, P.nu, P.freeBelow);
    const legalAll = () => true;
    // The legality search is only meaningful with six lettered faces: with
    // fewer, most rows are free and the search burns its whole budget on a
    // flat cost surface (13 s on a one-quad log). Before that the balanced
    // optimum is the answer and the reason says how many faces are missing.
    // ... or five, with at most one face's worth of unseen stickers: the
    // decoder completes those from the pieces (complete.ts) and says
    // whether they were forced. More unseen than that and the search would
    // wander a flat cost surface (400-900 ms per solve on the first phone
    // session while two faces had barely been shown).
    const freeNow = cm.nEff.filter((n) => n < P.freeBelow).length;
    const complete = groups.filter((g) => g.letter).length >= 5 && freeNow <= 9;
    if (last && !opts.quick && complete) {
      const balanced = decode(cm.cost, legalAll);
      balancedFacelets = balanced.colours ? coloursToFacelets(balanced.colours) : null;
      if (balanced.colours) resolveUnknownRotations(groups, balanced.colours);
      ({ ev } = slotMap(groups, sigs));
      cm = costMatrix(ev, palette, P.nu, P.freeBelow);
      // DECISION: 6k/3k pops is ~500 ms on a desktop for a search that
      // fails, a second or two in the phone's worker; a cube that needs
      // more is a cube whose evidence is not there yet
      result = decode(cm.cost, (cols) => validateState(coloursToFacelets(cols)).ok, { maxPops: 6000, secondPops: 3000 });
    } else {
      result = decode(cm.cost, legalAll);
    }
    nEff = cm.nEff;
    slotLab = cm.lab;
    const colours = result.colours ?? result.argmin;

    // 4. constrained refit: each colour's centre from the aggregates that
    //    landed in its nine slots
    const pts: { x: Vec3; w: number }[][] = Array.from({ length: 6 }, () => []);
    const slotColour = new Map<string, number>();
    for (let s = 0; s < 54; s++) {
      for (const { track, cell, agg } of ev.members[s]!) {
        pts[colours[s]!]!.push({ x: agg.value!, w: agg.nEff });
        slotColour.set(`${track}:${cell}`, colours[s]!);
      }
    }
    seeds = pts.map((ps) => {
      if (!ps.length) return null;
      const rc = robustCentre(ps.map((p) => p.x), ps.map((p) => p.w));
      return rc.value;
    });
    if (seeds.some(Boolean)) {
      const sigma = pts.map((ps, c) => {
        if (!ps.length || !seeds![c]) return SIGMA_FLOOR;
        const rc = robustCentre(ps.map((p) => p.x), ps.map((p) => p.w));
        return Math.max(SIGMA_FLOOR, rc.spread);
      });
      palette = { centres: seeds, sigma, lab: paletteLab(sigs, (t, k) => slotColour.get(`${t}:${k}`) ?? null) };
    }

    // 5. illumination
    if (!last) gains = fitFrameGains(log, embedding, palette, (t, k) => slotColour.get(`${t}:${k}`) ?? null, P.gainPrior, P.gainMax);
  }

  const lettered = groups.filter((g) => g.letter);
  const colourLetter: (FaceId | null)[] = [null, null, null, null, null, null];
  let facelets: string | null = null;
  const slotLetter: (FaceId | null)[] = new Array<FaceId | null>(54).fill(null);
  if (result?.colours) {
    facelets = coloursToFacelets(result.colours);
    for (let s = 0; s < 54; s++) slotLetter[s] = facelets[s] as FaceId;
    [4, 13, 22, 31, 40, 49].forEach((slot, fi) => { colourLetter[result!.colours![slot]!] = FACE_ORDER[fi]!; });
  }
  const minN = Math.min(...nEff);
  const weakest = FACE_ORDER[Math.floor(nEff.indexOf(minN) / 9)]!;
  // the colour word for a letter: from the decode when there is one, else
  // from the group's centre against the palette
  const weakestName = (() => {
    let c = colourLetter.indexOf(weakest);
    if (c < 0) {
      const g = groups.find((x) => x.letter === weakest);
      const m = g?.cells[4]!.value ? memberships(g.cells[4]!.value, palette, P.nu) : null;
      if (m) c = m.indexOf(Math.max(...m));
    }
    return (c >= 0 ? ordinalNames(palette.lab)[c] : null) ?? weakest;
  })();
  const minMargin = result ? Math.min(...result.margins) : 0;
  let reason = 'ok';
  if (!result) reason = 'no evidence';
  else if (lettered.length < 5) reason = `${lettered.length}/6 faces seen`;
  else if (result.free > 9) reason = `show the ${weakestName} face (${weakest}): ${result.free} stickers unseen`;
  else if (result.completion === 'ambiguous') reason = `show the ${weakestName} face (${weakest}): its ${result.free} unseen stickers are not forced by the pieces`;
  else if (result.completion === 'none') reason = `show the ${weakestName} face (${weakest}): no cube completes its ${result.free} unseen stickers`;
  else if (!result.legal) reason = 'no legal cube within budget';
  else if (result.changed > P.kMax) reason = `${result.changed} stickers moved from their nearest colour (max ${P.kMax})`;
  else if (result.delta < P.deltaMin) reason = `runner-up cube only ${result.delta.toFixed(1)} worse (need ${P.deltaMin})`;
  else if (minMargin < P.marginMin) reason = `a sticker is within ${minMargin.toFixed(1)} of another colour (need ${P.marginMin})`;
  return {
    facelets: result?.legal ? facelets : null,
    decode: result,
    nEff,
    slotLab,
    slotLetter,
    palette,
    colourLetter,
    groups,
    centresSeen: lettered.length,
    lockable: reason === 'ok',
    reason,
    embedding: embedding.name,
    ms: performance.now() - t0,
    gains,
    balanced: balancedFacelets,
  };
}

// DECISION 2026-09-13: no single colour space survived the third phone
// capture - logchroma separates yellow from green under a blue cast where
// every Lab weighting collapses them, lab-crushed separates red from orange
// where logchroma does not, and L at 0.5 alone solves the blue-monitor scan.
// So the solve runs in all three and the certificate chooses: legal first,
// then the largest delta, then the fewest changes. Three solves in the
// worker cost a few hundred ms; a wrong space costs a session.
export const ENSEMBLE: Embedding[] = [LAB_CRUSHED, LOGCHROMA, LAB_HALF];

export function solveBest(log: EvidenceLog, embeddings: readonly Embedding[] = ENSEMBLE, opts: Omit<SolveOptions, 'embedding'> = {}): Solution {
  const t0 = performance.now();
  // 1. a cheap balanced-only pass per space ranks them: fewest stickers the
  //    counts had to move, then the widest minimum margin. The legality
  //    search is the expensive part (a failing one burns its whole budget)
  //    and it runs only where the balanced optimum looks close.
  const quick = embeddings.map((embedding) => ({ embedding, s: solve(log, { ...opts, embedding, quick: true }) }));
  const key = (x: Solution): [number, number] => [x.decode?.changed ?? 99, x.decode ? -Math.min(...x.decode.margins) : 0];
  quick.sort((a, b) => { const ka = key(a.s); const kb = key(b.s); return ka[0] - kb[0] || ka[1] - kb[1]; });
  // 2. full solves in that order, stopping at the first lock; at most two,
  //    because a failing legality search costs its whole budget and the
  //    third-ranked space has never been the one that locked
  let best: Solution | null = null;
  let full = 0;
  const rank = (x: Solution): number[] => [x.lockable ? 1 : 0, x.decode?.legal ? 1 : 0, x.decode ? (x.decode.delta === Infinity ? 1e9 : x.decode.delta) : -1, -(x.decode?.changed ?? 99), x.centresSeen];
  for (const { embedding } of quick) {
    if (full++ >= 2) break;
    const s = solve(log, { ...opts, embedding });
    if (!best) best = s;
    else {
      const a = rank(s);
      const b = rank(best);
      for (let i = 0; i < a.length; i++) {
        if (a[i]! === b[i]!) continue;
        if (a[i]! > b[i]!) best = s;
        break;
      }
    }
    if (s.lockable) break;
  }
  best!.ms = performance.now() - t0;
  return best!;
}

// The move reader (design 2.3, 2.4, 0.1): a beam Viterbi decoder over the
// anchored frames. The hidden state is the cube; between two sampled
// frames it either stays (cost 0) or takes one turn (MOVE_COST), or a
// burst of two or three when one frame interval swallowed a fast pair or
// the cube was out of view. The emission is the frame's anchored evidence
// under the state (anchor.ts). Epochs are not segmented first: the path
// that minimises evidence + turns IS the segmentation, so a hand passing
// over a face costs every hypothesis the same and settles to "no move",
// and a turn is placed at the frame boundary where the evidence flips.
//
// Incremental by construction: push() extends the beam by one frame in a
// fraction of a millisecond, so the same reader runs live in the solve
// worker and offline over a recording; record() reads the current best
// path (optionally the one ending in a known end state) at any time.

import { Anchorer, frameCost, type AnchorModel, type AnchorParams, type Commitments, type FrameObs } from './anchor';
import { applyMoveIdx, canonicalSeqs, commute, MOVES, PERM, type Move } from './moves';
import type { MoveRecord, RecordItem } from './record';
import type { EvidenceLog, Pairing, QuadObs } from '../colour/types';
import { FACE_ORDER } from '../types';

export interface ReaderParams {
  /** Cost of one face turn, nats: the evidence a move must beat. */
  moveCost: number;
  /** Extra cost of a transition carrying more than one turn. */
  burstExtra: number;
  /** States kept per frame. */
  beam: number;
  /** The top this-many beam entries are also expanded by two-turn bursts. */
  depth2From: number;
  /** Three-turn bursts from the leader when the frame gap exceeds this (ms)... */
  depth3GapMs: number;
  /** ...or when the best candidate's mean cost per unit weight exceeds this (the frame is unexplained). */
  badFit: number;
  /** A recorded turn is `sure` when its epoch's margin clears this and a later frame confirmed it. */
  marginMin: number;
}

const DEFAULT_READER: ReaderParams = {
  // DECISION: starting points; calibrated on test/moves-synthetic.test.ts
  // and the recorded solves. A true turn changes ~8 visible stickers at a
  // few nats each per frame, so 6 nats is under one frame of evidence;
  // a finger has to fake a whole move's worth of wrong stickers to buy one.
  moveCost: 6,
  burstExtra: 3,
  beam: 24,
  depth2From: 4,
  depth3GapMs: 500,
  badFit: 2.5,
  marginMin: 3,
};

/** One node of the Viterbi trellis. */
export interface Entry {
  state: Uint8Array;
  key: string;
  /** Path cost up to and including this frame. */
  cost: number;
  /** Emission at this frame. */
  em: number;
  prev: Entry | null;
  /** Turns applied between the previous frame and this one. */
  via: readonly Move[];
  /** Index into the reader's frames. */
  i: number;
}

/** Per-frame diagnostics, printed by the tests and the debug panel. */
export interface FrameTrace {
  frame: number;
  t: number;
  dt: number;
  /** Faces anchored this frame: letter, 'g' when the face came from geometry, the rotation's source ('.' pairing, ',' fit, '?' free), and the reliability in ninths when under 1. */
  faces: string;
  /** Total reading weight in the frame. */
  sumW: number;
  /** Cells the outlier class claimed. */
  outliers: number;
  /** Quads dropped and why. */
  dropped: string;
  /** The chromatic shift removed from the frame and the inlier share behind it. */
  shift: string;
  /** The leader after this frame: its path cost, emission, and the turns it took to get here (if any). */
  best: { cost: number; em: number; via: string };
  /** Cost gap to the best other state in the beam. */
  margin: number;
  /** Mean emission per unit weight of the leader (fit quality; badFit marks it unexplained). */
  fit: number;
  /** Candidates scored and the deepest burst tried. */
  expanded: number;
  depth: number;
  ms: number;
}

const SEQS2 = canonicalSeqs(2);
const SEQS3 = canonicalSeqs(3);

function seqPerm(seq: readonly Move[]): Uint8Array {
  let perm = Uint8Array.from({ length: 54 }, (_, i) => i);
  for (const m of seq) {
    const p = PERM[m];
    perm = Uint8Array.from({ length: 54 }, (_, i) => perm[p[i]!]!);
  }
  return perm;
}
const PERM1 = MOVES.map((m) => seqPerm([m]));
const PERM2 = SEQS2.map(seqPerm);
const PERM3 = SEQS3.map(seqPerm);

function keyOf(s: Uint8Array): string {
  let k = '';
  for (let i = 0; i < 54; i++) k += FACE_ORDER[s[i]!]!;
  return k;
}

function toIdx(facelets: string): Uint8Array {
  return Uint8Array.from(facelets, (ch) => FACE_ORDER.indexOf(ch as (typeof FACE_ORDER)[number]));
}

export class MoveReader {
  readonly P: ReaderParams;
  readonly M: AnchorModel;
  readonly frames: FrameObs[] = [];
  /** The beam after each frame, sorted by cost. */
  readonly beams: Entry[][] = [];
  readonly trace: FrameTrace[] = [];
  private beam: Entry[];
  readonly start: string;
  /** Total time spent in push(), ms. */
  ms = 0;

  constructor(start: string, model: AnchorModel, params: Partial<ReaderParams> = {}) {
    this.P = { ...DEFAULT_READER, ...params };
    this.M = model;
    this.start = start;
    const s = toIdx(start);
    this.beam = [{ state: s, key: start, cost: 0, em: 0, prev: null, via: [], i: -1 }];
  }

  /** Extend the trellis by one anchored frame. Frames with nothing anchored are skipped (they still widen the next gap). */
  push(f: FrameObs): void {
    if (!f.quads.length) return;
    const t0 = performance.now();
    const P = this.P;
    const i = this.frames.length;
    const prevT = i > 0 ? this.frames[i - 1]!.t : f.t;
    const dt = f.t - prevT;
    this.frames.push(f);

    const cands = new Map<string, Entry>();
    const emCache = new Map<string, number>();
    let expanded = 0;
    const consider = (state: Uint8Array, prev: Entry, via: readonly Move[], trans: number): Entry => {
      const key = keyOf(state);
      let em = emCache.get(key);
      if (em === undefined) { em = frameCost(state, f); emCache.set(key, em); expanded++; }
      const cost = prev.cost + trans + em;
      const have = cands.get(key);
      if (have && have.cost <= cost) return have;
      const e: Entry = { state, key, cost, em, prev, via, i };
      cands.set(key, e);
      return e;
    };
    const apply = (s: Uint8Array, perm: Uint8Array): Uint8Array => {
      const out = new Uint8Array(54);
      for (let j = 0; j < 54; j++) out[j] = s[perm[j]!]!;
      return out;
    };
    let depth = 1;
    this.beam.forEach((e, rank) => {
      consider(e.state, e, [], 0);
      for (let m = 0; m < 18; m++) consider(apply(e.state, PERM1[m]!), e, [MOVES[m]!], P.moveCost);
      if (rank < P.depth2From) {
        depth = 2;
        for (let j = 0; j < SEQS2.length; j++) consider(apply(e.state, PERM2[j]!), e, SEQS2[j]!, 2 * P.moveCost + P.burstExtra);
      }
    });
    let sumW = 0;
    let outliers = 0;
    for (const q of f.quads) { sumW += q.sumW; for (let c = 0; c < 9; c++) outliers += q.outlier[c]!; }
    let sorted = [...cands.values()].sort((a, b) => a.cost - b.cost);
    const fitOf = (e: Entry) => (sumW > 0 ? e.em / sumW : 0);
    if (dt > P.depth3GapMs || fitOf(sorted[0]!) > P.badFit) {
      depth = 3;
      const lead = this.beam[0]!;
      for (let j = 0; j < SEQS3.length; j++) consider(apply(lead.state, PERM3[j]!), lead, SEQS3[j]!, 3 * P.moveCost + P.burstExtra);
      sorted = [...cands.values()].sort((a, b) => a.cost - b.cost);
    }
    this.beam = sorted.slice(0, P.beam);
    this.beams.push(this.beam);
    const best = this.beam[0]!;
    const ms = performance.now() - t0;
    this.ms += ms;
    this.trace.push({
      frame: f.frame,
      t: f.t,
      dt,
      faces: f.quads.map((q) => `${FACE_ORDER[q.face]}${q.faceFrom === 'geometry' ? 'g' : ''}${q.kFrom === 'pairing' ? '.' : q.kFrom === 'fit' ? ',' : '?'}${q.reliability < 0.99 ? Math.round(q.reliability * 9) : ''}`).join(''),
      sumW,
      outliers,
      dropped: f.dropped.map((d) => `#${d.track} ${d.why}`).join('; '),
      shift: `${f.shift[0].toFixed(0)},${f.shift[1].toFixed(0)} ${(f.shiftInliers * 100).toFixed(0)}%`,
      best: { cost: best.cost, em: best.em, via: best.via.join(' ') },
      margin: this.beam.length > 1 ? this.beam[1]!.cost - best.cost : Infinity,
      fit: fitOf(best),
      expanded,
      depth,
      ms,
    });
  }

  /** The leader's path so far. */
  get leader(): Entry {
    return this.beam[0]!;
  }

  /** Turns every path in the beam agrees on (stable for live display); the rest of the leader's path is tentative. */
  committed(): Move[] {
    // the latest entry that is an ancestor of every beam entry
    const ancestors = new Set<Entry>();
    for (let e: Entry | null = this.beam[0]!; e; e = e.prev) ancestors.add(e);
    let common: Entry | null = null;
    for (const b of this.beam.slice(1)) {
      let e: Entry | null = b;
      while (e && !ancestors.has(e)) e = e.prev;
      if (e && (!common || e.i < common.i)) common = e;
    }
    if (this.beam.length === 1) common = this.beam[0]!;
    const out: Move[] = [];
    if (!common) return out;
    for (let e: Entry | null = common; e; e = e.prev) out.unshift(...e.via);
    return out;
  }

  /**
   * The record of the best path - the one ending in `end` when given and
   * present in the beam (the offline decoder knows both endpoints), else
   * the leader. Where the path put a transition is arbitrary within the
   * frames that cannot tell the two states apart, so each move's time
   * window is re-derived from the evidence: t0 is the last frame that
   * showed the cube without it, t1 the first that showed it with it, and
   * transitions whose windows overlap are one burst.
   */
  record(end?: string): MoveRecord {
    const P = this.P;
    const best = this.beam[0]!;
    let chosen = best;
    let endMatches: boolean | null = null;
    if (end !== undefined) {
      const e = this.beam.find((x) => x.key === end);
      endMatches = e !== undefined;
      if (e) chosen = e;
    }
    const path: Entry[] = [];
    for (let e: Entry | null = chosen; e; e = e.prev) path.unshift(e);
    // path[0] is the root (i = -1); path[j] for j >= 1 sits at frame j - 1
    const stateAt = (fi: number): Uint8Array => path[fi + 1]!.state;
    const n = this.frames.length;
    const EPS = 0.5;
    const favours = (fi: number, a: Uint8Array, b: Uint8Array): boolean => frameCost(a, this.frames[fi]!) < frameCost(b, this.frames[fi]!) - EPS;
    // The certificate of an epoch: the cheapest COMPLETE path in the final
    // beam that was in a different state at the epoch's last frame, minus
    // the chosen path (all evidence counted, the future included - the
    // beam at that frame alone would say "unsure" of a turn that later
    // frames settled). No such path in the beam: at least as good as the
    // worst path kept, if anything was pruned at all.
    const keyAt = new Map<Entry, string[]>();
    for (const b of this.beam) {
      const keys = new Array<string>(n);
      for (let e: Entry | null = b; e && e.i >= 0; e = e.prev) keys[e.i] = e.key;
      keyAt.set(b, keys);
    }
    const worst = this.beam.length >= P.beam ? this.beam[this.beam.length - 1]!.cost - chosen.cost : Infinity;
    const marginAt = (e: Entry): number => {
      let m = worst;
      for (const b of this.beam) if (b !== chosen && keyAt.get(b)![e.i] !== e.key) m = Math.min(m, b.cost - chosen.cost);
      return m;
    };
    interface Trans { j: number; via: readonly Move[]; j0: number; j1: number; margin: number }
    const trans: Trans[] = [];
    for (let j = 1; j < path.length; j++) {
      const e = path[j]!;
      if (!e.via.length) continue;
      const i = e.i;
      // backwards: the move applied early - until a frame shows the cube without it
      let j0 = i - 1;
      const withVia = (s: Uint8Array): Uint8Array => { let t = s; for (const m of e.via) t = applyMoveIdx(t, m); return t; };
      while (j0 >= 0 && !favours(j0, stateAt(j0), withVia(stateAt(j0)))) j0--;
      // forwards: the move left out of the path - until a frame shows the cube with it
      let alt = path[j - 1]!.state;
      let j1 = i;
      for (let k = j; k < path.length; k++) {
        const f = path[k]!;
        if (k > j) for (const m of f.via) alt = applyMoveIdx(alt, m);
        if (favours(f.i, f.state, alt)) { j1 = f.i; break; }
        j1 = n; // not confirmed by any frame yet
      }
      // the epoch this transition opens ends at the last frame before the next transition
      let last = e;
      for (let k = j + 1; k < path.length && !path[k]!.via.length; k++) last = path[k]!;
      trans.push({ j: i, via: e.via, j0, j1, margin: marginAt(last) });
    }
    const items: RecordItem[] = [];
    const tOf = (fi: number): number => (fi < 0 ? this.frames[0]!.t : fi >= n ? this.frames[n - 1]!.t : this.frames[fi]!.t);
    for (let a = 0; a < trans.length;) {
      let b = a;
      // overlapping windows: no frame separates the two transitions
      while (b + 1 < trans.length && trans[b + 1]!.j0 < trans[a]!.j1) b++;
      const group = trans.slice(a, b + 1);
      const moves = group.flatMap((t) => [...t.via]);
      const j0 = Math.min(...group.map((t) => t.j0));
      const j1 = Math.max(...group.map((t) => t.j1));
      const margin = Math.min(...group.map((t) => t.margin));
      const sure = margin >= P.marginMin && j1 < n;
      if (moves.length === 1) items.push({ kind: 'move', move: moves[0]!, t0: tOf(j0), t1: tOf(j1), margin, sure });
      else {
        let ordered = true;
        for (let k = 1; k < moves.length; k++) if (commute(moves[k - 1]!, moves[k]!)) ordered = false;
        items.push({ kind: 'burst', moves, t0: tOf(j0), t1: tOf(j1), margin, sure, ordered });
      }
      a = b + 1;
    }
    let margin = Infinity;
    for (const b of this.beam) if (b.key !== chosen.key) margin = Math.min(margin, b.cost - chosen.cost);
    return {
      start: this.start,
      items,
      end: chosen.key,
      endMatches,
      margin,
      frames: n,
      t0: this.frames[0]?.t ?? 0,
      t1: this.frames[n - 1]?.t ?? 0,
    };
  }
}

/**
 * Forced alignment: the moves are given (a fixture's truth) and only their
 * timing is decoded - the best placement of the sequence over the frames,
 * one to three turns per frame boundary. The calibration tool: with the
 * truth timing known, every frame can be asked how well it fits the truth
 * against the truth's single-move neighbours.
 */
export function forcedAlignment(frames: readonly FrameObs[], start: string, moves: readonly Move[], params: Partial<ReaderParams> = {}): { at: number[]; cost: number; states: Uint8Array[] } {
  const P = { ...DEFAULT_READER, ...params };
  const states: Uint8Array[] = [toIdx(start)];
  for (const m of moves) states.push(applyMoveIdx(states[states.length - 1]!, m));
  const n = frames.length;
  const K = states.length;
  // dp[k] = best cost with the cube in state k at the current frame
  let dp = new Array<number>(K).fill(Infinity);
  dp[0] = 0;
  const back: Int16Array[] = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    const em = states.map((st) => frameCost(st, f));
    const next = new Array<number>(K).fill(Infinity);
    const bk = new Int16Array(K).fill(-1);
    for (let k = 0; k < K; k++) {
      for (let d = 0; d <= 3 && k - d >= 0; d++) {
        const prev = dp[k - d]!;
        if (prev === Infinity) continue;
        const c = prev + (d === 0 ? 0 : d * P.moveCost + (d > 1 ? P.burstExtra : 0)) + em[k]!;
        if (c < next[k]!) { next[k] = c; bk[k] = k - d; }
      }
    }
    dp = next;
    back.push(bk);
  }
  // the sequence must be complete at the end
  const at = new Array<number>(n).fill(0);
  let k = K - 1;
  for (let i = n - 1; i >= 0; i--) { at[i] = k; k = back[i]![k]!; }
  return { at, cost: dp[K - 1]!, states };
}

export interface ReadOptions {
  fromT?: number;
  toT?: number;
  /** The state the solve ended in, when known (solved, or a later lock). */
  end?: string;
  reader?: Partial<ReaderParams>;
  anchor?: Partial<AnchorParams>;
}

/** The log from `fromT` on as per-frame batches, in frame order. */
function frameBatches(log: EvidenceLog, fromT = -Infinity, toT = Infinity): { frame: number; t: number; quads: QuadObs[]; pairings: Pairing[] }[] {
  const byFrame = new Map<number, { frame: number; t: number; quads: QuadObs[]; pairings: Pairing[] }>();
  for (const q of log.quads) {
    if (q.t < fromT || q.t > toT) continue;
    let b = byFrame.get(q.frame);
    if (!b) byFrame.set(q.frame, (b = { frame: q.frame, t: q.t, quads: [], pairings: [] }));
    b.quads.push(q);
  }
  for (const p of log.pairings) byFrame.get(p.frame)?.pairings.push(p);
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** Offline: anchor the log from the lock on and decode it in one go (the anchoring sees the leader before each frame, exactly as live). */
export function readMoves(log: EvidenceLog, commit: Commitments, opts: ReadOptions = {}): { record: MoveRecord; reader: MoveReader; anchorer: Anchorer; frames: FrameObs[]; anchorMs: number } {
  const anchorer = new Anchorer(commit, opts.anchor);
  const reader = new MoveReader(commit.start, anchorer.model, opts.reader);
  const frames: FrameObs[] = [];
  let anchorMs = 0;
  for (const b of frameBatches(log, opts.fromT, opts.toT)) {
    const t0 = performance.now();
    const f = anchorer.anchor(b.frame, b.t, b.quads, b.pairings, reader.leader.state);
    anchorMs += performance.now() - t0;
    frames.push(f);
    reader.push(f);
  }
  return { record: reader.record(opts.end), reader, anchorer, frames, anchorMs };
}

/** The trace as a text table (one line per frame) for test output and the debug panel. */
export function formatTrace(trace: readonly FrameTrace[], opts: { from?: number; every?: number } = {}): string {
  const from = opts.from ?? trace[0]?.t ?? 0;
  const every = opts.every ?? 1;
  const lines = ['     t    dt  faces   sumW out  fit  margin depth exp   ms   shift(in)  via / dropped'];
  trace.forEach((r, i) => {
    if (i % every && !r.best.via) return;
    lines.push(`${((r.t - from) / 1000).toFixed(2).padStart(6)} ${String(Math.round(r.dt)).padStart(5)}  ${r.faces.padEnd(7)} ${r.sumW.toFixed(1).padStart(5)} ${String(r.outliers).padStart(3)} ${r.fit.toFixed(2).padStart(5)} ${(r.margin === Infinity ? 'inf' : r.margin.toFixed(1)).padStart(7)} ${String(r.depth).padStart(5)} ${String(r.expanded).padStart(4)} ${r.ms.toFixed(1).padStart(5)} ${r.shift.padStart(12)}  ${r.best.via ? `** ${r.best.via}` : ''}${r.dropped ? ` (${r.dropped})` : ''}`);
  });
  return lines.join('\n');
}

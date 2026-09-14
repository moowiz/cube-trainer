// The synthetic solve fixture (design 5.1): a random state locked from a
// simulated scan, then a random move sequence watched through 2-3 visible
// faces with 2-5 noisy frames per epoch, fingers, dropped frames, re-grips
// and a mid-turn garbage frame or two between epochs. The reader must
// return the sequence (up to commuting order) with every turn certified,
// and it must not invent turns on a fingered cube that never moves.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { solve } from '../src/colour/solve';
import { commitmentsFrom, type Commitments } from '../src/moves/anchor';
import { applySeq, commute, faceOf, MOVES, parseAlg, type Move } from '../src/moves/moves';
import { formatAlg, formatItems, recordMoves } from '../src/moves/record';
import { formatTrace, readMoves } from '../src/moves/reader';
import type { FaceId } from '../src/types';
import { CORNER_VIEWS, lcg, simulate, simulateFrames, type FrameSpec } from './synth';

/** Commuting neighbours in URFDLB face order, so two sequences that differ only by commuting order compare equal. */
function canonicalOrder(moves: readonly Move[]): Move[] {
  const out = [...moves];
  for (let pass = 0; pass < out.length; pass++) {
    for (let i = 1; i < out.length; i++) {
      if (commute(out[i - 1]!, out[i]!) && faceOf(out[i - 1]!) > faceOf(out[i]!)) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
    }
  }
  return out;
}

interface SolveScene { specs: FrameSpec[]; states: string[]; /** t of the last clean frame before each turn and the first after */ turns: { t0: number; t1: number }[] }

interface SceneOptions {
  seed?: number;
  /** Frames per epoch, inclusive range. */
  epoch?: [number, number];
  /** Probability a frame shows only two of the view's faces. */
  twoFace?: number;
  /** Probability of a re-grip (new view, new tracks) at an epoch start. */
  regrip?: number;
  /** Finger cells per face per frame, inclusive range. */
  fingers?: [number, number];
  /** Probability a frame is dropped (no detection). */
  drop?: number;
  /** Garbage frames per turn, inclusive range. */
  garbage?: [number, number];
  /** Sample interval, ms. */
  dt?: number;
  /** Turns that happen inside one frame interval (index of the turn that joins the previous one). */
  bursts?: number[];
}

function solveScene(start: string, moves: readonly Move[], o: SceneOptions = {}): SolveScene {
  const rnd = lcg(o.seed ?? 3);
  const between = (r: [number, number]) => r[0] + Math.floor(rnd() * (r[1] - r[0] + 1));
  const dt = o.dt ?? 125;
  const specs: FrameSpec[] = [];
  const states = [start];
  for (const m of moves) states.push(applySeq(states[states.length - 1]!, [m]));
  let t = 0;
  let lastT = 0; // t of the last frame actually emitted (dropped frames leave no evidence)
  let view = CORNER_VIEWS[0]!;
  const turns: SolveScene['turns'] = [];
  const epochFrames = (state: string, regrip: boolean): void => {
    if (regrip) view = CORNER_VIEWS[Math.floor(rnd() * CORNER_VIEWS.length)]!;
    const n = between(o.epoch ?? [2, 5]);
    for (let i = 0; i < n; i++) {
      t += dt;
      if (rnd() < (o.drop ?? 0.1)) continue;
      const faces = rnd() < (o.twoFace ?? 0.3) ? view.filter((_, j) => j !== Math.floor(rnd() * 3)) : view;
      specs.push({ state, view: faces as FaceId[], t, regrip: regrip && i === 0, fingers: between(o.fingers ?? [0, 3]) });
      lastT = t;
    }
  };
  epochFrames(states[0]!, false);
  for (let k = 1; k < states.length; k++) {
    const t0 = lastT;
    const g = between(o.garbage ?? [1, 2]);
    for (let i = 0; i < g; i++) { t += dt; if (rnd() < 0.5) specs.push({ state: states[k - 1]!, view, t, garbage: true, fingers: 2 }); }
    if (o.bursts?.includes(k + 1)) { turns.push({ t0, t1: t + dt }); continue; } // the next turn joins this one: no clean frames between
    epochFrames(states[k]!, rnd() < (o.regrip ?? 0.15));
    turns.push({ t0, t1: lastT });
  }
  return { specs, states, turns };
}

/** Lock the start state from a simulated scan; the reader's commitments come from that lock, not from the truth. */
function lockOf(start: string, seed: number): Commitments {
  const scan = simulate(start, { seed, frames: 40 });
  const s = solve(scan.log);
  expect(s.lockable, s.reason).toBe(true);
  expect(s.facelets).toBe(start);
  return commitmentsFrom(s)!;
}

const START = new Cube().move("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D").asString();

function randomMoves(n: number, seed: number): Move[] {
  const rnd = lcg(seed);
  const out: Move[] = [];
  while (out.length < n) {
    const m = MOVES[Math.floor(rnd() * 18)]!;
    if (out.length && faceOf(m) === faceOf(out[out.length - 1]!)) continue;
    out.push(m);
  }
  return out;
}

describe('synthetic solve', () => {
  const commit = lockOf(START, 5);

  it('reads a 20-turn sequence through three faces with fingers, drops, re-grips and garbage frames', () => {
    const moves = randomMoves(20, 11);
    const scene = solveScene(START, moves, { seed: 2 });
    const { log } = simulateFrames(scene.specs, { seed: 9, reacquireEvery: 0 });
    const { record, reader, anchorMs } = readMoves(log, commit);
    console.log(`\ntruth  ${moves.join(' ')}\nread   ${formatAlg(record)}\n${formatTrace(reader.trace)}\nanchor ${anchorMs.toFixed(1)} ms, decode ${reader.ms.toFixed(1)} ms for ${reader.frames.length} frames (${(reader.ms / reader.frames.length).toFixed(2)} ms/frame)`);
    expect(canonicalOrder(recordMoves(record))).toEqual(canonicalOrder(moves));
    expect(record.end).toBe(scene.states[scene.states.length - 1]);
    for (const it of record.items) expect(it.kind === 'gap' ? 0 : it.margin, formatAlg(record)).toBeGreaterThan(3);
    // each turn is timed to within the garbage frames around it
    const turns = record.items.filter((it) => it.kind === 'move');
    turns.forEach((it, i) => {
      if (it.kind !== 'move') return;
      expect(it.t0).toBeGreaterThanOrEqual(scene.turns[i]!.t0 - 1);
      expect(it.t1).toBeLessThanOrEqual(scene.turns[i]!.t1 + 1);
    });
    expect(reader.ms / reader.frames.length).toBeLessThan(5);
  });

  it('two faces are nearly enough: a 12-turn sequence read through two adjacent faces', () => {
    const moves = randomMoves(12, 4);
    const scene = solveScene(START, moves, { seed: 8, twoFace: 1 });
    const { log } = simulateFrames(scene.specs, { seed: 10, reacquireEvery: 0 });
    const { record, reader } = readMoves(log, commit, { end: scene.states[scene.states.length - 1] });
    console.log(`\ntruth  ${moves.join(' ')}\nread   ${formatAlg(record)}\n${formatTrace(reader.trace)}
${formatItems(record)}`);
    expect(record.endMatches).toBe(true);
    expect(canonicalOrder(recordMoves(record))).toEqual(canonicalOrder(moves));
  });

  it('a burst: two turns inside one frame interval come out as an ordered pair', () => {
    const moves = parseAlg("R U F' D L2 B");
    const scene = solveScene(START, moves, { seed: 6, bursts: [3], garbage: [0, 0] });
    const { log } = simulateFrames(scene.specs, { seed: 12, reacquireEvery: 0 });
    const { record, reader } = readMoves(log, commit);
    console.log(`\ntruth  ${moves.join(' ')}\nread   ${formatAlg(record)}\n${formatTrace(reader.trace)}
${formatItems(record)}`);
    expect(canonicalOrder(recordMoves(record))).toEqual(canonicalOrder(moves));
    expect(record.items.some((it) => it.kind === 'burst')).toBe(true);
  });

  it('never invents a turn on a fingered, re-gripped cube that does not move', () => {
    const scene = solveScene(START, [], { seed: 21, epoch: [40, 40], fingers: [2, 4], regrip: 1 });
    // several re-grips of the same state, thumbs everywhere
    const specs = [...scene.specs];
    for (let k = 1; k < 4; k++) {
      const more = solveScene(START, [], { seed: 21 + k, epoch: [12, 12], fingers: [2, 4] }).specs;
      const t = specs[specs.length - 1]!.t;
      specs.push(...more.map((s, i) => ({ ...s, t: t + 300 + s.t, regrip: i === 0 })));
    }
    const { log } = simulateFrames(specs, { seed: 13, reacquireEvery: 0, fingers: 0.1 });
    const { record, reader } = readMoves(log, commit);
    console.log(`\nread   ${formatAlg(record) || '(nothing)'}\n${formatTrace(reader.trace, { every: 8 })}`);
    expect(record.items).toEqual([]);
    expect(record.end).toBe(START);
    expect(record.margin).toBeGreaterThan(3);
  });

  it('a slipped move: the read sequence is what happened, not what was intended', () => {
    // the user meant R2 and turned F2 (2026-09-14, phone session): the
    // record must say F2
    const intended = parseAlg("U L' R2 D F");
    const done = parseAlg("U L' F2 D F");
    const scene = solveScene(START, done, { seed: 14 });
    const { log } = simulateFrames(scene.specs, { seed: 15, reacquireEvery: 0 });
    const { record } = readMoves(log, commit);
    expect(recordMoves(record)).toEqual(done);
    expect(recordMoves(record)).not.toEqual(intended);
  });
});

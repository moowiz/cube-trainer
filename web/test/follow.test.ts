// Following a solve (src/follow.ts, and the solver worker's epoch window):
// the lock plus the turns read is the cube in your hands, in the trainer's
// frame; the stage it is at moves the tabs once it has settled; and a
// re-read of the evidence since the last turn locks the turned cube, not
// the one before it.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { handle, windowLog, type SolverResponse } from '../src/colour/solve.worker';
import { solve } from '../src/colour/solve';
import { colourString, describeStage, followReport, followScramble, SolveFollower, StageFollower, stageRank } from '../src/follow';
import { applySeq, parseAlg } from '../src/moves/moves';
import { trainerScramble, type ScannedCube } from '../src/handoff';
import { scrambleState } from '../src/scramble';
import { stageOf } from '../src/stage';
import { DEFAULT_SCHEME_NAMES, type FaceId } from '../src/types';
import { CORNER_VIEWS, simulateFrames, type FrameSpec } from './synth';

// a standard cube (white up, green front in the solver's letters); the trainer holds it white down, blue front
const scanOf = (scramble: string): ScannedCube => ({ facelets: scrambleState(scramble), colourOf: DEFAULT_SCHEME_NAMES, solution: Cube.inverse(scramble) });
const HOLD = { down: 'white', front: 'blue' } as const;

describe('followScramble', () => {
  it('with no turns read is the lock\'s trainer scramble', () => {
    const scan = scanOf("R U R' U'");
    expect(followScramble(scan, [], HOLD)).toBe(trainerScramble(scan, HOLD));
  });

  it('reaches the cube the read turns leave, whichever letters name the faces', () => {
    const scan = scanOf("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D");
    const moves = parseAlg("R U R' U' F2 D L");
    // the followed cube in the solver's letters, and the same cube as the trainer scramble reaches it, must be
    // the same physical cube: white down + blue front is x2 from white up + green front
    const physical = new Cube().move(`${followScramble(scan, moves, HOLD)}`).asString();
    const inSolverLetters = applySeq(scan.facelets, moves);
    const x2 = { U: 'D', D: 'U', F: 'B', B: 'F', R: 'R', L: 'L' } as Record<FaceId, FaceId>;
    const relabelled = [...Cube.fromString(inSolverLetters).move('x2').asString()].map((c) => x2[c as FaceId]).join('');
    expect(physical).toBe(relabelled);
  });

  it('a solve read to the end leaves a solved cube', () => {
    const scramble = "L2 U F' B2 R' D2 F U' L D";
    const scan = scanOf(scramble);
    const moves = parseAlg(Cube.inverse(scramble));
    expect(followReport(followScramble(scan, moves, HOLD)).stage).toBe('solved');
  });
});

describe('followReport', () => {
  it('reads the stage off the trainer-frame scramble (white is D there)', () => {
    expect(followReport('').stage).toBe('solved');
    expect(followReport('U').stage).toBe('pll');
    expect(followReport("R U R' U' R' F R2 U' R' U' R U R' F'").stage).toBe('pll');   // a T perm
    expect(followReport("R U R' U R U2 R'").stage).toBe('ocll');                     // a sune: the top layer's corners twisted
    expect(followReport("R U R'").stage).toBe('f2l');                                // one pair out, cross and EO intact
    expect(followReport("F").stage).toBe('eo');                                      // four edges flipped
  });
});

describe('StageFollower', () => {
  it('switches only once the new stage has been seen twice running', () => {
    const f = new StageFollower(2);
    f.reset('eo');
    expect(f.update('eo')).toBeNull();
    expect(f.update('f2l')).toBeNull();     // first sighting: a turn caught mid-way, perhaps
    expect(f.update('eo')).toBeNull();      // back: nothing happened
    expect(f.update('f2l')).toBeNull();
    expect(f.update('f2l')).toBe('f2l');    // settled
    expect(f.stage()).toBe('f2l');
    expect(f.update('f2l')).toBeNull();
    expect(f.update('ocll')).toBeNull();
    expect(f.update('pll')).toBeNull();     // a different candidate restarts the count
    expect(f.update('pll')).toBe('pll');
  });
  it('can go back (an undone turn, or a reader correction)', () => {
    const f = new StageFollower(1);
    f.reset('pll');
    expect(f.update('f2l')).toBe('f2l');
  });
});

describe('SolveFollower (the smart cube: whole turns, no debounce)', () => {
  /** the stage after each turn of `alg` from the state `from` reaches, in the trainer's frame */
  const stagesAlong = (from: string, alg: string): ReturnType<typeof followReport>['stage'][] => {
    const out: ReturnType<typeof followReport>['stage'][] = [];
    let s = from;
    for (const m of parseAlg(alg)) { s = `${s} ${m}`.trim(); out.push(followReport(s).stage); }
    return out;
  };

  it('opens a stage only when the cube crosses beyond the furthest one so far: a Sune never bounces the tabs', () => {
    const f = new SolveFollower();
    f.restart('ocll');
    // the anti-Sune undoing a Sune: the cross breaks on R, comes back on the last R' with the cube solved
    const seen = stagesAlong("R U R' U R U2 R'", "R U2 R' U' R U' R'");
    expect(seen[0]).toBe('eo');                             // the dip
    const switches = seen.map((st) => f.turned(st));
    expect(switches.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(switches[switches.length - 1]).toBe('solved');  // the alg's end is the crossing
    expect(f.mark()).toBe('solved');
  });

  it('a full solve is followed stage by stage, each announced once', () => {
    const f = new SolveFollower();
    f.restart('eo');
    // the solve: F' fixes EO (the scramble's F flipped four edges), a pair goes in, the anti-Sune finishes
    const solveAlg = "F' U R U' R' R U2 R' U' R U' R'";
    const seen = stagesAlong(Cube.inverse(solveAlg), solveAlg);
    const switches = seen.map((st) => f.turned(st)).filter(Boolean);
    expect(seen[0]).toBe('f2l');                            // F' orients the edges; the cross is intact, a pair is out
    expect(switches[switches.length - 1]).toBe('solved');
    expect(new Set(switches).size).toBe(switches.length);   // each stage crossed into once
    expect([...switches].sort((a, b) => stageRank(a!) - stageRank(b!))).toEqual(switches);
  });

  it('before the first state is known, the first turn only sets the mark', () => {
    const f = new SolveFollower();
    expect(f.turned('pll')).toBeNull();
    expect(f.mark()).toBe('pll');
    expect(f.turned('solved')).toBe('solved');
  });

  it('a pause behind the mark restarts the follow there (a cube scrambled by hand after a solve)', () => {
    const f = new SolveFollower();
    f.restart('solved');
    expect(f.paused('solved')).toBeNull();
    expect(f.paused('eo')).toBe('eo');
    expect(f.mark()).toBe('eo');
    expect(f.turned('f2l')).toBe('f2l');
  });

  it('the first pause takes the stage as the mark; a solved cube is nothing to load', () => {
    const f = new SolveFollower();
    expect(f.paused('solved')).toBeNull();
    expect(f.mark()).toBe('solved');
    const g = new SolveFollower();
    expect(g.paused('f2l')).toBe('f2l');
    expect(g.paused('f2l')).toBeNull();
  });

  it('a pause mid-solve at the mark or beyond changes nothing', () => {
    const f = new SolveFollower();
    f.restart('f2l');
    expect(f.paused('f2l')).toBeNull();
    expect(f.paused('ocll')).toBeNull();
    expect(f.mark()).toBe('f2l');
  });
});

describe('describeStage', () => {
  it('names the stage to solve next', () => {
    expect(describeStage(followReport(''))).toMatch(/solved/);
    expect(describeStage(followReport('F'))).toMatch(/EO/);
    expect(describeStage(followReport("R U R'"))).toMatch(/F2L/);
  });
});

describe('colourString', () => {
  it('equates the same cube named with different letters', () => {
    const a = colourString('UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB', DEFAULT_SCHEME_NAMES);
    const swapped = { ...DEFAULT_SCHEME_NAMES, U: DEFAULT_SCHEME_NAMES.D, D: DEFAULT_SCHEME_NAMES.U };
    const b = colourString('DDDDDDDDDRRRRRRRRRFFFFFFFFFUUUUUUUUULLLLLLLLLBBBBBBBBB', swapped);
    expect(a).toBe(b);
    expect(colourString('DUUUUUUUURRRRRRRRRFFFFFFFFFUDDDDDDDDLLLLLLLLLBBBBBBBBB', DEFAULT_SCHEME_NAMES)).not.toBe(a);
  });
});

describe('the solver worker\'s epoch window (re-lock while following)', () => {
  const START = new Cube().move("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D").asString();
  const AFTER = applySeq(START, parseAlg("R U R' U'"));
  // a scan of the start (all eight corner views), a turn, then the turned cube shown around again
  const specs: FrameSpec[] = [];
  let t = 1000;
  for (let f = 0; f < 40; f++, t += 250) specs.push({ state: START, view: CORNER_VIEWS[f % 8]!, t });
  const TURN_T = t;
  for (let f = 0; f < 40; f++, t += 250) specs.push({ state: AFTER, view: CORNER_VIEWS[f % 8]!, t, regrip: f === 0 });
  const { log } = simulateFrames(specs, { seed: 11 });

  it('windowLog keeps the quads sampled since fromT and their frames\' pairings', () => {
    const w = windowLog(log, TURN_T);
    expect(w.quads.length).toBeGreaterThan(0);
    expect(w.quads.every((q) => q.t >= TURN_T)).toBe(true);
    const frames = new Set(w.quads.map((q) => q.frame));
    expect(w.pairings.every((p) => frames.has(p.frame))).toBe(true);
    expect(w.frames).toBe(log.frames);
    expect(windowLog(log, -Infinity).quads.length).toBe(log.quads.length);
  });

  it('the epoch since the turn locks the turned cube; the start epoch locks the start', () => {
    const before = solve({ ...log, quads: log.quads.filter((q) => q.t < TURN_T), pairings: log.pairings.filter((p) => p.frame < 40) });
    expect(before.lockable).toBe(true);
    expect(before.facelets).toBe(START);
    const after = solve(windowLog(log, TURN_T));
    expect(after.lockable).toBe(true);
    expect(after.facelets).toBe(AFTER);
    expect(stageOf(after.facelets!)).toBeTruthy();
  });

  it('through the worker protocol: a solve with fromT sees only that epoch', () => {
    const out: SolverResponse[] = [];
    const post = (o: SolverResponse) => out.push(o);
    handle({ type: 'reset' }, post);
    handle({ type: 'append', quads: log.quads, pairings: log.pairings, events: log.events, frames: log.frames }, post);
    handle({ type: 'solve', id: 1, fromT: TURN_T }, post);
    const r = out[out.length - 1]!;
    expect(r.type).toBe('solution');
    if (r.type === 'solution') { expect(r.solution.lockable).toBe(true); expect(r.solution.facelets).toBe(AFTER); }
  });
});

// Following a solve on the smart cube (src/app/cubefollow.ts): the tabs
// move by the solve's furthest stage and never bounce back through an alg's
// dip, a pause with the cube off the open tab's scramble path loads its
// state like a lock, the Solve tab's "stay here" keeps the tabs still while
// its timer still hears the turns, and a resync re-bases. sources.ts is the
// real one; the shell, the page context, the smart cube's presence, the
// settings store and the cubejs solve are mocked. Time is a value this file
// advances (performance.now and the 500 ms poll), so the 15 s pause is
// deterministic. Each test loads the modules afresh: the follow is a
// singleton with a history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Cube from 'cubejs';
import { SOLVED } from '../src/cube/state';
import { followReport } from '../src/follow';
import { expectedFacelets, relabelTurns, toSourceLetters, type Hold } from '../src/handoff';
import { applySeq, parseAlg, type Move } from '../src/moves/moves';
import { movesOf, type MoveSource, type ResyncItem, type SourceItem } from '../src/moves/source';
import type { Stage as StageOfShell, Tab } from '../src/shell';
import { DEFAULT_SCHEME_NAMES } from '../src/types';

vi.mock('../src/shell', () => {
  let tab: Tab = 'eo';
  const listeners = new Set<(t: Tab) => void>();
  return {
    stages: {},
    activeTab: vi.fn(() => tab),
    showTab: vi.fn((t: Tab) => { tab = t; for (const cb of listeners) cb(t); }),
    onTabChange: (cb: (t: Tab) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    shareScramble: vi.fn(),
    keepScramble: vi.fn(),
    toast: vi.fn(),
  };
});
vi.mock('../src/app/context', () => ({ hold: () => ({ down: 'white', front: 'green' }) }));
vi.mock('../src/app/smart', () => ({ cubeActive: () => true }));
vi.mock('../src/state', () => ({ solveState: vi.fn(), warmSolver: vi.fn() }));
vi.mock('../src/ui/settings', () => ({ persistControls: vi.fn(() => []), readStored: vi.fn(() => null), writeStored: vi.fn() }));

const TABS: readonly Tab[] = ['solve', 'eo', 'f2l', 'ocll', 'pll'];
// the cube's own letters (a standard smart cube: white up, green front); the trainer holds it white down, green front
const COLOURS = DEFAULT_SCHEME_NAMES;
const HOLD: Hold = { down: 'white', front: 'green' };
/** The turns that apply a trainer-frame alg on the cube, in the cube's own letters. */
const onCube = (alg: string): Move[] => parseAlg(toSourceLetters(COLOURS, alg, HOLD));
/** The turns that undo those. */
const undoOnCube = (alg: string): Move[] => parseAlg(Cube.inverse(toSourceLetters(COLOURS, alg, HOLD)));

// A trainer-frame scramble (an AUF, a Sune, a pair pulled out, the front face turned) whose solve, move by
// move, crosses EO -> F2L -> OCLL, then dips back through EO and F2L inside the inverse Sune, then PLL, solved.
const SCRAMBLE = "U R U R' U R U2 R' R U R' F";

let now = 100_000;
/** The clock and the poll move on together. */
const tick = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };
/** Let the solver stub's promise settle. */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** A cube scripted by hand: solved to begin with, `turn` appends move items, `report` is the cube's own resync to a state. */
function fakeSource() {
  const items: SourceItem[] = [];
  const subs = new Set<(item: SourceItem) => void>();
  let base = SOLVED, since = 0;
  let toBase: Move[] = []; // the turns from solved to `base` (so a solution can be given without a solver)
  const push = (item: SourceItem) => { items.push(item); for (const cb of subs) cb(item); };
  const src: MoveSource & { turn(...ms: Move[]): void; report(ms: Move[]): void; solutionOf(f: string): string } = {
    kind: 'cube',
    colourOf: COLOURS,
    state: () => applySeq(base, movesOf(items.slice(since))),
    items: () => items,
    resync: () => undefined,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
    dispose: () => undefined,
    turn(...ms) { for (const m of ms) { push({ kind: 'move', move: m, t: now, sure: true }); now += 300; } },
    report(ms) { toBase = ms; base = applySeq(SOLVED, ms); since = items.length + 1; const item: ResyncItem = { kind: 'resync', t: now, facelets: base, how: 'report' }; push(item); },
    solutionOf(f) {
      if (f !== src.state()) throw new Error('the stub solves only the state the cube is at');
      return Cube.inverse([...toBase, ...movesOf(items.slice(since))].join(' '));
    },
  };
  return src;
}

/** A stage that stores the scramble it is given and records what it hears. */
function fakeStage(scramble: string | null) {
  const s = {
    scr: scramble,
    load: vi.fn((x: string) => { s.scr = x; }),
    render: vi.fn(),
    scramble: () => s.scr,
    newScramble: vi.fn(),
    watch: vi.fn<NonNullable<StageOfShell['watch']>>(),
    armed: vi.fn<NonNullable<StageOfShell['armed']>>(),
    feed: vi.fn<NonNullable<StageOfShell['feed']>>(() => false),
  };
  return s;
}

type Listener = (e: unknown) => void;
const box = { checked: true, addEventListener: (_ev: string, _cb: Listener) => undefined };
const seg = { parentElement: { hidden: false }, querySelectorAll: () => [], addEventListener: (_ev: string, cb: Listener) => { seg.onClick = cb; }, onClick: null as Listener | null };
/** A tap on the Solve tab's "As I solve" segment. */
const tapSolveMode = (v: 'stay' | 'follow') => seg.onClick!({ target: { closest: () => ({ dataset: { v } }) } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  (globalThis as { document?: unknown }).document = { getElementById: (id: string) => (id === 'cubefollow' ? box : id === 'tm-cubefollow' ? seg : null) };
  (globalThis as { window?: unknown }).window = { scrollTo: vi.fn() };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

/** The modules afresh, the tabs' stages with these scrambles, the cube (solved) as the active source, the follow initialised on `tab`. */
async function setup(tab: Tab, scrambles: Partial<Record<Tab, string>> = {}) {
  vi.resetModules();
  const shell = await import('../src/shell');
  const state = await import('../src/state');
  const sources = await import('../src/app/sources');
  const follow = await import('../src/app/cubefollow');
  const src = fakeSource();
  vi.mocked(state.solveState).mockImplementation((f) => Promise.resolve(src.solutionOf(f)));
  const stages = {} as Record<Tab, ReturnType<typeof fakeStage>>;
  for (const t of TABS) { stages[t] = fakeStage(scrambles[t] ?? null); shell.stages[t] = stages[t]; }
  // the shell's share: every tab but the kept one loads it; and what the cube was at when it happened
  let kept: Tab | null = null;
  const shared: { scramble: string; state: string }[] = [];
  vi.mocked(shell.keepScramble).mockImplementation((t) => { kept = t; });
  vi.mocked(shell.shareScramble).mockImplementation((scramble, from) => {
    shared.push({ scramble, state: src.state() ?? '' });
    for (const t of TABS) if (t !== from && t !== kept) stages[t].load(scramble);
  });
  shell.showTab(tab);
  vi.mocked(shell.showTab).mockClear();
  sources.useSource(src);
  follow.initCubeFollow();
  const opened = () => vi.mocked(shell.showTab).mock.calls.map((c) => c[0]);
  const toasts = () => vi.mocked(shell.toast).mock.calls.map((c) => c[0]);
  return { shell, state, src, stages, shared, opened, toasts };
}

/** The trainer-frame stage the cube is at. */
const stageNow = (src: MoveSource) => followReport(relabelTurns(COLOURS, movesOf(src.items()), HOLD)).stage;

describe('cube follow: the furthest stage rule', () => {
  it('opens each stage the solve crosses into, never backwards through an alg\'s dip, and says solved at the end', async () => {
    const { src, stages, shared, opened, toasts } = await setup('eo', { eo: SCRAMBLE });
    // the scramble applied on the cube: on the tab's path all the way, so no tab moves; the drill arms at the end
    src.turn(...onCube(SCRAMBLE));
    expect(opened()).toEqual([]);
    expect(stages.eo.armed).toHaveBeenCalledTimes(1);
    expect(stageNow(src)).toBe('eo');

    const seen: string[] = [];
    for (const m of undoOnCube(SCRAMBLE)) { src.turn(m); seen.push(stageNow(src)); }
    // the path dipped: EO and F2L again after OCLL was reached
    expect(seen).toEqual(['f2l', 'eo', 'eo', 'ocll', 'eo', 'eo', 'f2l', 'f2l', 'eo', 'eo', 'pll', 'solved']);
    expect(opened()).toEqual(['f2l', 'ocll', 'pll']);
    // each tab opened with the cube's state loaded into every tab
    expect(shared.length).toBe(3);
    for (const s of shared) expect(expectedFacelets(s.scramble, HOLD, COLOURS)).toBe(s.state);
    expect(stages.pll.load).toHaveBeenCalledTimes(3);
    expect(toasts().slice(0, 3)).toEqual(['EOCross done → F2L', 'F2L done → OCLL', 'Corners oriented → PLL']);
    // the 12 turns of the solve, timed from the first to the last
    expect(toasts()[3]).toBe('Solved ✓ 12 turns in 3.3 s');
    expect(src.state()).toBe(SOLVED);
  });

  it('the tab the cube is on hears the turns the follow moves on, before the tabs move', async () => {
    const { src, stages, opened } = await setup('eo', { eo: SCRAMBLE });
    src.turn(...onCube(SCRAMBLE));
    const [first, ...rest] = undoOnCube(SCRAMBLE);
    let tabsWhenFed: Tab[] = [];
    stages.eo.feed.mockImplementation(() => { tabsWhenFed = opened(); return false; });
    src.turn(first!);
    // the EO stage judged the turn (fed in trainer letters) and only then was the F2L tab opened
    expect(stages.eo.feed).toHaveBeenCalledWith(relabelTurns(COLOURS, [first!], HOLD), expect.any(Number), 'cube');
    expect(tabsWhenFed).toEqual([]);
    expect(opened()).toEqual(['f2l']);
    // the F2L tab armed on the cube's state right away and hears the turns up to the one that crosses into OCLL;
    // the OCLL tab those up to the crossing into PLL; the PLL tab the last one
    expect(stages.f2l.armed).toHaveBeenCalledTimes(1);
    src.turn(...rest);
    expect(stages.f2l.feed).toHaveBeenCalledTimes(3);
    expect(stages.f2l.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, rest.slice(0, 3), HOLD), expect.any(Number), 'cube');
    expect(stages.ocll.feed).toHaveBeenCalledTimes(7);
    expect(stages.ocll.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, rest.slice(3, 10), HOLD), expect.any(Number), 'cube');
    expect(stages.pll.feed).toHaveBeenCalledTimes(1);
    expect(stages.pll.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, rest.slice(10), HOLD), expect.any(Number), 'cube');
    expect(opened()).toEqual(['f2l', 'ocll', 'pll']);
  });
});

describe('cube follow: a pause', () => {
  it('on the tab\'s scramble path is the scramble being applied; off it, the cube\'s state is loaded like a lock', async () => {
    const { src, shared, opened, toasts } = await setup('eo', { eo: "F R" });
    const [first] = onCube("F R");
    src.turn(first!);
    tick(15_500);
    expect(opened()).toEqual([]);
    expect(shared).toEqual([]);
    // a wrong turn: off the path, and a while later still there - a cube scrambled by hand
    src.turn('D');
    expect(opened()).toEqual([]);
    tick(15_500);
    expect(opened()).toEqual(['eo']);
    expect(shared.length).toBe(1);
    expect(expectedFacelets(shared[0]!.scramble, HOLD, COLOURS)).toBe(src.state());
    expect(toasts()).toEqual(['EOCross to solve → EO trainer']);
    // and only once: the cube resting on there is not news
    tick(15_500);
    expect(opened()).toEqual(['eo']);
  });

  it('after the cube\'s own report the loaded state is the reported one plus the turns since, not the old base', async () => {
    const { src, state, shared, opened } = await setup('eo');
    src.turn('D');
    // the cube says it is somewhere else: a Sune away from solved (corners of the top layer twisted, the rest solved)
    const sune = "R U R' U R U2 R'";
    src.report(onCube(sune));
    await flush();
    expect(state.solveState).toHaveBeenCalledTimes(1);
    expect(state.solveState).toHaveBeenCalledWith(expectedFacelets(sune, HOLD, COLOURS));
    // one turn breaks the cross: behind the mark (OCLL) at the pause, so the EO tab opens with the true state
    src.turn(...onCube('R'));
    tick(15_500);
    expect(opened()).toEqual(['eo']);
    expect(shared.length).toBe(1);
    expect(expectedFacelets(shared[0]!.scramble, HOLD, COLOURS)).toBe(src.state());
    expect(followReport(shared[0]!.scramble).stage).toBe('eo');
  });
});

describe('cube follow: the Solve tab', () => {
  it('following, a timed solve pins the timer and moves the tabs, and comes back to the Solve tab when solved', async () => {
    const { shell, src, stages, opened } = await setup('solve', { solve: SCRAMBLE });
    src.turn(...onCube(SCRAMBLE));
    expect(stages.solve.armed).toHaveBeenCalledTimes(1);
    expect(shell.keepScramble).toHaveBeenLastCalledWith('solve');
    const solve = undoOnCube(SCRAMBLE);
    src.turn(...solve);
    expect(opened()).toEqual(['f2l', 'ocll', 'pll', 'solve']);
    // the timer heard every turn of the solve while the drill tabs were open, and its scramble was never replaced
    expect(stages.solve.feed).toHaveBeenCalledTimes(solve.length);
    expect(stages.solve.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, solve, HOLD), expect.any(Number), 'cube');
    expect(stages.solve.load).not.toHaveBeenCalled();
    expect(stages.solve.scr).toBe(SCRAMBLE);
    expect(vi.mocked(shell.keepScramble).mock.calls.map((c) => c[0])).toEqual(['solve', null]);
  });

  it('"stay here" keeps the tabs still while the timer still gets the turns', async () => {
    const { shell, src, stages, opened } = await setup('solve', { solve: SCRAMBLE });
    tapSolveMode('stay');
    src.turn(...onCube(SCRAMBLE));
    expect(stages.solve.armed).toHaveBeenCalledTimes(1);
    const solve = undoOnCube(SCRAMBLE);
    src.turn(...solve);
    expect(stages.solve.feed).toHaveBeenCalledTimes(solve.length);
    expect(src.state()).toBe(SOLVED);
    expect(opened()).toEqual([]);
    expect(shell.shareScramble).not.toHaveBeenCalled();
    expect(shell.keepScramble).not.toHaveBeenCalled();
    // and a hand scramble left resting does not move them either
    src.turn('D', 'L');
    tick(15_500);
    expect(opened()).toEqual([]);
  });
});

// The active MoveSource and the drill drivers over it (src/app/sources.ts):
// every item goes to the open stage in the trainer's letters, the driver
// arms when the cube reaches the stage's scramble and feeds the turns after
// it, a pinned stage keeps hearing items while another tab is open, an
// unpinned one starts over when reopened, and switching sources unsubscribes
// the old one exactly once. The shell and the page context are mocked: the
// shell's tab is a value this file sets, the hold is white down with a front
// colour this file picks.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOLVED } from '../src/cube/state';
import { expectedFacelets, relabelTurns, toSourceLetters, type Hold } from '../src/handoff';
import { applySeq, parseAlg, type Move } from '../src/moves/moves';
import { movesOf, type MoveSource, type SourceItem } from '../src/moves/source';
import { DEFAULT_SCHEME_NAMES } from '../src/types';

vi.mock('../src/shell', () => ({
  stages: {},
  activeTab: vi.fn(() => 'eo'),
}));
vi.mock('../src/app/context', () => ({
  hold: vi.fn(() => ({ down: 'white', front: 'green' })),
}));

import { hold } from '../src/app/context';
import { activeTab, stages, type Stage, type Tab } from '../src/shell';
import { activeSource, dropSource, onSourceChange, pinStage, setFallback, syncDriver, useSource } from '../src/app/sources';

// the cube's own letters: a standard smart cube, white up and green front
const COLOURS = DEFAULT_SCHEME_NAMES;
const GREEN_FRONT: Hold = { down: 'white', front: 'green' };
const BLUE_FRONT: Hold = { down: 'white', front: 'blue' };

const setTab = (t: Tab) => vi.mocked(activeTab).mockReturnValue(t);
const setHold = (h: Hold) => vi.mocked(hold).mockReturnValue(h);

/** A cube scripted by hand: `turn` appends move items (and tells the subscribers), the state is solved plus every turn. */
function fakeSource() {
  const items: SourceItem[] = [];
  const subs = new Set<(item: SourceItem) => void>();
  let t = 1000;
  let unsubscribed = 0;
  const src: MoveSource & { turn(...ms: Move[]): void; unsubscribed(): number; lastT(): number } = {
    kind: 'cube',
    colourOf: COLOURS,
    state: () => applySeq(SOLVED, movesOf(items)),
    items: () => items,
    resync: () => undefined,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); unsubscribed++; }; },
    dispose: () => undefined,
    turn(...ms) { for (const m of ms) { const item: SourceItem = { kind: 'move', move: m, t: (t += 100), sure: true }; items.push(item); for (const cb of subs) cb(item); } },
    unsubscribed: () => unsubscribed,
    lastT: () => t,
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
    watch: vi.fn<NonNullable<Stage['watch']>>(),
    armed: vi.fn<NonNullable<Stage['armed']>>(),
    feed: vi.fn<NonNullable<Stage['feed']>>(() => false),
  };
  return s;
}

/** The turns that apply a trainer-frame scramble on the cube, in the cube's own letters. */
const onCube = (scramble: string, h: Hold): Move[] => parseAlg(toSourceLetters(COLOURS, scramble, h));

// a trainer-frame scramble whose cube-letter turns differ from it (the trainer's frame is a z2 of the cube's with green in front)
const SCRAMBLE = "R U F' D";

beforeEach(() => {
  useSource(null);
  pinStage(null);
  setFallback(null);
  for (const k of Object.keys(stages)) delete stages[k as Tab];
  setTab('eo');
  setHold(GREEN_FRONT);
});

describe('sources: what the open stage hears', () => {
  const setup = onCube(SCRAMBLE, GREEN_FRONT);

  it('watches every turn with the cube\'s state and letters, the turn named in the trainer\'s frame', () => {
    const src = fakeSource();
    const eo = fakeStage(null);
    stages.eo = eo;
    useSource(src);
    src.turn('R', "U'");
    expect(eo.watch).toHaveBeenCalledTimes(2);
    expect(eo.watch).toHaveBeenNthCalledWith(1, applySeq(SOLVED, ['R']), COLOURS, relabelTurns(COLOURS, ['R'], GREEN_FRONT));
    expect(eo.watch).toHaveBeenNthCalledWith(2, src.state(), COLOURS, relabelTurns(COLOURS, ["U'"], GREEN_FRONT));

    // the same physical turn is named by the trainer's letters for how it holds the cube: with
    // green in front the cube's red-face turn is on the trainer's left, with blue in front on its right
    setHold(BLUE_FRONT);
    src.turn('R');
    const withGreen = relabelTurns(COLOURS, ['R'], GREEN_FRONT);
    const withBlue = relabelTurns(COLOURS, ['R'], BLUE_FRONT);
    expect(withGreen).toBe('L');
    expect(withBlue).toBe('R');
    expect(eo.watch).toHaveBeenNthCalledWith(3, src.state(), COLOURS, withBlue);
  });

  it('arms once when the cube reaches the scramble, feeds the turns after it in trainer letters, and stops once the stage says done', () => {
    const src = fakeSource();
    const eo = fakeStage(SCRAMBLE);
    stages.eo = eo;
    useSource(src);
    src.turn(...setup.slice(0, -1));
    expect(eo.armed).not.toHaveBeenCalled();
    src.turn(setup[setup.length - 1]!);
    expect(src.state()).toBe(expectedFacelets(SCRAMBLE, GREEN_FRONT, COLOURS));
    expect(eo.armed).toHaveBeenCalledTimes(1);
    expect(eo.armed).toHaveBeenCalledWith(src.lastT());
    expect(eo.feed).not.toHaveBeenCalled();

    src.turn('F');
    expect(eo.feed).toHaveBeenCalledTimes(1);
    expect(eo.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['F'], GREEN_FRONT), src.lastT(), 'cube');
    // the stage judges the attempt done on the next turn: the driver finishes, later turns are not the attempt
    eo.feed.mockReturnValueOnce(true);
    src.turn('L');
    expect(eo.feed).toHaveBeenCalledTimes(2);
    expect(eo.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['F', 'L'], GREEN_FRONT), src.lastT(), 'cube');
    src.turn('D', "L'");
    expect(eo.feed).toHaveBeenCalledTimes(2);
    expect(eo.armed).toHaveBeenCalledTimes(1);
  });

  it('a pinned stage keeps hearing and feeding while another tab is open; an unpinned one reopened has to reach its scramble again', () => {
    const src = fakeSource();
    const solve = fakeStage(SCRAMBLE), eo = fakeStage(SCRAMBLE);
    stages.solve = solve;
    stages.eo = eo;
    useSource(src);
    // the EO tab, armed and fed
    src.turn(...onCube(SCRAMBLE, GREEN_FRONT));
    expect(eo.armed).toHaveBeenCalledTimes(1);
    src.turn('F');
    expect(eo.feed).toHaveBeenCalledTimes(1);
    // over to the Solve tab, which arms when the cube is back at the scramble; EO hears nothing meanwhile
    setTab('solve');
    src.turn("F'");
    expect(solve.armed).toHaveBeenCalledTimes(1);
    expect(eo.watch).toHaveBeenCalledTimes(setup.length + 1);
    expect(eo.feed).toHaveBeenCalledTimes(1);
    // the Solve tab pinned: its timer hears every turn while the EO tab is open again
    pinStage('solve');
    setTab('eo');
    src.turn('F');
    expect(solve.feed).toHaveBeenCalledTimes(1);
    expect(solve.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['F'], GREEN_FRONT), src.lastT(), 'cube');
    expect(solve.armed).toHaveBeenCalledTimes(1);
    // the EO tab, reopened, started over: it hears the turn but does not feed it (its arming was for an earlier visit)
    expect(eo.watch).toHaveBeenCalledTimes(setup.length + 2);
    expect(eo.feed).toHaveBeenCalledTimes(1);
    // back at the scramble the EO tab arms afresh; the pinned timer, armed all along, hears the undo and then an
    // empty feed (its box clears), and both stages feed the next turn as the first of an attempt
    src.turn("F'");
    expect(eo.armed).toHaveBeenCalledTimes(2);
    expect(solve.feed).toHaveBeenCalledTimes(3);
    expect(solve.feed).toHaveBeenNthCalledWith(2, relabelTurns(COLOURS, ['F', "F'"], GREEN_FRONT), src.lastT(), 'cube');
    expect(solve.feed).toHaveBeenLastCalledWith('', src.lastT(), 'cube');
    src.turn('D');
    expect(eo.feed).toHaveBeenCalledTimes(2);
    expect(eo.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['D'], GREEN_FRONT), src.lastT(), 'cube');
    expect(solve.feed).toHaveBeenCalledTimes(4);
    expect(solve.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['D'], GREEN_FRONT), src.lastT(), 'cube');
  });
});

describe('sources: switching sources', () => {
  it('unsubscribes the old source once, starts every driver over, and ignores a repeat', () => {
    const a = fakeSource(), b = fakeSource();
    const eo = fakeStage(SCRAMBLE);
    stages.eo = eo;
    useSource(a);
    a.turn(...onCube(SCRAMBLE, GREEN_FRONT));
    expect(eo.armed).toHaveBeenCalledTimes(1);
    useSource(a);
    expect(a.unsubscribed()).toBe(0);

    useSource(b);
    expect(a.unsubscribed()).toBe(1);
    expect(activeSource()).toBe(b);
    // the old source's turns go nowhere now
    a.turn('F');
    expect(eo.watch).toHaveBeenCalledTimes(onCube(SCRAMBLE, GREEN_FRONT).length);
    // the new source's driver starts over: a turn on the solved cube b is not fed, b has to reach the scramble first
    b.turn('F');
    expect(eo.feed).not.toHaveBeenCalled();
    b.turn("F'", ...onCube(SCRAMBLE, GREEN_FRONT));
    expect(eo.armed).toHaveBeenCalledTimes(2);
    b.turn('L');
    expect(eo.feed).toHaveBeenCalledTimes(1);

    useSource(null);
    expect(b.unsubscribed()).toBe(1);
    expect(a.unsubscribed()).toBe(1);
  });

  it('dropping the active source falls back to the fallback; dropping another source changes nothing', () => {
    const cube = fakeSource(), camera = fakeSource(), other = fakeSource();
    stages.eo = fakeStage(null);
    setFallback(camera);
    useSource(cube);
    dropSource(other);
    expect(activeSource()).toBe(cube);
    expect(cube.unsubscribed()).toBe(0);

    dropSource(cube);
    expect(activeSource()).toBe(camera);
    expect(cube.unsubscribed()).toBe(1);
    // the fallback itself gone: nothing is active
    dropSource(camera);
    expect(activeSource()).toBeNull();
    expect(camera.unsubscribed()).toBe(1);
  });

  it('listeners hear every item after the open stage has, and every switch', () => {
    const src = fakeSource();
    const log: string[] = [];
    const eo = fakeStage(SCRAMBLE);
    eo.watch.mockImplementation(() => { log.push('watch'); });
    eo.feed.mockImplementation(() => { log.push('feed'); return false; });
    stages.eo = eo;
    const off = onSourceChange(() => { log.push(`listener:${src.items().length}`); });
    useSource(src);
    expect(log).toEqual(['listener:0']);
    src.turn(...onCube(SCRAMBLE, GREEN_FRONT), 'F');
    const n = onCube(SCRAMBLE, GREEN_FRONT).length;
    // every turn: the stage's watch (then its feed, once armed), then the listener
    const expected: string[] = [];
    for (let i = 1; i <= n; i++) expected.push('watch', `listener:${i}`);
    expected.push('watch', 'feed', `listener:${n + 1}`);
    expect(log).toEqual(['listener:0', ...expected]);
    useSource(null);
    expect(log[log.length - 1]).toBe(`listener:${n + 1}`);
    expect(log.length).toBe(expected.length + 2);
    off();
    useSource(src);
    expect(log.length).toBe(expected.length + 2);
  });
});

describe('sources: syncDriver', () => {
  it('arms right away when the open stage\'s scramble is the cube\'s state, with no new item', () => {
    const src = fakeSource();
    const eo = fakeStage(null);
    stages.eo = eo;
    // the cube was scrambled before the tab had a scramble; the tab then loads the cube's own state (a lock, the follow)
    src.turn(...onCube(SCRAMBLE, GREEN_FRONT));
    useSource(src);
    eo.scr = SCRAMBLE;
    expect(eo.armed).not.toHaveBeenCalled();
    syncDriver();
    expect(eo.armed).toHaveBeenCalledTimes(1);
    expect(typeof eo.armed.mock.calls[0]![0]).toBe('number');
    src.turn('F');
    expect(eo.feed).toHaveBeenCalledWith(relabelTurns(COLOURS, ['F'], GREEN_FRONT), src.lastT(), 'cube');
  });

  it('asked from inside a feed, runs after the step: the rep just judged ends, the next arms on the new scramble', () => {
    const src = fakeSource();
    const eo = fakeStage(SCRAMBLE);
    stages.eo = eo;
    useSource(src);
    src.turn(...onCube(SCRAMBLE, GREEN_FRONT));
    expect(eo.armed).toHaveBeenCalledTimes(1);
    // a stage that starts its next rep the moment one is done: on the turn that finishes it, the stage makes the
    // cube's state its new scramble and asks for the driver to arm there
    const next = `${SCRAMBLE} ${relabelTurns(COLOURS, ['F'], GREEN_FRONT)}`;
    eo.feed.mockImplementationOnce(() => { eo.scr = next; syncDriver(); return true; });
    src.turn('F');
    expect(eo.feed).toHaveBeenCalledTimes(1);
    expect(eo.armed).toHaveBeenCalledTimes(2);
    expect(src.state()).toBe(expectedFacelets(next, GREEN_FRONT, COLOURS));
    // the new arming was not finished by the old rep's verdict: the next turn is the new rep's first
    src.turn('L');
    expect(eo.feed).toHaveBeenCalledTimes(2);
    expect(eo.feed).toHaveBeenLastCalledWith(relabelTurns(COLOURS, ['L'], GREEN_FRONT), src.lastT(), 'cube');
  });
});

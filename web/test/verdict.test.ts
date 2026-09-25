import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { BRIGHT_PEAK, DARK_PEAK, coloursOf, coloursOfStrict, lightLine, lightVerdict, scrambleCheck, scrambleCheckLine, verdictLine, type Naming } from '../src/ui/verdict';
import { scrambleState } from '../src/scramble';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../src/types';
import { SOLVED } from '../src/cube/state';

/** A naming in which every letter carries the standard colour (white up, green front). */
const standard: Naming = { colourLetter: [...FACE_ORDER], naming: { names: FACE_ORDER.map((f) => DEFAULT_SCHEME_NAMES[f]) } };
/** Five faces named; the sixth (blue) still unnamed. */
const fiveNamed: Naming = { colourLetter: [...FACE_ORDER.slice(0, 5), null], naming: { names: [...FACE_ORDER.slice(0, 5).map((f) => DEFAULT_SCHEME_NAMES[f]), null] } };
/** The solver's letters for the cube seen upside down (x2): what it calls "U" carries yellow, "F" blue. */
const upsideDown: Naming = { colourLetter: [...FACE_ORDER], naming: { names: ['yellow', 'red', 'blue', 'white', 'orange', 'green'] } };
const heldStandard = { down: 'yellow', front: 'green' } as const;

describe('coloursOf', () => {
  it('reads the colour of each letter from the naming', () => {
    expect(coloursOf(upsideDown)).toEqual({ U: 'yellow', R: 'red', F: 'blue', D: 'white', L: 'orange', B: 'green' });
  });
  it('falls back to the standard scheme for an unnamed letter, and strict refuses until all six are named', () => {
    expect(coloursOf(fiveNamed).B).toBe('blue');
    expect(coloursOfStrict(fiveNamed)).toBeNull();
    expect(coloursOfStrict(standard)).toEqual(DEFAULT_SCHEME_NAMES);
  });
  it('ignores a name that is not a colour', () => {
    expect(coloursOf({ colourLetter: ['U'], naming: { names: ['?'] } }).U).toBe('white');
  });
});

describe('scrambleCheck', () => {
  const scramble = "R U R' U'";
  it('is null without a host scramble', () => {
    expect(scrambleCheck(null, standard, [])).toBeNull();
  });
  it('waits for all six centres', () => {
    expect(scrambleCheck({ scramble, hold: heldStandard }, fiveNamed, [])?.note).toBe('waiting for all six centres');
  });
  it('a full correct reading matches the scrambled state', () => {
    const letters = scrambleState(scramble).split('');
    const chk = scrambleCheck({ scramble, hold: heldStandard }, standard, letters)!;
    expect(chk).toMatchObject({ scramble, read: 54, wrong: [] });
    expect(scrambleCheckLine(chk)).toEqual({ text: '54 of 54 stickers read, all match ✓', state: 'ok' });
  });
  it('a partial reading counts only the stickers read', () => {
    const letters = scrambleState(scramble).split('').map((l, i) => (i < 27 ? l : null));
    expect(scrambleCheck({ scramble, hold: heldStandard }, standard, letters)).toMatchObject({ read: 27, wrong: [] });
  });
  it('the solved cube against a scramble differs where the scramble moved stickers', () => {
    const chk = scrambleCheck({ scramble, hold: heldStandard }, standard, SOLVED.split(''))!;
    const moved = [...scrambleState(scramble)].filter((l, i) => l !== SOLVED[i]).length;
    expect(chk.wrong.length).toBe(moved);
    expect(scrambleCheckLine(chk)).toEqual({ text: `54 read, ${moved} differ`, state: 'bad' });
  });
  it('a single misread is close, four are a different cube', () => {
    const letters = scrambleState(scramble).split('');
    letters[0] = letters[0] === 'F' ? 'B' : 'F';
    expect(scrambleCheckLine(scrambleCheck({ scramble, hold: heldStandard }, standard, letters))).toEqual({ text: '54 read, 1 differ (close)', state: 'near' });
    for (const i of [1, 2]) letters[i] = letters[i] === 'F' ? 'B' : 'F';
    expect(scrambleCheckLine(scrambleCheck({ scramble, hold: heldStandard }, standard, letters)).state).toBe('near');
    letters[3] = letters[3] === 'F' ? 'B' : 'F';
    expect(scrambleCheckLine(scrambleCheck({ scramble, hold: heldStandard }, standard, letters)).state).toBe('bad');
  });
  it('the check is by colour: the solver may call the yellow centre by any letter', () => {
    // the same physical cube seen upside down: its positions are cubejs's after x2, and each
    // sticker's letter is what the upside-down solver calls its colour (yellow is its "U")
    const letterOf: Record<string, string> = { U: 'D', D: 'U', F: 'B', B: 'F', R: 'R', L: 'L' };
    const letters = new Cube().move(`${scramble} x2`).asString().split('').map((l) => letterOf[l]);
    expect(scrambleCheck({ scramble, hold: heldStandard }, upsideDown, letters)).toMatchObject({ read: 54, wrong: [] });
    // and the standard reading, claimed by the upside-down naming, is not the scramble
    expect(scrambleCheck({ scramble, hold: heldStandard }, upsideDown, scrambleState(scramble).split(''))!.wrong.length).toBeGreaterThan(3);
  });
  it('a hold whose colours are not adjacent is reported, not thrown', () => {
    const chk = scrambleCheck({ scramble, hold: { down: 'white', front: 'yellow' } }, standard, [])!;
    expect(chk.note).toMatch(/opposite|adjacent|rotation/i);
    expect(scrambleCheckLine(chk).state).toBe('');
  });
  it('an empty reading says so', () => {
    expect(scrambleCheckLine(scrambleCheck({ scramble, hold: heldStandard }, standard, new Array(54).fill(null)))).toEqual({ text: 'no stickers read yet', state: '' });
    expect(scrambleCheckLine(null)).toEqual({ text: 'scan to compare', state: '' });
  });
});

describe('verdictLine', () => {
  it('a lock wins, then a crash, then the solver reason', () => {
    expect(verdictLine(true, 'boom', 'no evidence')).toBe('locked ✓');
    expect(verdictLine(false, 'boom\nat solve.ts:1', 'no evidence')).toBe('solver failed: boom (Capture debug and file it)');
    expect(verdictLine(false, null, 'no evidence')).toBe('no evidence');
    expect(verdictLine(false, null, null)).toBe('–');
  });
});

describe('light', () => {
  it('too dark below the peak floor, fine in the middle', () => {
    expect(lightVerdict(DARK_PEAK - 1, 20, 0)).toBe('too dark');
    expect(lightVerdict(150, 80, 0.05)).toBe('');
  });
  it('too bright when the darkest tenth would survive a darker exposure, whites clip otherwise', () => {
    expect(lightVerdict(BRIGHT_PEAK + 1, 200, 0)).toBe('too bright');
    expect(lightVerdict(200, 60, 0.2)).toBe('whites clip, darkening would lose the blues');
  });
  it('the row', () => {
    expect(lightLine(255, 255, 0, false)).toBe('no readings yet');
    expect(lightLine(150.4, 80.6, 0.051, true)).toBe('150 / 255 (darkest tenth 81) · 5% clipped');
    expect(lightLine(40, 10, 0, true)).toBe('40 / 255 (darkest tenth 10) · 0% clipped · too dark');
  });
});

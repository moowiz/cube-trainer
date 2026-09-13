// Actionable hints from namer refusals (web/src/ui/hint.ts).
import { describe, expect, it } from 'vitest';
import { TOO_SMALL_REASON } from '../src/detect/identify';
import { HintState, hintFor } from '../src/ui/hint';

const small = `${TOO_SMALL_REASON} (24px edge, need 32)`;

describe('hintFor', () => {
  it('says move closer when every quad is too small', () => {
    expect(hintFor([small, small], false)?.key).toBe('closer');
  });
  it('is silent once any face is named, whatever else was refused', () => {
    expect(hintFor([small, 'too dark'], true)).toBeNull();
  });
  it('is silent with no quads at all (nothing to act on)', () => {
    expect(hintFor([], false)).toBeNull();
  });
  it('ignores refusals that are not the user\'s problem', () => {
    expect(hintFor(['lost a tie-break', 'center matches another quad'], false)).toBeNull();
  });
  it('says move closer from the localizer alone when no face was even detected', () => {
    expect(hintFor([], false, true)?.key).toBe('closer');
    expect(hintFor([], true, true)).toBeNull();
  });
  it('says no cube found on a stage-1 miss, and nothing else beats it', () => {
    expect(hintFor([], false, false, true)?.key).toBe('nocube');
    expect(hintFor([], true, false, true)).toBeNull();           // a named face wins
    expect(hintFor([], false, true, true)?.key).toBe('closer');  // too-small is more specific
    expect(hintFor([small], false, false, true)?.key).toBe('closer'); // stage 2 reasons win
  });
  it('picks the majority reason', () => {
    expect(hintFor([small, 'glare: face blown out', 'glare: face blown out'], false)?.key).toBe('glare');
    expect(hintFor(['too dark'], false)?.key).toBe('light');
  });
});

describe('HintState', () => {
  it('holds before showing, then clears instantly when a face reads', () => {
    const s = new HintState(400);
    const h = hintFor([small], false);
    expect(s.update(h, 0)).toBeNull();
    expect(s.update(h, 200)).toBeNull();
    expect(s.update(h, 400)?.key).toBe('closer');
    expect(s.update(null, 450)).toBeNull();
    expect(s.update(h, 500)).toBeNull(); // hold restarts
  });
  it('restarts the hold when the reason changes', () => {
    const s = new HintState(400);
    s.update(hintFor([small], false), 0);
    s.update(hintFor([small], false), 400);
    expect(s.update(hintFor(['too dark'], false), 500)?.key).toBe('closer'); // last shown persists until new one holds
    expect(s.update(hintFor(['too dark'], false), 900)?.key).toBe('light');
  });
});

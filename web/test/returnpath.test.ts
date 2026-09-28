import { describe, expect, it } from 'vitest';
import { sameOriginPath } from '../src/returnpath';

const O = 'https://moowiz.github.io';
const F = '/cube_stuff/';

describe('sameOriginPath (the sign-in page\'s return target)', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(sameOriginPath('/cube_stuff/?tab=solve#x', O, F)).toBe('/cube_stuff/?tab=solve#x');
  });
  it('refuses a protocol-relative URL', () => {
    expect(sameOriginPath('//evil.example/x', O, F)).toBe(F);
  });
  it('refuses a backslash that the parser reads as a second slash', () => {
    expect(sameOriginPath('/\\evil.example', O, F)).toBe(F);
  });
  it('refuses an absolute URL elsewhere, and a javascript: URL', () => {
    expect(sameOriginPath('https://evil.example/', O, F)).toBe(F);
    expect(sameOriginPath('javascript:alert(1)', O, F)).toBe(F);
  });
  it('falls back when there is no return parameter', () => {
    expect(sameOriginPath(null, O, F)).toBe(F);
    expect(sameOriginPath('', O, F)).toBe(F);
  });
});

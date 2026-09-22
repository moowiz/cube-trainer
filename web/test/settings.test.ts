// ui/settings.ts: the localStorage helpers every tab's settings go through
// (docs/maintenance-plan.md 3.4). A fake storage on globalThis; the key
// strings are the callers' and are not exercised here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persisted, readStored, readStoredJson, writeStored } from '../src/ui/settings';

function fakeStorage(store: Map<string, string>, broken = false) {
  return {
    getItem: (k: string) => { if (broken) throw new Error('no storage'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (broken) throw new Error('no storage'); store.set(k, v); },
    removeItem: (k: string) => { if (broken) throw new Error('no storage'); store.delete(k); },
  };
}

describe('readStored / writeStored', () => {
  const store = new Map<string, string>();
  beforeEach(() => { store.clear(); (globalThis as { localStorage?: unknown }).localStorage = fakeStorage(store); });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  it('round-trips a string and removes on null', () => {
    expect(readStored('k')).toBeNull();
    writeStored('k', 'stay');
    expect(readStored('k')).toBe('stay');
    writeStored('k', null);
    expect(readStored('k')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('is nothing when storage throws (private mode)', () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage(store, true);
    expect(() => writeStored('k', 'v')).not.toThrow();
    expect(readStored('k')).toBeNull();
    expect(readStoredJson('k')).toBeNull();
  });

  it('readStoredJson is null for a missing key and for text that is not JSON', () => {
    expect(readStoredJson('k')).toBeNull();
    store.set('k', '{not json');
    expect(readStoredJson('k')).toBeNull();
    store.set('k', '[1,2]');
    expect(readStoredJson('k')).toEqual([1, 2]);
  });
});

describe('persisted', () => {
  const store = new Map<string, string>();
  beforeEach(() => { store.clear(); (globalThis as { localStorage?: unknown }).localStorage = fakeStorage(store); });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  interface S { voice: 'off' | 'read'; spell: string[]; n: number }
  const defaults = (): S => ({ voice: 'off', spell: [], n: 1 });

  it('starts from the defaults when nothing is stored, and save() writes the object', () => {
    const { settings, save } = persisted<S>('zz-test', defaults());
    expect(settings).toEqual(defaults());
    settings.n = 5;
    save();
    expect(JSON.parse(store.get('zz-test')!)).toEqual({ voice: 'off', spell: [], n: 5 });
  });

  it('overlays what was stored on the defaults, as Object.assign does (unknown fields kept, missing ones defaulted)', () => {
    store.set('zz-test', JSON.stringify({ voice: 'read', extra: true }));
    const { settings } = persisted<S>('zz-test', defaults());
    expect(settings).toEqual({ voice: 'read', spell: [], n: 1, extra: true });
  });

  it('runs fix over the merged object, so an out-of-range stored value goes back to the default', () => {
    store.set('zz-test', JSON.stringify({ voice: 'sing', spell: 'no' }));
    const { settings } = persisted<S>('zz-test', defaults(), (s) => {
      if (s.voice !== 'off' && s.voice !== 'read') s.voice = 'off';
      if (!Array.isArray(s.spell)) s.spell = [];
    });
    expect(settings).toEqual({ voice: 'off', spell: [], n: 1 });
  });

  it('ignores a stored value that is not an object or does not parse', () => {
    store.set('zz-test', '"just a string"');
    expect(persisted<S>('zz-test', defaults()).settings).toEqual(defaults());
    store.set('zz-test', '{broken');
    expect(persisted<S>('zz-test', defaults()).settings).toEqual(defaults());
  });
});

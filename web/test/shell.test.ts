// shell.ts's tab/scramble bus: shareScramble, keepScramble, expectedScramble
// and activeTab/showTab. Most of initShell() wires real DOM elements and
// keyboard listeners and is out of scope here (no jsdom in this suite,
// environment: 'node' per vite.config.ts) - this covers the pure-ish parts
// that only touch document.getElementById/querySelector, stubbed minimally.
// writeStored (called by showTab) swallows a missing localStorage on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeTab, expectedScramble, keepScramble, shareScramble, showTab, stages } from '../src/shell';
import type { Stage, Tab } from '../src/shell';

const TABS: readonly Tab[] = ['solve', 'eo', 'f2l', 'ocll', 'pll'];

function fakeStage(scramble: string | null): Stage {
  return {
    load: vi.fn(),
    render: vi.fn(),
    scramble: vi.fn(() => scramble),
    newScramble: vi.fn(),
  };
}

interface Panel { hidden: boolean }

describe('shell: shareScramble / keepScramble / expectedScramble', () => {
  let panels: Record<string, Panel>;
  beforeEach(() => {
    keepScramble(null);
    for (const t of TABS) stages[t] = fakeStage(`${t}-scramble`);
    panels = {};
    for (const t of TABS) panels[`${t}-panel`] = { hidden: true };
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => panels[id] ?? null,
      querySelector: () => null,
    };
  });
  afterEach(() => {
    keepScramble(null);
    delete (globalThis as { document?: unknown }).document;
  });

  it('loads the scramble into every registered stage except `from`', () => {
    shareScramble('R U', null);
    for (const t of TABS) expect(stages[t]!.load).toHaveBeenCalledWith('R U');
  });

  it('a kept tab is not loaded by a share, and is again once the keep is lifted', () => {
    keepScramble('solve');
    shareScramble('F2', null);
    expect(stages.solve!.load).not.toHaveBeenCalled();
    for (const t of TABS) if (t !== 'solve') expect(stages[t]!.load).toHaveBeenCalledWith('F2');

    keepScramble(null);
    shareScramble('B2', null);
    expect(stages.solve!.load).toHaveBeenCalledWith('B2');
  });

  it('expectedScramble() is the active tab\'s stage\'s scramble', () => {
    showTab('f2l');
    expect(activeTab()).toBe('f2l');
    expect(expectedScramble()).toBe('f2l-scramble');

    showTab('pll');
    expect(activeTab()).toBe('pll');
    expect(expectedScramble()).toBe('pll-scramble');
  });

  it('expectedScramble() is null when the active stage has none', () => {
    stages.eo = fakeStage(null);
    showTab('eo');
    expect(expectedScramble()).toBeNull();
  });
});

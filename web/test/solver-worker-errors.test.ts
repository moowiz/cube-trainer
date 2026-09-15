// A solve that throws must come back as an error message: the page's client waits on the
// reply, and a swallowed exception left the scan sheet "solving" for ever (the near-solved
// cube of 2026-09-14 - the verdict row now says what failed).
import { describe, expect, it } from 'vitest';
import { handle, type SolverResponse } from '../src/colour/solve.worker';

describe('solver worker protocol', () => {
  it('reports a throwing solve as an error reply with the same id', () => {
    const out: SolverResponse[] = [];
    const post = (m: SolverResponse) => out.push(m);
    handle({ type: 'reset' }, post);
    // a quad with no readings array: solveBest cannot take it
    handle({ type: 'append', quads: [{} as never], pairings: [], events: [], frames: 1 }, post);
    handle({ type: 'solve', id: 7 }, post);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('error');
    expect(out[0]!.id).toBe(7);
    expect((out[0] as { message: string }).message).toMatch(/\S/);
  });
});

// Counting face turns as done: a smart cube reports a half turn as two quarter turns, which count once.
import { describe, expect, it } from 'vitest';
import { htm } from '../src/cube/alg';

describe('htm', () => {
  it('a half turn reported as two quarters is one turn', () => {
    expect(htm('R R D L L')).toBe(3);
    expect(htm("R2 D L2")).toBe(3);
    expect(htm("R' R'")).toBe(1);
  });
  it('a turn and its undo are two, three quarters are two', () => {
    expect(htm("R R'")).toBe(2);
    expect(htm('R R R')).toBe(2);
    expect(htm('x R y')).toBe(1);
  });
});

// cube/pieces.ts: one home for the piece tables (cubejs's order) and the move model's slot
// order derived from them (docs/maintenance-plan.md 3.3).
import Cube from 'cubejs';
import { describe, expect, it } from 'vitest';
import { CENTER_INDICES, CORNER_COLORS, CORNER_FACELETS, EDGE_COLORS, EDGE_FACELETS, EDGE_POS, EDGE_SLOTS, findEdge, SLOT_INDEX } from '../src/cube/pieces';
import { STICKERS } from '../src/cube/geometry';
import { SOLVED } from '../src/cube/state';

describe('the piece tables', () => {
  it('name the same twelve edges as the move model\'s slots, once each', () => {
    const cubejs = EDGE_COLORS.map((c) => c.join('')).sort();
    expect(cubejs).toEqual([...EDGE_SLOTS].sort());
    expect(new Set(cubejs).size).toBe(12);
  });

  it('every facelet pair carries the letters its name says on a solved cube (cubejs order and slot order)', () => {
    EDGE_FACELETS.forEach(([a, b], i) => expect(SOLVED[a]! + SOLVED[b]!).toBe(EDGE_COLORS[i]!.join('')));
    CORNER_FACELETS.forEach(([a, b, c], i) => expect(SOLVED[a]! + SOLVED[b]! + SOLVED[c]!).toBe(CORNER_COLORS[i]!.join('')));
    EDGE_SLOTS.forEach((name, i) => expect(findEdge(SOLVED, name)).toBe(i));
    CENTER_INDICES.forEach((i) => expect('URFDLB'.indexOf(SOLVED[i]!)).toBe(CENTER_INDICES.indexOf(i)));
  });

  it('the slot positions are the sticker geometry of the slot\'s U/D (or F/B) facelet', () => {
    EDGE_SLOTS.forEach((name, i) => {
      const pos = EDGE_POS[i]!;
      // the named faces are the two axes the edge sits on; the third coordinate is 0
      const axes = { U: [1, 1], D: [1, -1], R: [0, 1], L: [0, -1], F: [2, 1], B: [2, -1] } as const;
      for (const ch of name) { const [ax, sign] = axes[ch as keyof typeof axes]; expect(pos[ax]).toBe(sign); }
      expect(pos.filter((x) => x === 0)).toHaveLength(1);
      expect(STICKERS.some((s) => s.pos.join() === pos.join())).toBe(true);
    });
    expect(SLOT_INDEX.UF).toBe(0);
  });

  it('agrees with cubejs on a turned cube: every edge is found where cubejs put it', () => {
    const f = new Cube().move("R U F' L2 D B").asString();
    for (const name of EDGE_SLOTS) {
      const slot = findEdge(f, name);
      const i = EDGE_COLORS.findIndex((c) => c.join('') === EDGE_SLOTS[slot]);
      const [a, b] = EDGE_FACELETS[i]!;
      expect([f[a], f[b]].sort().join('')).toBe([...name].sort().join(''));
    }
  });
});

// Orientation resolution (M6): recover per-face cyclic rotation from shared
// edges, tested against a synthetic cube projection with known ground truth.
import { describe, expect, it } from 'vitest';
import { identifyNeighbour, orientQuad, resolveOrientations, type OrientableFace } from '../src/detect/orient';
import { visibleFaces } from './helpers';

describe('resolveOrientations', () => {
  it('recovers arbitrary cyclic rotations on a 3-face view', () => {
    const vis = visibleFaces(-0.5, 0.6); // classic 3-quarter view: U, F, R
    expect(vis.length).toBe(3);
    const rolls: Record<string, number> = {};
    const input: OrientableFace[] = vis.map((v, i) => {
      const k = [1, 3, 2][i]; // arbitrary known rolls
      rolls[v.face] = k;
      // roll so that corners[(t+k)%4] = layout corner t  =>  corners[t] = layout[(t-k) mod 4]
      const rolled = v.quad.map((_, t) => v.quad[(((t - k) % 4) + 4) % 4]);
      return { face: v.face, corners: rolled };
    });
    const res = resolveOrientations(input);
    expect(res.pairsUsed).toBe(3); // U-F, U-R, F-R
    expect(res.conflicts).toBe(0);
    for (const v of vis) {
      expect(res.rotations[v.face]).toBe(rolls[v.face]);
      // and orientQuad undoes the roll exactly
      const face = input.find((i) => i.face === v.face)!;
      expect(orientQuad(face.corners, res.rotations[v.face]!)).toEqual(v.quad);
    }
  });

  it('recovers rotations on a 2-face view and leaves lone faces unresolved', () => {
    const vis = visibleFaces(0, 0.9); // F and R (near edge-on)
    expect(vis.length).toBe(2);
    const input: OrientableFace[] = vis.map((v) => ({
      face: v.face,
      corners: v.quad.map((_, t) => v.quad[(t + 2) % 4]), // roll both by 2
    }));
    const res = resolveOrientations(input);
    expect(res.rotations[vis[0].face]).toBe(2);
    expect(res.rotations[vis[1].face]).toBe(2);

    const lone = resolveOrientations([input[0]]);
    expect(lone.rotations[vis[0].face]).toBeUndefined();
    expect(lone.pairsUsed).toBe(0);
  });

  it('ignores pairs whose quads do not actually touch (bad detection)', () => {
    const vis = visibleFaces(-0.5, 0.6);
    const input: OrientableFace[] = vis.slice(0, 2).map((v) => ({ face: v.face, corners: v.quad }));
    // teleport the second quad far away: shared-edge match must fail
    const moved = input[1].corners.map(([x, y]) => [x + 500, y] as [number, number]);
    const res = resolveOrientations([input[0], { face: input[1].face, corners: moved }]);
    expect(res.pairsUsed).toBe(0);
  });
});

describe('identifyNeighbour (adjacency identity)', () => {
  it('names the third face at a corner from an oriented neighbour, with its rotation', () => {
    // this view shows F, D and L; every quad in layout order (rotation 0),
    // then rolled by a known amount to check the rotation comes back
    const vis = visibleFaces(-0.5, 0.6);
    expect(vis.map((v) => v.face).sort()).toEqual(['D', 'F', 'L']);
    const byFace = Object.fromEntries(vis.map((v) => [v.face, v.quad])) as Record<string, [number, number][]>;
    for (const [known, unknown] of [['F', 'D'], ['F', 'L'], ['D', 'L'], ['D', 'F'], ['L', 'F'], ['L', 'D']] as const) {
      for (let roll = 0; roll < 4; roll++) {
        const rolled = orientQuad(byFace[unknown]!, roll); // rolled[t] = layout corner (t + roll)
        const id = identifyNeighbour({ face: known, corners: byFace[known]! }, rolled);
        expect(id, `${known} -> ${unknown} roll ${roll}`).not.toBeNull();
        expect(id!.face).toBe(unknown);
        // orientQuad(rolled, id.rotation) must restore layout order
        const restored = orientQuad(rolled, id!.rotation);
        restored.forEach((c, t) => { expect(c[0]).toBeCloseTo(byFace[unknown]![t]![0], 6); expect(c[1]).toBeCloseTo(byFace[unknown]![t]![1], 6); });
      }
    }
  });

  it('returns null for quads that share no edge', () => {
    const vis = visibleFaces(-0.5, 0.6);
    const f = vis.find((v) => v.face === 'F')!.quad;
    const far = f.map(([x, y]) => [x + 400, y + 400] as [number, number]);
    expect(identifyNeighbour({ face: 'F', corners: f }, far)).toBeNull();
  });
});

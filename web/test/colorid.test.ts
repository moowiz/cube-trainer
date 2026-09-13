// Session colour clusters (detect/colorid.ts): ordinal naming on real
// phone measurements, cluster birth/merge, adjacency bindings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIRTH_DIST, ColorClusters, hueDeg, nameClusters } from '../src/detect/colorid';
import { FACE_ORDER } from '../src/types';
import type { ColorName, FaceId, Lab } from '../src/types';

// The fully measured session scan-debug-1789291642684 (warm room light):
// every centre exemplar in the clustering space. These are what the old
// nominal-prior namer got wrong repeatedly; ordering must get them right.
const dir = new URL('./fixtures/', import.meta.url);
const full = JSON.parse(readFileSync(new URL('scan-debug-1789291642684.json', dir), 'utf8')) as {
  exemplars: { face: FaceId; lab: Lab }[];
};
const MEASURED: Record<FaceId, Lab> = Object.fromEntries(full.exemplars.map((e) => [e.face, e.lab])) as Record<FaceId, Lab>;
const EXPECT: Record<FaceId, ColorName> = { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' };

/** Nine cells whose clustering-space centre is `c` (8 neutral cells at L 0 pin the median). */
function cellsWithCentre(c: Lab): Lab[] {
  const cells: Lab[] = Array.from({ length: 9 }, () => ({ L: 0, a: c.a, b: c.b }));
  cells[4] = { L: c.L, a: c.a, b: c.b };
  return cells;
}

describe('nameClusters (ordinal)', () => {
  it('names all six measured centres of a warm-light session correctly', () => {
    const named = nameClusters(FACE_ORDER.map((f, i) => ({ id: i, centroid: MEASURED[f] })));
    FACE_ORDER.forEach((f, i) => expect(named.get(i)).toBe(EXPECT[f]));
  });

  it('is invariant to a global cast and desaturation', () => {
    const cast = (c: Lab): Lab => ({ L: c.L, a: c.a * 0.7 + 4, b: c.b * 0.7 + 8 });
    const named = nameClusters(FACE_ORDER.map((f, i) => ({ id: i, centroid: cast(MEASURED[f]) })));
    FACE_ORDER.forEach((f, i) => expect(named.get(i)).toBe(EXPECT[f]));
  });

  it('leaves a lone warm cluster unnamed, names it once the other warm one appears', () => {
    const one = nameClusters([{ id: 1, centroid: MEASURED.U }, { id: 2, centroid: MEASURED.R }, { id: 3, centroid: MEASURED.F }]);
    expect(one.get(1)).toBe('white');
    expect(one.get(3)).toBe('green');
    expect(one.get(2)).toBeUndefined();
    const two = nameClusters([{ id: 2, centroid: MEASURED.R }, { id: 5, centroid: MEASURED.L }]);
    expect(two.get(2)).toBe('red');
    expect(two.get(5)).toBe('orange');
    expect(hueDeg(MEASURED.R)).toBeLessThan(hueDeg(MEASURED.L));
  });

  it('a binding from adjacency names a lone warm cluster and the next warm one gets the other colour', () => {
    const named = nameClusters([{ id: 2, centroid: MEASURED.L, bound: 'orange' }, { id: 9, centroid: MEASURED.R }]);
    expect(named.get(2)).toBe('orange');
    expect(named.get(9)).toBe('red');
  });

  it('a lone dark blue (nearly neutral) is not called white; it names once white appears', () => {
    const noWhite = nameClusters((['R', 'F', 'D', 'L', 'B'] as FaceId[]).map((f, i) => ({ id: i, centroid: MEASURED[f] })));
    expect([...noWhite.values()]).not.toContain('white');
    expect(noWhite.get(4)).toBeUndefined(); // the blue: white-or-blue until the other shows up
    expect(noWhite.size).toBe(4);
    const all = nameClusters(FACE_ORDER.map((f, i) => ({ id: i, centroid: MEASURED[f] })));
    expect(all.get(5)).toBe('blue');
    expect(all.get(0)).toBe('white');
  });
});

describe('ColorClusters (online)', () => {
  it('births one cluster per colour and assigns repeats to it', () => {
    const cc = new ColorClusters();
    const ids: Record<string, number> = {};
    for (let rep = 0; rep < 5; rep++) {
      for (const f of FACE_ORDER) {
        const jitter = (rep - 2) * 1.5;
        const id = cc.observe(cellsWithCentre({ L: MEASURED[f].L + jitter, a: MEASURED[f].a + jitter, b: MEASURED[f].b - jitter }));
        if (rep === 0) ids[f] = id; else expect(id).toBe(ids[f]);
      }
    }
    expect(cc.size()).toBe(6);
    for (const f of FACE_ORDER) expect(cc.faceOf(ids[f]!)).toBe(f);
    const map = cc.faceMap();
    expect(map.size).toBe(6);
  });

  it('never grows past six: a seventh colour joins its nearest cluster', () => {
    const cc = new ColorClusters();
    for (const f of FACE_ORDER) cc.observe(cellsWithCentre(MEASURED[f]));
    const id = cc.observe(cellsWithCentre({ L: 0, a: 20, b: 80 })); // an odd yellow-orange
    expect(cc.size()).toBe(6);
    expect(cc.faceOf(id)).not.toBeNull(); // it joined an existing, named cluster
  });

  it('merges two clusters that drift together and reports the merge', () => {
    const cc = new ColorClusters();
    const merges: [number, number][] = [];
    cc.onMerge = (from, into) => merges.push([from, into]);
    const a = cc.observe(cellsWithCentre({ L: 0, a: 50, b: 30 }));
    const b = cc.observe(cellsWithCentre({ L: 0, a: 50 + BIRTH_DIST + 2, b: 30 }));
    expect(b).not.toBe(a);
    // a's readings drift toward b (each still nearest a) until the medians are within MERGE_DIST
    for (let step = 52; step <= 66; step += 2) for (let i = 0; i < 12; i++) cc.observe(cellsWithCentre({ L: 0, a: step, b: 30 }));
    expect(cc.size()).toBe(1);
    expect(merges).toEqual([[b, a]]);
  });

  it('bind() refuses a colour already bound to another cluster', () => {
    const cc = new ColorClusters();
    const r = cc.observe(cellsWithCentre(MEASURED.R));
    const l = cc.observe(cellsWithCentre(MEASURED.L));
    expect(cc.bind(r, 'red')).toBe(true);
    expect(cc.bind(l, 'red')).toBe(false);
    expect(cc.colorOf(l)).toBe('orange');
  });
});

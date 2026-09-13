// Session colour clusters (detect/colorid.ts): ordinal naming on real
// phone measurements, cluster birth/merge, adjacency bindings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIND_MIN_VOTES, BIRTH_DIST, ColorClusters, couldBe, hueDeg, nameClusters, sameCluster } from '../src/detect/colorid';
import { labDistance } from '../src/color';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../src/types';
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

  it('a lone dark blue (chroma 27) is blue, never white; a paler cool cluster waits for the pair', () => {
    const noWhite = nameClusters((['R', 'F', 'D', 'L', 'B'] as FaceId[]).map((f, i) => ({ id: i, centroid: MEASURED[f] })));
    expect([...noWhite.values()]).not.toContain('white');
    expect(noWhite.get(4)).toBe('blue');
    expect(noWhite.size).toBe(5);
    const pale = nameClusters([{ id: 1, centroid: { L: 0, a: 2, b: -15 } }, { id: 2, centroid: MEASURED.F }]);
    expect(pale.get(1)).toBeUndefined(); // white-or-blue until the other shows up
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

  it('a seventh colour gets its own cluster, takes no rank, and aliases to the face it could be', () => {
    const cc = new ColorClusters();
    for (const f of FACE_ORDER) cc.observe(cellsWithCentre(MEASURED[f]));
    const id = cc.observe(cellsWithCentre({ L: 0, a: 0, b: 80 })); // an odd bright yellow, 28 from yellow
    expect(cc.size()).toBe(7);
    const c = cc.clusters().find((x) => x.id === id)!;
    expect(c.aliasOf).not.toBeNull();
    expect(c.color).toBe('yellow');
    for (const f of FACE_ORDER) expect(cc.faceOf(f === 'D' ? id : cc.clusters().find((x) => x.color === DEFAULT_SCHEME_NAMES[f] && x.aliasOf === null)!.id)).toBe(f);
    const junk = cc.observe(cellsWithCentre({ L: 0, a: 35, b: -15 })); // no rank of its own, nothing it could be within ALIAS_DIST
    expect(cc.faceOf(junk)).toBeNull();
    expect(cc.faceMap().size).toBe(7);
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

// scan-debug-1789308171326: a stale rotation on a swapped track bound the
// yellow cluster "orange" and the orange cluster "blue" (one frame each,
// permanent), and the real blue was left with no name. Ordinal rank must
// win over a binding, and such bindings must never be admitted.
describe('adjacency bindings vs ordinal rank', () => {
  const cascade = JSON.parse(readFileSync(new URL('scan-debug-1789308171326.json', dir), 'utf8')) as {
    clusters: { id: number; centroid: Lab; bound: ColorName | null }[];
  };
  const byId = (id: number) => cascade.clusters.find((c) => c.id === id)!.centroid;
  const RIGHT: Record<number, ColorName> = { 1: 'blue', 2: 'green', 3: 'white', 5: 'yellow', 6: 'red', 7: 'orange' };

  it('names the six clusters of the cascade capture by rank despite its bindings', () => {
    const named = nameClusters(cascade.clusters);
    for (const [id, col] of Object.entries(RIGHT)) expect(named.get(Number(id))).toBe(col);
  });

  it('couldBe refuses the impossible bindings of the capture and admits the possible one', () => {
    expect(couldBe(byId(5), 'orange')).toBe(false); // a = -9: not warm
    expect(couldBe(byId(7), 'blue')).toBe(false); // b = +34: not cool
    expect(couldBe(byId(6), 'red')).toBe(true);
    expect(couldBe(byId(1), 'blue')).toBe(true);
    expect(couldBe(byId(3), 'white')).toBe(true);
  });

  it('suggest() rejects impossible colours outright and counts rejections', () => {
    const cc = new ColorClusters();
    const y = cc.observe(cellsWithCentre(byId(5)));
    expect(cc.suggest(y, 'orange')).toBe('rejected');
    expect(cc.rejectedBinds).toBe(1);
    expect(cc.bindingOf(y)).toBeNull();
  });

  it('a binding needs BIND_MIN_VOTES agreeing frames and erodes under contradiction', () => {
    const cc = new ColorClusters();
    const r = cc.observe(cellsWithCentre(MEASURED.R)); // lone warm: undecidable by rank
    expect(cc.colorOf(r)).toBeNull();
    for (let i = 1; i < BIND_MIN_VOTES; i++) expect(cc.suggest(r, 'red')).toBe('pending');
    expect(cc.colorOf(r)).toBeNull();
    expect(cc.suggest(r, 'red')).toBe('bound');
    expect(cc.colorOf(r)).toBe('red');
    // a long-standing binding survives one contradicting frame, not a run of them
    for (let i = 0; i < 4; i++) cc.suggest(r, 'red');
    cc.contradict(r);
    expect(cc.colorOf(r)).toBe('red');
    for (let i = 0; i < 3; i++) cc.contradict(r);
    expect(cc.colorOf(r)).toBeNull();
  });

  it('a split vote never binds: the lead must double the runner-up', () => {
    const cc = new ColorClusters();
    const r = cc.observe(cellsWithCentre(MEASURED.R));
    for (let i = 0; i < BIND_MIN_VOTES; i++) { cc.suggest(r, 'red'); cc.suggest(r, 'orange'); }
    expect(cc.bindingOf(r)).toBeNull();
  });

  it('rank overrules a binding once the second warm cluster shows up', () => {
    const cc = new ColorClusters();
    const l = cc.observe(cellsWithCentre(MEASURED.L));
    expect(cc.bind(l, 'red')).toBe(true); // wrong, but admissible while it is the only warm cluster
    expect(cc.colorOf(l)).toBe('red');
    const r = cc.observe(cellsWithCentre(MEASURED.R));
    expect(cc.colorOf(r)).toBe('red'); // lower hue
    expect(cc.colorOf(l)).toBe('orange');
  });
});

// scan-debug-1789308736891: green split into two clusters (chroma 62 on the
// lit side, 40 in shadow, 22 apart), which used up the sixth slot; the white
// centre was forced into the dim green, and adjacency then bound that
// cluster "white", the blue "yellow" and the yellow "blue".
describe('a colour split over two clusters', () => {
  const split = JSON.parse(readFileSync(new URL('scan-debug-1789308736891.json', dir), 'utf8')) as {
    clusters: { id: number; centroid: Lab; bound: ColorName | null }[];
  };
  const RIGHT: Record<number, ColorName> = { 1: 'red', 2: 'green', 3: 'orange', 5: 'blue', 6: 'yellow' };

  it('ranks name five and leave the dim green unnamed; the three cascade bindings are impossible', () => {
    const named = nameClusters(split.clusters);
    for (const [id, col] of Object.entries(RIGHT)) expect(named.get(Number(id))).toBe(col);
    expect(named.get(4)).toBeUndefined();
    for (const c of split.clusters) if (c.bound && c.id !== 1) expect(couldBe(c.centroid, c.bound)).toBe(false); // 1 is the one honest binding (red)
  });

  it('the dim green aliases to green and a late white centre still gets its own cluster', () => {
    const cc = new ColorClusters();
    const ids = new Map<number, number>();
    for (const c of split.clusters) ids.set(c.id, cc.observe(cellsWithCentre(c.centroid)));
    expect(cc.size()).toBe(6);
    const dim = cc.clusters().find((x) => x.id === ids.get(4))!;
    expect(dim.color).toBe('green');
    expect(dim.aliasOf).toBe(ids.get(2));
    const white = cc.observe(cellsWithCentre({ L: 0, a: 1, b: 9 }));
    expect(cc.size()).toBe(7);
    expect(cc.faceOf(white)).toBe('U');
    expect(cc.faceOf(ids.get(4)!)).toBe('F');
    expect(cc.faceMap().size).toBe(7);
  });
});

describe('warm clusters: red/orange by hue gap', () => {
  const warm = (hue: number, c = 65): Lab => ({ L: 0, a: c * Math.cos((hue * Math.PI) / 180), b: c * Math.sin((hue * Math.PI) / 180) });

  it('daylight red and orange 16 apart in ab are born as two clusters (hue 13 apart)', () => {
    const split = JSON.parse(readFileSync(new URL('scan-debug-1789308736891.json', dir), 'utf8')) as { clusters: { id: number; centroid: Lab }[] };
    const red = split.clusters.find((c) => c.id === 1)!.centroid;
    const orange = split.clusters.find((c) => c.id === 3)!.centroid;
    expect(labDistance(red, orange)).toBeLessThan(BIRTH_DIST);
    expect(sameCluster(red, orange, labDistance(red, orange))).toBe(false);
    const cc = new ColorClusters();
    const r = cc.observe(cellsWithCentre(red));
    const o = cc.observe(cellsWithCentre(orange));
    expect(o).not.toBe(r);
    expect(cc.colorOf(r)).toBe('red');
    expect(cc.colorOf(o)).toBe('orange');
  });

  it('a red seen twice (4 deg apart) plus orange: the gap splits them 2 + 1', () => {
    const named = nameClusters([{ id: 1, centroid: warm(30) }, { id: 2, centroid: warm(34) }, { id: 3, centroid: warm(47) }]);
    expect(named.get(1)).toBe('red');
    expect(named.get(2)).toBe('red');
    expect(named.get(3)).toBe('orange');
  });

  it('two warm clusters 4 deg apart are one colour seen twice, not red and orange', () => {
    expect(nameClusters([{ id: 1, centroid: warm(30) }, { id: 2, centroid: warm(34) }]).size).toBe(0);
    // bound red on one: the other is red too (alias), never the remaining orange
    const bound = nameClusters([{ id: 1, centroid: warm(30), bound: 'red' }, { id: 2, centroid: warm(34) }]);
    expect(bound.get(1)).toBe('red');
    expect(bound.get(2)).toBeUndefined();
    const cc = new ColorClusters();
    const a = cc.observe(cellsWithCentre(warm(30)));
    const b = cc.observe(cellsWithCentre(warm(34, 40))); // same hue band, shadow side: 25 away in ab
    expect(b).not.toBe(a);
    expect(cc.bind(a, 'red')).toBe(true);
    expect(cc.colorOf(b)).toBe('red');
    expect(cc.clusters().find((c) => c.id === b)!.aliasOf).toBe(a);
  });

  it('a lone dim green is never yellow (hue 145 is past the yellow band)', () => {
    expect(nameClusters([{ id: 1, centroid: { L: 0, a: -33, b: 23 } }]).get(1)).toBe('green');
    expect(couldBe({ L: 0, a: -33, b: 23 }, 'yellow')).toBe(false);
  });
});

// scan-debug-1789311565144: no yellow cluster after a minute on the yellow
// face - junk and split clusters reached six first and the alien gate then
// refused every yellow frame (scan-main). In the clusters themselves: a
// chroma-23 skin cluster grouped into red, and a dark blue aliased to white.
describe('junk clusters take no rank', () => {
  const cap = JSON.parse(readFileSync(new URL('scan-debug-1789311565144.json', dir), 'utf8')) as {
    clusters: { id: number; centroid: Lab; bound: ColorName | null }[];
  };
  const byId = (id: number) => cap.clusters.find((c) => c.id === id)!.centroid;

  it('a warm cluster at chroma 23 is neither red nor orange, and aliases to nothing', () => {
    expect(nameClusters(cap.clusters).get(9)).toBeUndefined();
    expect(couldBe(byId(9), 'red')).toBe(false);
    expect(couldBe(byId(9), 'orange')).toBe(false);
    expect(couldBe(byId(9), 'white')).toBe(false); // chroma 23: skin, not a pale white
    const cc = new ColorClusters();
    for (const id of [1, 4, 5, 6, 7]) cc.observe(cellsWithCentre(byId(id)));
    const skin = cc.observe(cellsWithCentre(byId(9)));
    expect(cc.colorOf(skin)).toBeNull();
  });

  it('a cool near-neutral (dark blue) never aliases to white', () => {
    expect(couldBe(byId(10), 'white')).toBe(false);
    const cc = new ColorClusters();
    for (const id of [1, 4, 5, 6, 7]) cc.observe(cellsWithCentre(byId(id)));
    const dark = cc.observe(cellsWithCentre(byId(10)));
    expect(cc.colorOf(dark)).not.toBe('white');
  });

  it('the five real colours of the capture keep their names', () => {
    const named = nameClusters(cap.clusters);
    expect(named.get(1)).toBe('blue');
    expect(named.get(4)).toBe('red');
    expect(named.get(5)).toBe('white');
    expect(named.get(6)).toBe('green');
    expect(named.get(7)).toBe('orange');
    expect([...named.values()]).not.toContain('yellow');
  });
});

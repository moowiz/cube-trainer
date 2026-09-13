// Session colour clusters: which of the six colours a face's centre is,
// decided RELATIVELY (pipeline step 7 redesign, 2026-09-13).
//
// Every centre reading of the session goes into an online clustering in the
// clustering space (Lab with the face-relative lightness crushed, exactly
// what assembleState clusters in). A reading joins the nearest cluster when
// it is close enough, otherwise it starts a new one, up to six. Clusters
// are then NAMED ORDINALLY: white is the least chromatic, blue has the most
// negative b, green the most negative a, yellow the largest b among the
// low-a ones, and of the two warm clusters the one with the larger hue
// angle is orange. Ordering survives any global colour cast, which is what
// matching against nominal colours never did (nominal blue sat 55 from a
// real blue under warm light; a solid white face's normalized L is 0 while
// the nominal white prior carried L 47 - fixtures scan-debug-1789290604959
// and -1789292442001).
//
// The warm pair is the one genuinely ambiguous case while only one of red /
// orange has been seen. Adjacency resolves it before colour can: a warm
// face sharing an edge with an identified neighbour of known rotation is
// the face on that side of the neighbour (suggest()), and once the second
// warm cluster appears the hue ordering takes over.
//
// Geometry is the weaker witness, so it only ever fills a gap the ordinal
// rules leave open, and only with accumulated evidence: a binding needs
// BIND_MIN_VOTES agreeing frames, must be chromatically possible for the
// centroid (couldBe), and erodes when the bound face turns up opposite a
// lettered one. scan-debug-1789308171326 is what one-frame permanent
// bindings did: a stale rotation on a swapped track bound the yellow
// cluster "orange" and the orange cluster "blue" in a single cascade, and
// the real blue then had no name left.
//
// One colour can split into two clusters - the same green read 22 apart on
// the lit and the shadowed side of the cube in scan-debug-1789308736891 -
// so births are not capped at six: the ranks name six, and every leftover
// cluster ALIASES to the nearest named cluster whose colour it could be
// (the white centre had nowhere to go when the split green ate the sixth
// slot, and was forced into the green cluster). Junk clusters (a hand, the
// background) alias to nothing and never vote.
//
// Cluster ids are stable for the session (a cluster keeps its id as its
// centroid follows the reservoir median), so the voter keys sticker samples
// by cluster id and the cluster -> face letter binding is applied at lock,
// merging the samples of every cluster mapped to a face.
import { labDistance, labMedian } from '../color';
import { CENTER_MIN_DIST, normalizeFaceCells } from '../state';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';
import type { ColorName, FaceId, Lab } from '../types';

/** A new centre reading further than this from every centroid starts a new cluster. */
export const BIRTH_DIST = 2 * CENTER_MIN_DIST;
/** Two centroids closer than this are the same colour: merge. */
export const MERGE_DIST = CENTER_MIN_DIST;
const RESERVOIR = 40;
/** Hard ceiling on session clusters (junk protection only; six are named, the rest alias or idle). */
const MAX_CLUSTERS = 10;
/** An unnamed cluster this close to a named one it could be joins that face. */
export const ALIAS_DIST = 2 * BIRTH_DIST;
/** White: the least chromatic cluster, and it must actually be low-chroma (measured 7-18; skin starts at 23). */
const WHITE_MAX_CHROMA = 20;
/** Blue needs this much negative b; green this much negative a. */
const BLUE_MAX_B = -8;
const GREEN_MAX_A = -12;
/**
 * The warm/yellow side: b > 0 with real chroma; yellow is the high-hue end
 * of it. Sticker reds/oranges/yellows measure chroma 45-80 in every capture
 * (a dim red 48); skin and a wooden desk sit at 20-28 and were twice grouped
 * into "red" by hue (scan-debug-1789310783346, -1789311565144).
 */
const WARM_MIN_CHROMA = 30;
const YELLOW_MIN_HUE = 78;
/** Green starts well above this (measured 143-155); yellow reads 88-102. */
const YELLOW_MAX_HUE = 120;
const YELLOW_MAX_A = 25;
/** Two chromatic readings whose hues differ by more than this are different colours, whatever their ab distance. */
const HUE_SPLIT_DEG = 8;
const HUE_SPLIT_MIN_CHROMA = 30;
/** Among the warm clusters, the largest hue gap separates red from orange only if it is at least this wide. */
const WARM_MIN_GAP_DEG = 8;
/** Agreeing adjacency frames before a binding applies (and the lead it needs over the runner-up). */
export const BIND_MIN_VOTES = 6;
const BIND_LEAD = 2;
/** Votes a binding loses when its face sits opposite a lettered face in a frame. */
const CONTRADICT_COST = 2;

export interface ColorCluster {
  id: number;
  centroid: Lab;
  n: number;
  /** Ordinal colour, null while undecidable (a lone warm cluster). */
  color: ColorName | null;
  /** Colour the adjacency evidence supports; applied only where the ordinal rules leave a gap. */
  bound: ColorName | null;
  /** Named by proximity to this (rank-named) cluster rather than by rank itself. */
  aliasOf: number | null;
}

export type BindResult = 'rejected' | 'pending' | 'bound';

const COLOR_TO_FACE: Record<ColorName, FaceId> = Object.fromEntries(
  FACE_ORDER.map((f) => [DEFAULT_SCHEME_NAMES[f], f]),
) as Record<ColorName, FaceId>;

/** Hue angle in degrees, [0, 360). */
export function hueDeg(c: Lab): number {
  const h = (Math.atan2(c.b, c.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

const chroma = (c: Lab) => Math.hypot(c.a, c.b);
const isCool = (c: Lab) => c.b < BLUE_MAX_B;
const isNeutral = (c: Lab) => chroma(c) < WHITE_MAX_CHROMA;
const isWarmish = (c: Lab) => c.b > 0 && chroma(c) > WARM_MIN_CHROMA;
const isYellowish = (c: Lab) => isWarmish(c) && hueDeg(c) > YELLOW_MIN_HUE && hueDeg(c) < YELLOW_MAX_HUE && c.a < YELLOW_MAX_A;
const isWarm = (c: Lab) => isWarmish(c) && hueDeg(c) < YELLOW_MIN_HUE;

/**
 * Whether a centroid could be this colour at all - the same coarse
 * predicates the ordinal rules rank within. Adjacency evidence for an
 * impossible colour is a geometry error, never a colour surprise.
 */
/** Smallest angle between two hues, degrees. */
function hueGap(x: Lab, y: Lab): number {
  const d = Math.abs(hueDeg(x) - hueDeg(y)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Whether one centre reading belongs to an existing cluster. Red and orange
 * sit 16 apart in ab under daylight (scan-debug-1789308736891) while one
 * green reads 22 apart on the lit and the shadowed side, so ab distance
 * alone cannot tell "same colour, other lighting" from "the other warm
 * colour": a clear hue difference between two saturated readings always
 * splits. Over-splitting is cheap (leftover clusters alias), merging red
 * into orange is not.
 */
export function sameCluster(reading: Lab, centroid: Lab, d: number): boolean {
  if (d > BIRTH_DIST) return false;
  return !(chroma(reading) > HUE_SPLIT_MIN_CHROMA && chroma(centroid) > HUE_SPLIT_MIN_CHROMA && hueGap(reading, centroid) > HUE_SPLIT_DEG);
}

export function couldBe(c: Lab, color: ColorName): boolean {
  switch (color) {
    // a cool near-neutral is a dark blue, never white (the ranks leave the
    // pair undecided; an alias must not decide it the wrong way)
    case 'white': return isNeutral(c) && !isCool(c);
    case 'blue': return isCool(c);
    case 'green': return c.a < GREEN_MAX_A;
    case 'yellow': return isYellowish(c);
    case 'red':
    case 'orange': return isWarm(c);
  }
}

export class ColorClusters {
  private reservoirs = new Map<number, Lab[]>();
  private centroids = new Map<number, Lab>();
  /** Adjacency votes per cluster and colour; the binding is derived from them. */
  private evidence = new Map<number, Map<ColorName, number>>();
  private nextId = 1;
  /** Suggestions refused because the colour was impossible for the centroid (debug). */
  rejectedBinds = 0;
  /** Bumped on every structural change; consumers can cache on it. */
  version = 0;
  /** Called when two clusters merge (from -> into), so vote reservoirs can follow. */
  onMerge?: (from: number, into: number) => void;

  reset(): void {
    this.reservoirs.clear();
    this.centroids.clear();
    this.evidence.clear();
    this.nextId = 1;
    this.rejectedBinds = 0;
    this.version++;
  }

  /** The clustering-space centre of a 9-cell face reading. */
  static centreOf(cells: readonly Lab[]): Lab {
    return normalizeFaceCells(cells)[4]!;
  }

  /** Add one face's 9-cell reading; returns the cluster id its centre belongs to. */
  observe(cells: readonly Lab[]): number {
    const c = ColorClusters.centreOf(cells);
    let best = -1;
    let bestD = Infinity;
    for (const [id, cen] of this.centroids) {
      const d = labDistance(c, cen);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best < 0 || (!sameCluster(c, this.centroids.get(best)!, bestD) && this.centroids.size < MAX_CLUSTERS)) {
      best = this.nextId++;
      this.reservoirs.set(best, []);
      this.version++;
    }
    const r = this.reservoirs.get(best)!;
    r.push(c);
    if (r.length > RESERVOIR) r.shift();
    this.centroids.set(best, labMedian(r));
    this.mergeClose();
    return best;
  }

  /** Nearest cluster of a reading without recording it (for a face that may not vote). */
  nearest(cells: readonly Lab[]): { id: number; d: number; second: number } | null {
    return this.nearestLab(ColorClusters.centreOf(cells));
  }

  /** Nearest cluster of one clustering-space Lab (a single sticker, for the debug readout). */
  nearestLab(c: Lab): { id: number; d: number; second: number } | null {
    let id = -1;
    let d = Infinity;
    let second = Infinity;
    for (const [cid, cen] of this.centroids) {
      const x = labDistance(c, cen);
      if (x < d) { second = d; d = x; id = cid; } else if (x < second) second = x;
    }
    return id < 0 ? null : { id, d, second };
  }

  private mergeClose(): void {
    const ids = [...this.centroids.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (!this.centroids.has(a) || !this.centroids.has(b)) continue;
        const ca = this.centroids.get(a)!;
        const cb = this.centroids.get(b)!;
        if (labDistance(ca, cb) < MERGE_DIST && sameCluster(ca, cb, 0)) {
          // keep the older id (lower), fold the younger reservoir in
          const [keep, drop] = a < b ? [a, b] : [b, a];
          const r = [...this.reservoirs.get(keep)!, ...this.reservoirs.get(drop)!].slice(-RESERVOIR);
          this.reservoirs.set(keep, r);
          this.centroids.set(keep, labMedian(r));
          this.reservoirs.delete(drop);
          this.centroids.delete(drop);
          this.onMerge?.(drop, keep);
          const ev = this.evidence.get(keep) ?? new Map<ColorName, number>();
          for (const [col, n] of this.evidence.get(drop) ?? []) ev.set(col, (ev.get(col) ?? 0) + n);
          if (ev.size) this.evidence.set(keep, ev);
          this.evidence.delete(drop);
          this.version++;
        }
      }
    }
  }

  /**
   * One frame of adjacency evidence that cluster `id` is `color`. Refused
   * when the colour is impossible for the centroid or already bound to
   * another cluster; otherwise counted, and 'bound' once the votes carry.
   */
  suggest(id: number, color: ColorName): BindResult {
    if (!this.admissible(id, color)) return 'rejected';
    const ev = this.evidence.get(id) ?? new Map<ColorName, number>();
    ev.set(color, (ev.get(color) ?? 0) + 1);
    this.evidence.set(id, ev);
    this.version++;
    return this.bindingOf(id) === color ? 'bound' : 'pending';
  }

  /** Bind outright (a suggestion with a full quorum of votes). Same refusals as suggest(). */
  bind(id: number, color: ColorName): boolean {
    if (!this.admissible(id, color)) return false;
    const ev = this.evidence.get(id) ?? new Map<ColorName, number>();
    let top = 0;
    for (const [col, n] of ev) if (col !== color) top = Math.max(top, n);
    ev.set(color, Math.max(ev.get(color) ?? 0, BIND_MIN_VOTES, BIND_LEAD * top));
    this.evidence.set(id, ev);
    this.version++;
    return true;
  }

  private admissible(id: number, color: ColorName): boolean {
    const cen = this.centroids.get(id);
    if (!cen) return false;
    if (!couldBe(cen, color)) { this.rejectedBinds++; return false; }
    for (const other of this.centroids.keys()) if (other !== id && this.bindingOf(other) === color) return false;
    return true;
  }

  /** The cluster's binding was contradicted (its face sat opposite a lettered face): erode it. */
  contradict(id: number): void {
    const b = this.bindingOf(id);
    const ev = this.evidence.get(id);
    if (!b || !ev) return;
    ev.set(b, Math.max(0, (ev.get(b) ?? 0) - CONTRADICT_COST));
    this.version++;
  }

  /** The colour the accumulated adjacency evidence supports, or null. */
  bindingOf(id: number): ColorName | null {
    const ev = this.evidence.get(id);
    if (!ev) return null;
    const ranked = [...ev].sort((x, y) => y[1] - x[1]);
    const [lead, n] = ranked[0] ?? [null, 0];
    const second = ranked[1]?.[1] ?? 0;
    return lead && n >= BIND_MIN_VOTES && n >= BIND_LEAD * second ? lead : null;
  }

  size(): number {
    return this.centroids.size;
  }

  /** All clusters with their ordinal colour names. */
  clusters(): ColorCluster[] {
    const list: ColorCluster[] = [...this.centroids].map(([id, centroid]) => ({
      id, centroid, n: this.reservoirs.get(id)!.length, color: null, bound: this.bindingOf(id), aliasOf: null,
    }));
    const named = nameClusters(list.map((c) => ({ id: c.id, centroid: c.centroid, bound: c.bound })));
    for (const c of list) c.color = named.get(c.id) ?? null;
    const ranked = list.filter((c) => c.color);
    for (const c of list) {
      if (c.color) continue;
      let best: ColorCluster | null = null;
      let bestD = ALIAS_DIST;
      for (const r of ranked) {
        const d = labDistance(c.centroid, r.centroid);
        if (d < bestD && couldBe(c.centroid, r.color!)) { bestD = d; best = r; }
      }
      if (best) { c.color = best.color; c.aliasOf = best.id; }
    }
    return list;
  }

  colorOf(id: number): ColorName | null {
    return this.clusters().find((c) => c.id === id)?.color ?? null;
  }

  faceOf(id: number): FaceId | null {
    const col = this.colorOf(id);
    return col ? COLOR_TO_FACE[col] : null;
  }

  /** cluster id -> face letter for every decided cluster (the lock-time binding). */
  faceMap(): Map<number, FaceId> {
    const out = new Map<number, FaceId>();
    for (const c of this.clusters()) if (c.color) out.set(c.id, COLOR_TO_FACE[c.color]);
    return out;
  }
}

/**
 * Ordinal naming of up to six clustering-space centroids: named by rank,
 * never by distance to a nominal colour. A binding (adjacency evidence)
 * only fills a gap the ranks leave open - a lone warm or lone white/blue
 * cluster - and never overrules a rank.
 */
export function nameClusters(
  clusters: readonly { id: number; centroid: Lab; bound?: ColorName | null }[],
): Map<number, ColorName> {
  const out = new Map<number, ColorName>();
  const taken = new Set<ColorName>();
  let rest = [...clusters];
  const take = (color: ColorName, pick: (cs: typeof rest) => (typeof rest)[number] | undefined) => {
    if (taken.has(color)) return;
    const c = pick(rest);
    if (!c) return;
    out.set(c.id, color);
    taken.add(color);
    rest = rest.filter((x) => x.id !== c.id);
  };
  const minBy = (cs: typeof rest, f: (c: Lab) => number) =>
    cs.reduce<(typeof rest)[number] | undefined>((m, c) => (!m || f(c.centroid) < f(m.centroid) ? c : m), undefined);

  const ordinal = () => {
    // white and blue: white is the least chromatic cluster, blue the one with
    // the most negative b. A dark blue under dim warm light is nearly neutral
    // too (chroma 27, b -27 in scan-debug-1789291642684), so when one cluster
    // is both the least chromatic AND the bluest, and nothing else is neutral,
    // it stays unnamed until the other of the pair shows up (or adjacency
    // binds it) - exactly the red/orange rule for the cool side.
    {
      const cool = rest.filter((c) => isCool(c.centroid)).sort((x, y) => x.centroid.b - y.centroid.b);
      const neutral = rest.filter((c) => isNeutral(c.centroid)).sort((x, y) => chroma(x.centroid) - chroma(y.centroid));
      let white: (typeof rest)[number] | undefined = neutral[0];
      let blue: (typeof rest)[number] | undefined = cool[0];
      if (white && blue && white.id === blue.id) {
        if (neutral.length >= 2 && !cool.some((c) => c.id === neutral[1]!.id)) white = neutral[1];
        else if (cool.length >= 2) blue = cool[1];
        else if (taken.has('white')) white = undefined; // the other of the pair is known: this is blue
        else if (taken.has('blue')) blue = undefined;
        else { white = undefined; blue = undefined; }
      }
      if (white) take('white', () => white);
      if (blue) take('blue', () => blue);
    }
    // green: most negative a
    take('green', (cs) => { const g = minBy(cs, (c) => c.a); return g && g.centroid.a < GREEN_MAX_A ? g : undefined; });
    // yellow: the warm/yellow side sorted by hue - yellow has the largest hue
    // of them and sits away from red/orange (hue > ~80); it needs chroma
    const warmish = () => rest.filter((c) => isWarmish(c.centroid)).sort((x, y) => hueDeg(x.centroid) - hueDeg(y.centroid));
    take('yellow', () => { const ys = warmish().filter((c) => isYellowish(c.centroid)); return ys[ys.length - 1]; });
    // red / orange: the warm clusters in hue order split at their largest
    // hue gap - red below, orange above - when that gap is wide enough to
    // be two colours; a narrower spread is one colour seen under two
    // lights, which stays unnamed until adjacency binds it or the other
    // one shows up (or is the remaining warm colour when one is taken)
    const warm = warmish().filter((c) => isWarm(c.centroid));
    let split = warm.length;
    let gap = 0;
    for (let i = 1; i < warm.length; i++) {
      const g = hueDeg(warm[i]!.centroid) - hueDeg(warm[i - 1]!.centroid);
      if (g > gap) { gap = g; split = i; }
    }
    const group = (color: ColorName, members: typeof rest) => {
      take(color, () => members[0]);
      for (const c of members.slice(1)) if (out.get(members[0]!.id) === color) { out.set(c.id, color); rest = rest.filter((x) => x.id !== c.id); }
    };
    if (warm.length >= 2 && gap >= WARM_MIN_GAP_DEG) {
      group('red', warm.slice(0, split));
      group('orange', warm.slice(split));
    } else if (warm.length >= 1) {
      // the remainder is the other warm colour only if it is clearly not the taken one seen again
      const namedWarm = (color: ColorName) => clusters.find((c) => out.get(c.id) === color);
      const farFrom = (c: { centroid: Lab } | undefined) => !c || warm.every((w) => hueGap(w.centroid, c.centroid) >= WARM_MIN_GAP_DEG);
      if (taken.has('red') && !taken.has('orange') && farFrom(namedWarm('red'))) group('orange', warm);
      else if (taken.has('orange') && !taken.has('red') && farFrom(namedWarm('orange'))) group('red', warm);
    }
  };
  ordinal();
  // bindings fill what the ranks could not decide, then the ranks get
  // another go with those colours taken (the lone-warm remainder rule)
  for (const c of [...rest]) if (c.bound && !taken.has(c.bound) && couldBe(c.centroid, c.bound)) take(c.bound, () => c);
  ordinal();
  return out;
}

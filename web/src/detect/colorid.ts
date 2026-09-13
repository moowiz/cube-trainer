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
// the face on that side of the neighbour (bind()), and once the second warm
// cluster appears the hue ordering takes over.
//
// Cluster ids are stable for the session (a cluster keeps its id as its
// centroid follows the reservoir median), so the voter keys sticker samples
// by cluster id and the cluster -> face letter binding is applied at lock.
import { labDistance, labMedian } from '../color';
import { CENTER_MIN_DIST, normalizeFaceCells } from '../state';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER } from '../types';
import type { ColorName, FaceId, Lab } from '../types';

/** A new centre reading further than this from every centroid starts a new cluster. */
export const BIRTH_DIST = 2 * CENTER_MIN_DIST;
/** Two centroids closer than this are the same colour: merge. */
export const MERGE_DIST = CENTER_MIN_DIST;
const RESERVOIR = 40;
const MAX_CLUSTERS = 6;
/** White: the least chromatic cluster, and it must actually be low-chroma. */
const WHITE_MAX_CHROMA = 30;

export interface ColorCluster {
  id: number;
  centroid: Lab;
  n: number;
  /** Ordinal colour, null while undecidable (a lone warm cluster). */
  color: ColorName | null;
  /** Colour fixed by adjacency evidence (bind()), which the ordinal rules then respect. */
  bound: ColorName | null;
}

const COLOR_TO_FACE: Record<ColorName, FaceId> = Object.fromEntries(
  FACE_ORDER.map((f) => [DEFAULT_SCHEME_NAMES[f], f]),
) as Record<ColorName, FaceId>;

/** Hue angle in degrees, [0, 360). */
export function hueDeg(c: Lab): number {
  const h = (Math.atan2(c.b, c.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

export class ColorClusters {
  private reservoirs = new Map<number, Lab[]>();
  private centroids = new Map<number, Lab>();
  private bindings = new Map<number, ColorName>();
  private nextId = 1;
  /** Bumped on every structural change; consumers can cache on it. */
  version = 0;
  /** Called when two clusters merge (from -> into), so vote reservoirs can follow. */
  onMerge?: (from: number, into: number) => void;

  reset(): void {
    this.reservoirs.clear();
    this.centroids.clear();
    this.bindings.clear();
    this.nextId = 1;
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
    if (best < 0 || (bestD > BIRTH_DIST && this.centroids.size < MAX_CLUSTERS)) {
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
    const c = ColorClusters.centreOf(cells);
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
        if (labDistance(this.centroids.get(a)!, this.centroids.get(b)!) < MERGE_DIST) {
          // keep the older id (lower), fold the younger reservoir in
          const [keep, drop] = a < b ? [a, b] : [b, a];
          const r = [...this.reservoirs.get(keep)!, ...this.reservoirs.get(drop)!].slice(-RESERVOIR);
          this.reservoirs.set(keep, r);
          this.centroids.set(keep, labMedian(r));
          this.reservoirs.delete(drop);
          this.centroids.delete(drop);
          this.onMerge?.(drop, keep);
          if (!this.bindings.has(keep) && this.bindings.has(drop)) this.bindings.set(keep, this.bindings.get(drop)!);
          this.bindings.delete(drop);
          this.version++;
        }
      }
    }
  }

  /** Fix a cluster's colour from adjacency evidence. Ignored if that colour is bound elsewhere. */
  bind(id: number, color: ColorName): boolean {
    if (!this.centroids.has(id)) return false;
    for (const [other, c] of this.bindings) if (other !== id && c === color) return false;
    if (this.bindings.get(id) === color) return true;
    this.bindings.set(id, color);
    this.version++;
    return true;
  }

  size(): number {
    return this.centroids.size;
  }

  /** All clusters with their ordinal colour names. */
  clusters(): ColorCluster[] {
    const list = [...this.centroids].map(([id, centroid]) => ({
      id, centroid, n: this.reservoirs.get(id)!.length, color: null as ColorName | null, bound: this.bindings.get(id) ?? null,
    }));
    const named = nameClusters(list.map((c) => ({ id: c.id, centroid: c.centroid, bound: c.bound })));
    for (const c of list) c.color = named.get(c.id) ?? null;
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
 * Ordinal naming of up to six clustering-space centroids. Bindings win;
 * the rest are named by rank, never by distance to a nominal colour.
 */
export function nameClusters(
  clusters: readonly { id: number; centroid: Lab; bound?: ColorName | null }[],
): Map<number, ColorName> {
  const out = new Map<number, ColorName>();
  const taken = new Set<ColorName>();
  for (const c of clusters) {
    if (c.bound && !taken.has(c.bound)) { out.set(c.id, c.bound); taken.add(c.bound); }
  }
  let rest = clusters.filter((c) => !out.has(c.id));
  const chroma = (c: Lab) => Math.hypot(c.a, c.b);
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

  // white and blue: white is the least chromatic cluster, blue the one with
  // the most negative b. A dark blue under dim warm light is nearly neutral
  // too (chroma 27, b -27 in scan-debug-1789291642684), so when one cluster
  // is both the least chromatic AND the bluest, and nothing else is neutral,
  // it stays unnamed until the other of the pair shows up (or adjacency
  // binds it) - exactly the red/orange rule for the cool side.
  {
    const cool = rest.filter((c) => c.centroid.b < -8).sort((x, y) => x.centroid.b - y.centroid.b);
    const neutral = rest.filter((c) => chroma(c.centroid) < WHITE_MAX_CHROMA).sort((x, y) => chroma(x.centroid) - chroma(y.centroid));
    let white: (typeof rest)[number] | undefined = neutral[0];
    let blue: (typeof rest)[number] | undefined = cool[0];
    if (white && blue && white.id === blue.id) {
      if (neutral.length >= 2 && !cool.some((c) => c.id === neutral[1]!.id)) white = neutral[1];
      else if (cool.length >= 2) blue = cool[1];
      else { white = undefined; blue = undefined; }
    }
    if (white && !taken.has('white')) take('white', () => white);
    if (blue && !taken.has('blue')) take('blue', () => blue);
  }
  // green: most negative a
  take('green', (cs) => { const g = minBy(cs, (c) => c.a); return g && g.centroid.a < -12 ? g : undefined; });
  // yellow: the warm/yellow side sorted by hue - yellow has the largest hue
  // of them and sits away from red/orange (hue > ~80); it needs chroma
  const warmish = () => rest.filter((c) => c.centroid.b > 0 && chroma(c.centroid) > 15).sort((x, y) => hueDeg(x.centroid) - hueDeg(y.centroid));
  take('yellow', () => { const w = warmish(); const y = w[w.length - 1]; return y && hueDeg(y.centroid) > 78 && y.centroid.a < 25 ? y : undefined; });
  // red / orange: by hue order when both are present; a lone warm cluster
  // stays unnamed until adjacency binds it or the other one shows up
  const warm = warmish().filter((c) => hueDeg(c.centroid) < 78);
  if (warm.length >= 2) {
    take('red', () => warm[0]);
    take('orange', () => warm[1]);
  } else if (warm.length === 1) {
    // one warm cluster and the other warm colour already bound elsewhere: it is the remaining one
    if (taken.has('red') && !taken.has('orange')) take('orange', () => warm[0]);
    else if (taken.has('orange') && !taken.has('red')) take('red', () => warm[0]);
  }
  return out;
}

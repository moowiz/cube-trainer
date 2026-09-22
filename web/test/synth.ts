// Synthetic evidence logs with known truth: a simulated session with
// per-frame white balance, per-quad shading, noise, glare, fingers, tracks
// re-acquired under new ids, and shared-edge pairings in the tracks' own
// (rotated) corner orders. `simulate` is the static scan of
// colour-synthetic.test.ts; `simulateFrames` takes a state per frame so a
// solve (moves-synthetic.test.ts) is the same generator with the cube
// changing under it.
import { srgbToLab } from '../src/color';
import { emptyLog, patchWeight } from '../src/colour/evidence';
import type { EvidenceLog, PatchStats, RGB } from '../src/colour/types';
import { sharedEdge } from '../src/detect/orient';
import { rotateCells } from '../src/colour/cells';
import type { FaceId } from '../src/types';
import { FACE_ORDER } from '../src/types';

export const COLOUR: Record<FaceId, RGB> = {
  U: [235, 235, 230], R: [200, 30, 40], F: [30, 160, 70], D: [230, 200, 40], L: [240, 120, 20], B: [30, 70, 200],
};

export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** The eight corner views: three mutually adjacent faces each. */
export const CORNER_VIEWS: FaceId[][] = [['U', 'F', 'R'], ['U', 'R', 'B'], ['U', 'B', 'L'], ['U', 'L', 'F'], ['D', 'R', 'F'], ['D', 'B', 'R'], ['D', 'L', 'B'], ['D', 'F', 'L']];

export interface FrameSpec {
  /** URFDLB facelets the cube is in at this frame. */
  state: string;
  view: FaceId[];
  t: number;
  /** New tracks for every face in view (a re-grip): ids and rotations change. */
  regrip?: boolean;
  /** A mid-turn frame: one row of each face smeared with random colours, weights near zero. */
  garbage?: boolean;
  /** Cells covered by skin on each face this frame (contiguous, along one edge), 0-4. */
  fingers?: number;
}

export interface SimOptions {
  seed?: number;
  /** White-balance swing per frame (fraction). */
  wb?: number;
  /** Per-cell glare probability. */
  glare?: number;
  /** Per-cell random finger probability (on top of FrameSpec.fingers). */
  fingers?: number;
  /** Re-acquire a face's track under a new id with p=0.5 every this many frames (0 = never). */
  reacquireEvery?: number;
  /** Per-frame noise amplitude, sRGB levels. */
  noise?: number;
}

/** Build a log from explicit per-frame specs. Returns the log and each track's raw cell rotation. */
export function simulateFrames(specs: readonly FrameSpec[], o: SimOptions = {}): { log: EvidenceLog; cellRot: Map<number, number>; trackFace: Map<number, FaceId> } {
  const rnd = lcg(o.seed ?? 7);
  const log = emptyLog();
  const trackOf = new Map<FaceId, number>();
  const cellRot = new Map<number, number>();
  const trackFace = new Map<number, FaceId>();
  const nth = new Map<number, number>();
  let nextTrack = 1;
  const clamp = (x: number) => Math.max(0, Math.min(255, x));
  const every = o.reacquireEvery ?? 16;
  specs.forEach((spec, f) => {
    const view = spec.view;
    const wb: RGB = [1 + (rnd() - 0.5) * 2 * (o.wb ?? 0.15), 1, 1 + (rnd() - 0.5) * 2 * (o.wb ?? 0.15)];
    for (const face of view) {
      if (!trackOf.has(face) || spec.regrip || (every > 0 && f > 0 && f % every === 0 && rnd() < 0.5)) {
        trackOf.set(face, nextTrack);
        trackFace.set(nextTrack, face);
        cellRot.set(nextTrack, Math.floor(rnd() * 4));
        nth.set(nextTrack, 0);
        nextTrack++;
      }
    }
    // a finger sits along one edge of each face; which edge changes with the grip
    const fingerCells = (n: number): Set<number> => {
      const edge = [[0, 1, 2], [2, 5, 8], [6, 7, 8], [0, 3, 6]][Math.floor(rnd() * 4)]!;
      const cells = new Set<number>();
      const start = Math.floor(rnd() * 3);
      for (let i = 0; i < Math.min(n, 3); i++) cells.add(edge[(start + i) % 3]!);
      if (n === 4) cells.add(4);
      return cells;
    };
    for (const face of view) {
      const track = trackOf.get(face)!;
      const kc = cellRot.get(track)!;
      const fi = FACE_ORDER.indexOf(face);
      const layout = spec.state.slice(fi * 9, fi * 9 + 9).split('') as FaceId[];
      const raw = rotateCells(layout, (4 - kc) % 4); // layout = rotateCells(raw, kc)
      const shade = 0.5 + 0.5 * rnd();
      const covered = spec.fingers ? fingerCells(spec.fingers) : new Set<number>();
      // the smeared row of a mid-turn frame, in raw order
      const smear = spec.garbage ? new Set([[0, 1, 2], [6, 7, 8], [0, 3, 6], [2, 5, 8]][Math.floor(rnd() * 4)]!) : new Set<number>();
      const quadW = spec.garbage ? 0.08 + 0.1 * rnd() : 0.9;
      const readings = raw.map((letter, cell) => {
        const base = COLOUR[letter];
        let rgb: RGB = [0, 1, 2].map((i) => clamp(base[i]! * wb[i]! * shade + (rnd() - 0.5) * (o.noise ?? 12))) as RGB;
        let clipFrac = 0;
        if (rnd() < (o.glare ?? 0.05)) { rgb = [255, 255, 255]; clipFrac = 0.8; }
        if (covered.has(cell) || rnd() < (o.fingers ?? 0.03)) rgb = [clamp(200 * shade), clamp(150 * shade), clamp(120 * shade)];
        if (smear.has(cell)) {
          const other = COLOUR[FACE_ORDER[Math.floor(rnd() * 6)]!];
          rgb = [0, 1, 2].map((i) => clamp((base[i]! + other[i]!) / 2 * shade + (rnd() - 0.5) * 30)) as RGB;
        }
        const stats: PatchStats = { rgb, lab: srgbToLab(rgb[0], rgb[1], rgb[2]), clipFrac, darkFrac: 0, spread: 2 + rnd() * 3 + (smear.has(cell) ? 10 : 0), censored: [rgb[0] >= 255, rgb[1] >= 255, rgb[2] >= 255], n: 144 };
        return { cell, rgb, lab: stats.lab, clipFrac, darkFrac: 0, spread: stats.spread, censored: stats.censored, w: quadW * patchWeight(stats) };
      });
      nth.set(track, nth.get(track)! + 1);
      log.quads.push({ frame: f, t: spec.t, track, corners: [[0, 0], [100, 0], [100, 100], [0, 100]], conf: 0.95, blur: spec.garbage ? 12 : 80, viewCos: 0.8, edgePx: 150, speed: spec.garbage ? 4 : 0.2, nth: nth.get(track)!, readings });
    }
    // pairings between every adjacent pair in view, expressed in raw edges
    for (let i = 0; i < view.length; i++) {
      for (let j = i + 1; j < view.length; j++) {
        const a = view[i]!;
        const b = view[j]!;
        const se = sharedEdge(a, b);
        if (!se) continue;
        const ta = trackOf.get(a)!;
        const tb = trackOf.get(b)!;
        const ea = ((se.ia - cellRot.get(ta)!) % 4 + 4) % 4;
        const eb = ((se.jb - cellRot.get(tb)!) % 4 + 4) % 4;
        log.pairings.push({ frame: f, a: ta, b: tb, edgeA: ea, edgeB: eb, cost: 3, tol: 20 });
      }
    }
  });
  log.frames = specs.length;
  return { log, cellRot, trackFace };
}

export interface ScanOptions extends SimOptions { frames?: number; hide?: FaceId[] }

/** A static scan: `frames` corner views of `truth` (URFDLB facelets), cycling through the eight corners. */
export function simulate(truth: string, o: ScanOptions = {}): { log: EvidenceLog; cellRot: Map<number, number> } {
  const frames = o.frames ?? 48;
  const views = CORNER_VIEWS.filter((v) => !v.some((f) => o.hide?.includes(f)));
  const specs: FrameSpec[] = [];
  for (let f = 0; f < frames; f++) specs.push({ state: truth, view: views[f % views.length]!, t: f * 500 });
  const { log, cellRot } = simulateFrames(specs, o);
  return { log, cellRot };
}

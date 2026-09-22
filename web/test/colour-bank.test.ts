// The colour half measured on every hand-labelled photo, with PERFECT
// corners: how well does each candidate embedding separate the six centre
// colours once the app's own rectify + robust sampler has read them?
//
// The bank (test/bank/colour/, gitignored with the photos) is written by
// model/train/export_colour_bank.py: each frame at app resolution, the
// labelled quads, and the centre colour the label carries (white, red,
// green, yellow, orange, blue). Only CENTRES have truth - the cubes are
// scrambled, so the other eight stickers of a face are unknown - which is
// exactly the reading the palette is named from, so this is the naming
// stage under test, not the decoder.
//
// Per batch (one capture session = one cube, one kind of light) and per
// embedding:
//   acc     leave-one-out nearest-centroid naming of the centres, i.e. how a
//           session palette names a centre it has not seen
//   d'      centroid separation over within-colour spread, projected on the
//           line between the two colours - the two known hard pairs and the
//           worst pair of all
//   frame   the smallest distance between two centres that are co-visible
//           in ONE frame (always different colours): the margin the
//           per-frame naming actually has, p10 over frames
// The pooled row is every batch together with no per-session palette: what
// a fixed palette across lighting would face.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { facePlan, minFaceEdgePx, sampleGridStats } from '../src/color';
import { DEFAULT_EMBEDDING, EMBEDDINGS, type EmbeddingName } from '../src/colour/colorspace';
import { patchWeight } from '../src/colour/evidence';
import type { Vec3 } from '../src/colour/types';
import { warpQuad } from '../src/rectify';
import { loadPng, TEST_DIR } from './helpers';

const BANK = join(TEST_DIR, 'bank', 'colour');
const INDEX = join(BANK, 'index.json');

type Colour = 'white' | 'red' | 'green' | 'yellow' | 'orange' | 'blue';
const COLOURS: Colour[] = ['white', 'red', 'green', 'yellow', 'orange', 'blue'];

interface BankFace { corners: [number, number][]; colour: Colour; centreVerdict: string }
interface BankFrame { png: string; root: string; source: string; batch: string; width: number; height: number; faces: Record<string, BankFace> }

/** One centre reading with truth, in every embedding at once. */
interface Centre { batch: string; frame: number; colour: Colour; w: number; x: Record<EmbeddingName, Vec3> }

/** A thumb or a blown-out/blurred centre carries no truth (the checker's verdict, read on the native photo). */
function usable(f: BankFace): boolean {
  if (f.centreVerdict === 'skin' || f.centreVerdict === 'dark') return false;
  if (f.centreVerdict === 'white' && f.colour !== 'white') return false;
  return true;
}

function readBank(): Centre[] {
  const frames = JSON.parse(readFileSync(INDEX, 'utf8')) as BankFrame[];
  const names = Object.keys(EMBEDDINGS) as EmbeddingName[];
  const out: Centre[] = [];
  frames.forEach((fr, fi) => {
    const faces = Object.values(fr.faces).filter(usable);
    if (!faces.length) return;
    const img = loadPng(join(BANK, fr.png));
    for (const f of faces) {
      // the app's own path (sample.worker.ts): plan from the quad's mean edge in source px, floor from the frame height
      let perim = 0;
      for (let i = 0; i < 4; i++) perim += Math.hypot(f.corners[i]![0] - f.corners[(i + 1) % 4]![0], f.corners[i]![1] - f.corners[(i + 1) % 4]![1]);
      const plan = facePlan(perim / 4 / 3, minFaceEdgePx(fr.height));
      if (!plan) continue; // below the scanning range floor: the app would not sample it either
      const warped = warpQuad(img, f.corners, 90);
      const stats = sampleGridStats(warped as unknown as ImageData, { x: 0, y: 0, w: 90, h: 90 }, plan);
      const w = patchWeight(stats[4]!);
      if (w < 0.05) continue; // glare / black: the log would carry it at ~zero weight
      const rgb = stats.map((p) => p.rgb);
      const lab = stats.map((p) => p.lab);
      const x = {} as Record<EmbeddingName, Vec3>;
      for (const n of names) x[n] = EMBEDDINGS[n].embedQuad(rgb, lab)[4]!;
      out.push({ batch: fr.batch, frame: fi, colour: f.colour, w, x });
    }
  });
  return out;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function centroid(cs: readonly Centre[], n: EmbeddingName): Vec3 {
  let sw = 0;
  const s: Vec3 = [0, 0, 0];
  for (const c of cs) { sw += c.w; for (let k = 0; k < 3; k++) s[k] += c.x[n][k]! * c.w; }
  return s.map((v) => v / Math.max(sw, 1e-9)) as Vec3;
}

/** Leave-one-out nearest-centroid naming accuracy and the confusion pairs. */
function looAccuracy(cs: readonly Centre[], n: EmbeddingName): { acc: number; n: number; confused: Map<string, number> } {
  const byColour = new Map<Colour, Centre[]>();
  for (const c of cs) (byColour.get(c.colour) ?? byColour.set(c.colour, []).get(c.colour)!).push(c);
  const present = COLOURS.filter((k) => byColour.has(k));
  let ok = 0;
  const confused = new Map<string, number>();
  for (const c of cs) {
    let best: Colour | null = null;
    let bestD = Infinity;
    for (const k of present) {
      const others = k === c.colour ? byColour.get(k)!.filter((o) => o !== c) : byColour.get(k)!;
      if (!others.length) continue;
      const d = dist(c.x[n], centroid(others, n));
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best === c.colour) ok++;
    else confused.set(`${c.colour}>${best}`, (confused.get(`${c.colour}>${best}`) ?? 0) + 1);
  }
  return { acc: ok / Math.max(cs.length, 1), n: cs.length, confused };
}

/** d' between two colours: centroid distance over the RMS within-colour spread projected on the joining line. */
function dPrime(cs: readonly Centre[], n: EmbeddingName, a: Colour, b: Colour): number | null {
  const A = cs.filter((c) => c.colour === a);
  const B = cs.filter((c) => c.colour === b);
  if (A.length < 3 || B.length < 3) return null;
  const ca = centroid(A, n);
  const cb = centroid(B, n);
  const d = dist(ca, cb);
  if (d < 1e-9) return 0;
  const u = [(cb[0] - ca[0]) / d, (cb[1] - ca[1]) / d, (cb[2] - ca[2]) / d] as Vec3;
  const proj = (c: Centre, o: Vec3) => (c.x[n][0] - o[0]) * u[0] + (c.x[n][1] - o[1]) * u[1] + (c.x[n][2] - o[2]) * u[2];
  const rms = (xs: Centre[], o: Vec3) => Math.sqrt(xs.reduce((s, c) => s + proj(c, o) ** 2, 0) / xs.length);
  const sa = rms(A, ca);
  const sb = rms(B, cb);
  return d / Math.max(Math.sqrt((sa * sa + sb * sb) / 2), 1e-6);
}

/** Worst d' over every pair of colours present. */
function worstPair(cs: readonly Centre[], n: EmbeddingName): { pair: string; d: number } | null {
  let worst: { pair: string; d: number } | null = null;
  for (let i = 0; i < COLOURS.length; i++) for (let j = i + 1; j < COLOURS.length; j++) {
    const d = dPrime(cs, n, COLOURS[i]!, COLOURS[j]!);
    if (d !== null && (!worst || d < worst.d)) worst = { pair: `${COLOURS[i]}/${COLOURS[j]}`, d };
  }
  return worst;
}

/** p10 of the smallest distance between two co-visible centres, over frames with 2+ usable centres. */
function frameMarginP10(cs: readonly Centre[], n: EmbeddingName): number | null {
  const byFrame = new Map<number, Centre[]>();
  for (const c of cs) (byFrame.get(c.frame) ?? byFrame.set(c.frame, []).get(c.frame)!).push(c);
  const mins: number[] = [];
  for (const fs of byFrame.values()) {
    if (fs.length < 2) continue;
    let m = Infinity;
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) m = Math.min(m, dist(fs[i]!.x[n], fs[j]!.x[n]));
    mins.push(m);
  }
  if (!mins.length) return null;
  mins.sort((a, b) => a - b);
  return mins[Math.floor(mins.length * 0.1)]!;
}

const fmt = (v: number | null, w = 5, d = 1) => (v === null ? '-'.padStart(w) : v.toFixed(d).padStart(w));

describe.skipIf(!existsSync(INDEX))('colour bank: centre separability with perfect corners', () => {
  // the describe body still runs at collect time when skipped (a clean clone, CI has no bank)
  const centres = existsSync(INDEX) ? readBank() : [];
  const batches = [...new Set(centres.map((c) => c.batch))].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  const names = Object.keys(EMBEDDINGS) as EmbeddingName[];
  const groups: [string, Centre[]][] = [...batches.map((b) => [b, centres.filter((c) => c.batch === b)] as [string, Centre[]]), ['pooled', centres]];

  it('prints the table', () => {
    const lines: string[] = [];
    lines.push(`${centres.length} usable centres over ${batches.length} batches; d' = centroid gap / within-colour spread (>= 2 is a clean pair), frame = p10 of the closest co-visible pair`);
    for (const [g, cs] of groups) {
      const counts = COLOURS.map((k) => `${k.slice(0, 2)} ${cs.filter((c) => c.colour === k).length}`).join(' ');
      lines.push(`\n${g} (${cs.length} centres: ${counts})`);
      lines.push(`  ${'embedding'.padEnd(12)} ${'acc'.padStart(6)} ${'red/orange'.padStart(11)} ${'white/yellow'.padStart(13)} ${'worst pair'.padStart(22)} ${'frame p10'.padStart(10)}  confusions`);
      for (const n of names) {
        const loo = looAccuracy(cs, n);
        const wp = worstPair(cs, n);
        const conf = [...loo.confused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');
        lines.push(`  ${n.padEnd(12)} ${(loo.acc * 100).toFixed(1).padStart(5)}% ${fmt(dPrime(cs, n, 'red', 'orange'), 11)} ${fmt(dPrime(cs, n, 'white', 'yellow'), 13)} ${wp ? `${wp.pair.padStart(15)} ${fmt(wp.d, 6)}` : '-'.padStart(22)} ${fmt(frameMarginP10(cs, n), 10)}  ${conf}`);
      }
    }
    console.log('\n' + lines.join('\n'));
    expect(centres.length).toBeGreaterThan(100);
  });

  it(`the default embedding (${DEFAULT_EMBEDDING.name}) names centres from a session palette`, () => {
    // DECISION: floor set from the first run of the bank (2026-09-13: the
    // default lab-crushed's worst batch with 20+ centres was batch 2 at
    // 84.2%, lab-norm's was 89.3%) - a regression alarm, not a target. Per
    // batch so that one easy batch cannot hide a hard one. MEASURED that
    // day: lab-crushed is the worst of the five on red/orange in every warm
    // indoor batch (d' 1.6-2.0 where lab-norm has 2.8-7.6) and lab-norm
    // names 92.3% pooled vs 84.7%; lab-norm's cost is a heavy colour cast
    // (the blue-monitor replay capture: 32/54 pre-decoder vs 42/54).
    for (const b of batches) {
      const cs = centres.filter((c) => c.batch === b);
      if (cs.length < 20) continue;
      const { acc } = looAccuracy(cs, DEFAULT_EMBEDDING.name);
      expect(acc, `${b}: leave-one-out naming accuracy`).toBeGreaterThanOrEqual(0.8);
    }
  });
});

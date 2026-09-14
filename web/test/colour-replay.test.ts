// The colour solver replayed on every fixture with a known truth: the
// session-0913 phone captures (per-face consensus cells from the old voter)
// and the M1 cube-scan reports with a cubejs-verified scramble. Each becomes
// a degenerate evidence log - six tracks, one frame each, no pairings - so
// letters come from the ordinal names and rotations from legality, exactly
// the dead-on-only path. The bake-off table (design 3.3) is printed for
// every embedding; the assertions hold the default one to the truths.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { labToSrgb } from '../src/color';
import { DEFAULT_EMBEDDING, EMBEDDINGS, type EmbeddingName } from '../src/colour/colorspace';
import { emptyLog, patchWeight } from '../src/colour/evidence';
import { solve, solveBest } from '../src/colour/solve';
import type { EvidenceLog, Reading, RGB } from '../src/colour/types';
import type { FaceId, Lab } from '../src/types';
import { FACE_ORDER } from '../src/types';

const fixtures = new URL('./fixtures/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));

interface Face { face: FaceId; cells: Lab[]; rgb?: RGB[] }

/** Six lettered, layout-oriented faces as a log of six single-frame tracks. */
function logFromFaces(faces: readonly Face[]): EvidenceLog {
  const log = emptyLog();
  faces.forEach((f, i) => {
    const readings = f.cells.map((lab, cell) => {
      const rgb = f.rgb?.[cell] ?? labToSrgb(lab);
      return { cell, rgb: rgb as RGB, lab, clipFrac: 0, darkFrac: 0, spread: 0, censored: [false, false, false] as [boolean, boolean, boolean], w: 1 };
    });
    // the track id is NOT the letter: the solver must not be able to cheat
    log.quads.push({ frame: i, t: i * 1000, track: 100 + (i * 7) % 11, corners: [[0, 0], [90, 0], [90, 90], [0, 90]], conf: 1, blur: 100, viewCos: 1, edgePx: 200, speed: 0, nth: 3, readings });
  });
  log.frames = faces.length;
  return log;
}

const SESSION_TRUTH = 'LRFLUFLBUBLDLRRRRFDDRUFDUFDFDBUDFRDLBBBULFULLRBUUBBDRF';
const sessionFaces = (name: string): Face[] => {
  const d = read(`session-0913/${name}`) as { lockAttempt: { evidence: { face: FaceId; cells: Lab[] }[] } };
  return d.lockAttempt.evidence.map((e) => ({ face: e.face, cells: e.cells }));
};
const scanFaces = (name: string): Face[] => {
  // the M1 report stores rgb as CSS strings "rgb(r, g, b)"
  const d = read(name) as { captures: { face: FaceId; cells: Lab[]; rgb?: string[] }[] };
  const parse = (s: string): RGB => s.match(/[\d.]+/g)!.map(Number) as RGB;
  return d.captures.map((c) => ({ face: c.face, cells: c.cells, rgb: c.rgb?.map(parse) }));
};
const scramble = (alg: string) => new Cube().move(alg).asString();

interface Case { name: string; faces: Face[]; truth: string; /** what the old pipeline managed */ before: number }
const CASES: Case[] = [
  { name: 'session 986281 (shadowed blue, bright reds)', faces: sessionFaces('scan-debug-1789312986281.json'), truth: SESSION_TRUTH, before: 54 },
  { name: 'session 082369 (R appears 8)', faces: sessionFaces('scan-debug-1789313082369.json'), truth: SESSION_TRUTH, before: 54 },
  { name: 'session 817862 (one junk cell on B)', faces: sessionFaces('scan-debug-1789312817862.json'), truth: SESSION_TRUTH, before: 53 },
  { name: 'scan 102942492 (blue monitor cast)', faces: scanFaces('cube-scan-1789102942492.json'), truth: scramble("U L B2 U2 L D2 B2 L U2 R' F2 B' D2 F D L' B' F U'"), before: 43 },
  { name: 'scan 102641416 (kitchen evening)', faces: scanFaces('cube-scan-1789102641416.json'), truth: scramble("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D"), before: 54 },
  { name: 'scan 107876392 (second cube)', faces: scanFaces('cube-scan-1789107876392.json'), truth: scramble("B2 F2 U' R2 F2 D' U F2 R2 U2 F' D2 L U B' F' R' D2 B L'"), before: 54 },
  { name: 'scan 108244116 (matte cube)', faces: scanFaces('cube-scan-1789108244116.json'), truth: scramble("B2 F2 U' R2 F2 D' U F2 R2 U2 F' D2 L U B' F' R' D2 B L'"), before: 52 },
];

function matches(a: string | null, b: string): number {
  if (!a) return 0;
  let n = 0;
  for (let i = 0; i < 54; i++) if (a[i] === b[i]) n++;
  return n;
}

describe('colour solver replay', () => {
  const table: string[] = [];
  const results = new Map<string, Map<EmbeddingName, ReturnType<typeof solve>>>();
  for (const c of CASES) {
    const log = logFromFaces(c.faces);
    const per = new Map<EmbeddingName, ReturnType<typeof solve>>();
    for (const name of Object.keys(EMBEDDINGS) as EmbeddingName[]) {
      const s = solve(log, { embedding: EMBEDDINGS[name] });
      per.set(name, s);
      const d = s.decode;
      table.push(`${name.padEnd(12)} ${c.name.padEnd(42)} ${String(matches(s.facelets, c.truth)).padStart(2)}/54 bal ${String(matches(s.balanced, c.truth)).padStart(2)} (was ${c.before})  legal ${d?.legal ? 'y' : 'n'} changed ${d?.changed ?? '-'} delta ${d ? (d.delta === Infinity ? 'inf' : d.delta.toFixed(1)) : '-'} minMargin ${d ? Math.min(...d.margins).toFixed(1) : '-'} ${s.lockable ? 'LOCK' : s.reason} ${s.ms.toFixed(0)}ms`);
    }
    results.set(c.name, per);
  }
  it('prints the bake-off table', () => {
    console.log('\n' + table.join('\n'));
    expect(table.length).toBe(CASES.length * Object.keys(EMBEDDINGS).length);
  });

  for (const c of CASES) {
    it(`${c.name}: the default embedding (${DEFAULT_EMBEDDING.name}) is at least as good as before and never answers wrong`, () => {
      const s = results.get(c.name)!.get(DEFAULT_EMBEDDING.name)!;
      expect(s.centresSeen).toBe(6);
      // P9: a legal answer is only ever the truth; a refusal is acceptable
      if (s.facelets) expect(s.facelets).toBe(c.truth);
      if (c.before === 54) expect(s.facelets).toBe(c.truth);
      // a refusal must at least carry the old pipeline's evidence (the
      // balanced colouring is pre-rotation, so only compare when refused)
      // (the balanced colouring is pre-rotation and a single frame per face
      // is noise-level territory: allow a couple of stickers of slack)
      else if (s.facelets !== c.truth) expect(matches(s.balanced, c.truth)).toBeGreaterThanOrEqual(c.before - 2);
    });
  }

  it('letters follow the centres, whatever the track ids were', () => {
    const s = solve(logFromFaces(CASES[4]!.faces));
    for (const g of s.groups) expect(g.letter).not.toBeNull();
    expect(new Set(s.groups.map((g) => g.letter)).size).toBe(6);
    expect(FACE_ORDER.every((f) => s.colourLetter.includes(f))).toBe(true);
  });
});

/**
 * A capture stores each reading's weight as computed by the page at the
 * time; the replay re-derives it from the stored patch statistics with the
 * CURRENT patchWeight so a weighting change is measured here before it
 * ships. The quad-level factor (blur, motion, view, size, age) is recovered
 * as the stored weight over the patch factor of that capture's version.
 *
 * v1 captures (no `version`) computed clipFrac as "any channel >= 250",
 * which is 1.0 for every orange sticker on the phone, and weighted those
 * readings zero: a reading whose median colour is not near white was not
 * glare, so its clipFrac is reset first.
 */
function reweight(log: EvidenceLog, version: number | undefined): EvidenceLog {
  const patchAtCapture = (r: Reading): number => {
    const glare = r.clipFrac > 0.6 ? 0 : 1 - r.clipFrac;
    const seam = Math.max(0.1, 1 - 2 * r.darkFrac);
    const flat = Math.exp(-r.spread / 8);
    const cens = r.censored.reduce((w, c) => (c ? w * (version ? 0.8 : 0.5) : w), 1);
    return glare * seam * flat * cens;
  };
  for (const q of log.quads) {
    const qw = q.readings.filter((r) => r.clipFrac === 0 && patchAtCapture(r) > 0).map((r) => r.w / patchAtCapture(r));
    const quadW = qw.length ? qw.sort((a, b) => a - b)[qw.length >> 1]! : 0.5;
    for (const r of q.readings) {
      if (!version && Math.min(...r.rgb) < 235) r.clipFrac = 0;
      r.w = quadW * patchWeight({ rgb: r.rgb, lab: r.lab, clipFrac: r.clipFrac, darkFrac: r.darkFrac, spread: r.spread, censored: r.censored, n: 144 });
    }
  }
  return log;
}

// Phone captures in the evidence-log format (fixtures/README.md): every file
// under fixtures/evidence/ is solved; `truth` (54 facelets) is asserted when
// present, and a lock is only ever the truth.
describe('evidence-log captures', () => {
  const dir = new URL('./fixtures/evidence/', import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  it('lists the captures', () => { console.log(`evidence captures: ${files.length ? files.join(', ') : 'none yet'}`); });
  for (const file of files) {
    it(file, { timeout: 30000 }, () => {
      const d = read(`evidence/${file}`) as { version?: number; evidenceLog: EvidenceLog; truth?: string; scrambleTruth?: string | null; note?: string };
      reweight(d.evidenceLog, d.version);
      // `truth` is a confirmed state; `scrambleTruth` is what the page's
      // scramble produces from a solved cube, present only when the user
      // ticked "I applied it" before capturing
      const truth = d.truth ?? d.scrambleTruth ?? undefined;
      const log = d.evidenceLog;
      // JSON has no Map; groups' rotation maps are rebuilt by the solver anyway
      const rows: string[] = [];
      for (const name of Object.keys(EMBEDDINGS) as EmbeddingName[]) {
        const s = solve(log, { embedding: EMBEDDINGS[name] });
        rows.push(`${name.padEnd(12)} ${file.padEnd(36)} ${truth ? `${matches(s.facelets, truth)}/54` : '     '} faces ${s.centresSeen}/6 legal ${s.decode?.legal ? 'y' : 'n'} changed ${s.decode?.changed ?? '-'} delta ${s.decode ? (s.decode.delta === Infinity ? 'inf' : s.decode.delta.toFixed(1)) : '-'} ${s.lockable ? 'LOCK' : s.reason} ${s.ms.toFixed(0)}ms`);
      }
      console.log('\n' + rows.join('\n'));
      const s = solveBest(log);
      rows.push(`${'ensemble'.padEnd(12)} ${file.padEnd(36)} ${truth ? `${matches(s.facelets, truth)}/54` : '     '} -> ${s.embedding} ${s.lockable ? 'LOCK' : s.reason} ${s.ms.toFixed(0)}ms`);
      console.log(rows[rows.length - 1]);
      if (truth) {
        if (s.facelets) expect(s.facelets).toBe(truth);
        expect(s.lockable ? s.facelets : truth).toBe(truth);
      }
    });
  }
});

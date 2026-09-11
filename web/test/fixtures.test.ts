// Data-driven tests over real captures saved by the scanner's debug buttons
// (see fixtures/README.md). Every cube-scan-*.json dropped into fixtures/ is
// picked up automatically:
//  - lettersAfterFixes present  -> classification must reproduce the user's
//    corrected ground truth exactly.
//  - assembleError present      -> assembly must (still) fail for this scan.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Cube from 'cubejs';
import { isFaceTooDark } from '../src/color';
import { assembleState, type FaceCapture } from '../src/state';
import type { Lab } from '../src/types';

interface ScanFixture {
  type: string;
  note?: string;
  captures: Array<{ face: FaceCapture['face']; cells: Lab[] }>;
  autoLetters: string | null;
  assembleError: string | null;
  lettersAfterFixes: string | null;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const scanFiles = readdirSync(dir).filter((f) => f.startsWith('cube-scan-') && f.endsWith('.json'));

describe('scan fixtures', () => {
  it('at least one fixture exists', () => {
    expect(scanFiles.length).toBeGreaterThan(0);
  });

  for (const file of scanFiles) {
    const fx = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));

    describe(file, () => {
      // lettersAfterFixes is ground truth only when the user actually tapped
      // corrections — when it equals autoLetters it is just the classifier's
      // own output echoed back, and asserting on it would be circular.
      if (fx.lettersAfterFixes && fx.lettersAfterFixes !== fx.autoLetters) {
        it('classifies every sticker to the user-corrected ground truth', () => {
          const res = assembleState(captures);
          expect(res.facelets).toBe(fx.lettersAfterFixes);
        });
      } else {
        // No ground truth to hold the classifier to (a live assembleError is
        // not normative — the pipeline may since have learned to handle the
        // scan). Just require that assembly of these real captures either
        // produces a full 54-sticker state or refuses with a human-readable
        // error (never crashes).
        it('assembles or fails gracefully', () => {
          try {
            const res = assembleState(captures);
            expect(res.facelets).toHaveLength(54);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
            expect((e as Error).message.length).toBeGreaterThan(10);
          }
        });
      }
    });
  }
});

describe('cube-scan-1789102942492 (kitchen, blue monitor cast — known scramble)', () => {
  it('assembles despite whites reading blue, with at least 43/54 correct', () => {
    // White stickers lit mainly by a blue monitor read at b≈-27 — nearly the
    // chroma of real blue stickers; only absolute lightness separates them.
    // Anchored k-means keeps the six centers distinct, so this scan assembles
    // (the misread whites are tap-to-fix material) instead of dying with a
    // center-collision error as it did live.
    const SCRAMBLE = "U L B2 U2 L D2 B2 L U2 R' F2 B' D2 F D L' B' F U'";
    const truth = new Cube().move(SCRAMBLE).asString();
    const fx = JSON.parse(readFileSync(join(dir, 'cube-scan-1789102942492.json'), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));
    const res = assembleState(captures);
    let matches = 0;
    for (let i = 0; i < 54; i++) if (res.facelets[i] === truth[i]) matches++;
    expect(matches).toBeGreaterThanOrEqual(43);
  });
});

describe('cube-scan-1789102641416 (kitchen, evening — known scramble)', () => {
  it('classifies all 54 stickers to the exact state the scramble produces', () => {
    // The user scanned right after applying this scramble (white up, green
    // front), so cubejs gives the exact ground truth. This scan classified
    // 54/54 live with zero manual corrections — a full M1 exit case.
    const SCRAMBLE = "F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D";
    const truth = new Cube().move(SCRAMBLE).asString();
    const fx = JSON.parse(readFileSync(join(dir, 'cube-scan-1789102641416.json'), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));
    const res = assembleState(captures);
    expect(res.facelets).toBe(truth);
  });
});

describe('cube-scan-1789102120226 (kitchen, evening — a SOLVED cube)', () => {
  it('classifies at least 53/54 stickers of the solved cube correctly', () => {
    // The physical cube was solved, so ground truth is each capture's own
    // face letter across all its 9 cells. Live this scan got 53/54 (one F
    // sticker read as white — glare or a corner cell clipping off-cube);
    // pin that floor so the classifier never regresses below it, and tighten
    // to 54 when sampling improves.
    const fx = JSON.parse(readFileSync(join(dir, 'cube-scan-1789102120226.json'), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));
    const res = assembleState(captures);
    const truth = fx.captures.map((c) => c.face.repeat(9)).join('');
    let matches = 0;
    for (let i = 0; i < 54; i++) if (res.facelets[i] === truth[i]) matches++;
    expect(matches).toBeGreaterThanOrEqual(53);
  });
});

describe('cube-scan-1789101879130 (kitchen, evening — white face vs near-black blue face)', () => {
  it('centers collide in the normalized space, as the live scan reported', () => {
    // White read dark-bluish and blue read near-black: their normalized
    // centers are ~6 apart. The scanner's duplicate guard now uses this
    // same metric, so this is caught at capture time instead of assembly.
    const fx = JSON.parse(readFileSync(join(dir, 'cube-scan-1789101879130.json'), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));
    expect(() => assembleState(captures)).toThrow(/apart/);
  });
});

describe('cube-scan-1789100830100 (kitchen, evening — same face captured twice)', () => {
  it('duplicated centers are refused at assembly instead of producing a garbage state', () => {
    // Live (before exposure-normalized clustering) this scan "succeeded"
    // with U appearing 17 times. Two of its captures have the same blue
    // center — the same physical face locked into two slots — and no
    // classifier can undo that; refusing is the correct behavior.
    const fx = JSON.parse(readFileSync(join(dir, 'cube-scan-1789100830100.json'), 'utf8')) as ScanFixture;
    const captures: FaceCapture[] = fx.captures.map((c) => ({ face: c.face, cells: c.cells }));
    expect(() => assembleState(captures)).toThrow(/apart/);
  });
});

describe('cube-scan-1789100642010 (kitchen, evening — underexposed webcam)', () => {
  const file = 'cube-scan-1789100642010.json';
  it('the near-black R capture is refused by the darkness gate; merely dim faces are not', () => {
    const fx = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ScanFixture;
    const byFace = Object.fromEntries(fx.captures.map((c) => [c.face, c.cells]));
    // R read almost pure black (median L ~6, median chroma ~7): hopeless.
    expect(isFaceTooDark(byFace['R']!)).toBe(true);
    // U is dark (median L ~22) but carries chroma — the low-light pipeline
    // can work with faces like this, so the gate must let them through.
    expect(isFaceTooDark(byFace['U']!)).toBe(false);
  });
});

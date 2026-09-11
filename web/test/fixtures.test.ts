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
      if (fx.lettersAfterFixes) {
        it('classifies every sticker to the user-corrected ground truth', () => {
          const res = assembleState(captures);
          expect(res.facelets).toBe(fx.lettersAfterFixes);
        });
      }
      if (fx.assembleError) {
        it('assembly fails for this scan (as it did live)', () => {
          expect(() => assembleState(captures)).toThrow();
        });
      }
    });
  }
});

describe('cube-scan-1789100642010 (kitchen, evening — underexposed webcam)', () => {
  const file = 'cube-scan-1789100642010.json';
  it('every face is flagged by the darkness gate, so the scanner now refuses these captures', () => {
    const fx = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ScanFixture;
    for (const cap of fx.captures) {
      expect(isFaceTooDark(cap.cells), `face ${cap.face} should be too dark`).toBe(true);
    }
  });
});

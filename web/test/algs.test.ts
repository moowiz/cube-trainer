// The algs sheet (web/src/algs/): every cube alg in the table is run on the
// n×n model and must do what its case claims (which piece types it may
// move, whether it stays in the top layer, that it changes something);
// the sheet's pictures and viewer links render for every case.
import { describe, expect, it } from 'vitest';
import { PUZZLES } from '../src/algs/data';
import { algLength, caseSvg, setupAlg, viewerUrl } from '../src/algs/sheet';
import type { AlgCase, Check, Puzzle } from '../src/algs/types';
import { applyNxN, diffNxN, expandNxN, pieceTypeNxN, solvedNxN, stickerPos } from '../src/cube/nxn';

/** What `alg` changes on a solved n×n against the claim; '' when it holds, else the complaint. */
function violates(n: number, alg: string, check: Check): string {
  const after = applyNxN(n, alg);
  const moved = diffNxN(solvedNxN(n), after);
  if (check.changes !== false && moved.length === 0) return 'changes nothing';
  if (check.changes === false && moved.length) return `changes ${moved.length} stickers`;
  const types = new Set(moved.map((i) => pieceTypeNxN(n, i)));
  if (check.only) for (const t of types) if (!check.only.includes(t)) return `moves ${t} stickers (${moved.filter((i) => pieceTypeNxN(n, i) === t).length} of them)`;
  if (check.top) { const off = moved.filter((i) => stickerPos(n, i).y !== n - 1); if (off.length) return `moves ${off.length} stickers outside the top layer`; }
  return '';
}

const cubes = PUZZLES.filter((p): p is Puzzle & { n: number } => !!p.n);
const others = PUZZLES.filter((p) => !p.n);
const cases = (p: Puzzle): [string, AlgCase][] => p.sections.flatMap((s) => s.cases.map((c): [string, AlgCase] => [`${p.name} / ${s.title} / ${c.name}`, c]));

describe('the sheet has the six puzzles and well-formed cases', () => {
  it('lists 2x2, 4x4, 5x5, Pyraminx, Skewb and FTO once each', () => {
    expect(PUZZLES.map((p) => p.id)).toEqual(['222', '444', '555', 'pyra', 'skewb', 'fto']);
  });
  for (const p of PUZZLES) {
    it(`${p.name}: names are unique, algs and notes are filled in, sources are https`, () => {
      const names = cases(p).map(([, c]) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const [label, c] of cases(p)) {
        expect(c.alg.trim(), label).not.toBe('');
        expect(algLength(p, c.alg), label).toBeGreaterThan(0);
        if (c.source) expect(c.source, label).toMatch(/^https:\/\//);
      }
      expect(p.sections.length).toBeGreaterThan(0);
    });
  }
});

describe('every cube alg parses, and does what its case claims', () => {
  for (const p of cubes) {
    for (const [label, c] of cases(p)) {
      it(label, () => {
        for (const alg of [c.alg, ...(c.alt ?? [])]) {
          expect(() => expandNxN(alg), alg).not.toThrow();
          expect(() => applyNxN(p.n, alg), alg).not.toThrow();
          if (c.check) expect(violates(p.n, alg, c.check), alg).toBe('');
        }
        // the setup is the inverse: the alg solves the case it sets up
        expect(applyNxN(p.n, `${setupAlg(c.alg)} ${c.alg}`)).toBe(solvedNxN(p.n));
        if (c.setup) expect(() => applyNxN(p.n, c.setup!)).not.toThrow();
      });
    }
  }
});

describe('the sheet renders every case', () => {
  for (const p of PUZZLES) {
    it(`${p.name}: pictures for the cubes, none for the rest; a viewer link for each`, () => {
      for (const [label, c] of cases(p)) {
        const svg = caseSvg(p, c);
        if (p.n && c.pic !== 'none') { expect(svg, label).toContain('<svg'); expect((svg!.match(/<(rect|polygon)/g) ?? []).length, label).toBeGreaterThanOrEqual(p.n * p.n); }
        else expect(svg, label).toBeNull();
        if (p.viewer) expect(viewerUrl(p, c), label).toMatch(/^https:\/\/(alg\.cubing\.net|alpha\.twizzle\.net)\//);
      }
    });
  }
  it('the non-cube puzzles have a notation paragraph (their algs are text only)', () => {
    for (const p of others) expect(p.notation.length, p.name).toBeGreaterThan(40);
  });
});

// The coach (src/analysis/): a solve taken apart into EOCross, the pairs, OCLL,
// PLL and AUF with each step's case, and the advice built on many of them.
// Synthetic solves are a scramble made as the inverse of the turns that solve
// it (trainer letters, stored as WCA like a smart cube's); the real ones are
// the committed smart-cube fixture.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inverse, tokens } from '../src/cube/alg';
import { fromWca, toWca } from '../src/cube/frame';
import { stageOf } from '../src/stage';
import { state } from '../src/cube/state';
import { advise, caseTable, phaseTable, solveReport } from '../src/analysis/coach';
import { analyseSolve, type SolveAnalysis } from '../src/analysis/solve';
import { PLL_CASES } from '../src/ll/cases';
import { identifyFacelets } from '../src/ll/model';

/** A solve of `alg` (trainer letters): the scramble is its inverse, one turn every `dt` ms. */
function solveOf(alg: string, dt = 200) {
  const moves = tokens(toWca(alg)).map((m, i) => ({ m, t: i * dt }));
  return { scramble: toWca(inverse(alg)), moves, time: moves[moves.length - 1]!.t };
}
const TPERM = PLL_CASES.find((c) => c.id === 'T')!.alg;
const UA = PLL_CASES.find((c) => c.id === 'Ua')!.alg;
const SUNE = "R U R' U R U2 R'";
const phase = (a: SolveAnalysis, id: string) => a.phases.find((p) => p.id === id)!;

describe('analyseSolve', () => {
  it('a PLL alone: every earlier step skipped, the case read and its alg the par', () => {
    const a = analyseSolve(solveOf(TPERM))!;
    expect(a.phases.filter((p) => p.id === 'pair').every((p) => p.skipped)).toBe(true);
    expect(phase(a, 'ocll').skipped).toBe(true);
    const pll = phase(a, 'pll');
    expect(pll.caseId).toBe('T');
    expect(pll.par).toBe(14);
    expect(pll.algs).toBe(1);
    expect(pll.moves).toBe(14);
  });

  it('a two-look PLL: two algs, and the case passed through between them', () => {
    const s = solveOf(`${TPERM} ${UA}`);
    const n1 = tokens(toWca(TPERM)).length;
    s.moves = s.moves.map((m, i) => ({ ...m, t: m.t + (i >= n1 ? 1500 : 0) })); // a look between the two algs
    const a = analyseSolve(s)!;
    const pll = phase(a, 'pll');
    expect(pll.algs).toBe(2);
    expect(pll.via).toEqual([identifyFacelets('pll', state(inverse(UA)))!.id]);
    expect(pll.caseId).toBe(identifyFacelets('pll', state(inverse(`${TPERM} ${UA}`)))!.id);
  });

  it('a stop inside one alg is not a second look (Y perm passes through a last-layer state halfway)', () => {
    const Y = PLL_CASES.find((c) => c.id === 'Y')!.alg;
    const s = solveOf(Y);
    s.moves = s.moves.map((m, i) => ({ ...m, t: m.t + (i >= 9 ? 1500 : 0) })); // a hesitation after F R U' R' U' R U R' F'
    expect(phase(analyseSolve(s)!, 'pll').algs).toBe(1);
  });

  it('OCLL then PLL: each its own case, the look before the OCLL skipping the AUF', () => {
    const alg = `U R U' R' U ${SUNE} ${TPERM}`; // a last pair, an AUF, then the last layer
    const s = solveOf(alg);
    s.moves = s.moves.map((m, i) => ({ ...m, t: i < 4 ? i * 200 : 1000 + i * 200 })); // a second's pause after the pair
    const a = analyseSolve(s)!;
    const ocll = phase(a, 'ocll'), pll = phase(a, 'pll');
    expect(ocll.caseId).toBe(identifyFacelets('ocll', state(inverse(`U ${SUNE} ${TPERM}`)))!.id);
    expect(ocll.look).toBe(2000 - 600); // from the pair's last turn to the first turn that is not U
    expect(pll.caseId).toBe('T');
  });

  it('a last pair: its case, and the phases add up to the solve', () => {
    const a = analyseSolve(solveOf("U R U' R'"))!;
    const pairs = a.phases.filter((p) => p.id === 'pair');
    expect(pairs.filter((p) => !p.skipped)).toHaveLength(1);
    const p = pairs.find((q) => !q.skipped)!;
    expect(p.slot).toBe('FR');
    expect(p.caseId).toMatch(/^FR-\d+$/);
    expect(p.par).toBe(4);
    expect(a.phases.reduce((s, q) => s + q.time, 0)).toBe(a.total);
  });

  it('a scramble that left EOCross solved: recorded as such, left out of the phase numbers, its cases kept', () => {
    // the user's solve #7 (2026-09-26): an F2L practice scramble handed to the Solve tab - EOCross and a pair solved
    expect(stageOf(state(fromWca("B2 R B2 L2 U2 B2 F2 U D2 R2 L2 D2 L2 F2 R' B2 R U2 R'"))).stage).toBe('f2l');
    const part = analyseSolve(solveOf("U R U' R'"))!;
    expect(part.from).toBe('f2l');
    expect(phase(part, 'eocross').skipped).toBe(true);
    const r = solveReport(part, Array(4).fill(part));
    expect(r.given).toMatch(/started at F2L/);
    expect(r.vsTotal).toBeNull();
    expect(r.rows[0]!.vs).toBeNull();
    expect(advise(Array(8).fill(part))).toEqual([]); // no full solves: no phase advice
    expect(caseTable(Array(3).fill(part), 'f2l').reduce((n, c) => n + c.n, 0)).toBe(3); // its pair still counts
  });

  it('a wrong turn undone at once is counted', () => {
    const a = analyseSolve(solveOf(`R R' ${TPERM}`))!;
    expect(a.phases.reduce((s, p) => s + p.misturns, 0)).toBe(1);
  });

  it('turns that do not solve the scramble: no analysis', () => {
    const s = solveOf(TPERM);
    s.moves.pop();
    expect(analyseSolve(s)).toBeNull();
  });
});

describe('real solves (the smart-cube fixture)', () => {
  const recs = readFileSync(new URL('./fixtures/smart/icarrye-first.solves.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const list = recs.map((r) => analyseSolve(r)!);

  it('every solve is read: four pairs, OCLL, PLL, and the times add up', () => {
    for (const a of list) {
      expect(a).not.toBeNull();
      expect(a.phases.filter((p) => p.id === 'pair')).toHaveLength(4);
      expect(a.phases.reduce((s, p) => s + p.time, 0)).toBe(a.total);
      for (const p of a.phases) expect(p.time).toBeGreaterThanOrEqual(0);
    }
  });

  it('the coach: phase medians, the cases met, advice ranked by the seconds it is worth', () => {
    // five solves: the fixture's, repeated
    const many = [...list, ...list, ...list].slice(0, 6);
    const rows = phaseTable(many);
    expect(rows.map((r) => r.key)).toEqual(['eocross', 'f2l', 'ocll', 'pll', 'auf']);
    const f2l = caseTable(many, 'f2l');
    expect(f2l.reduce((s, r) => s + r.n, 0)).toBeGreaterThan(0);
    for (const r of f2l) expect(r.perSolveGain).toBeGreaterThanOrEqual(0);
    const adv = advise(many);
    expect(adv.length).toBeGreaterThan(0);
    for (let i = 1; i < adv.length; i++) expect(adv[i - 1]!.gain).toBeGreaterThanOrEqual(adv[i]!.gain);
    for (const a of adv) expect(a.why.length).toBeGreaterThan(0);
  });

  it('the report: a row per phase, each against the usual once there are solves before it', () => {
    const r = solveReport(list[0]!, [...list, ...list]);
    expect(r.rows.length).toBe(list[0]!.phases.length);
    expect(r.vsTotal).not.toBeNull();
  });
});

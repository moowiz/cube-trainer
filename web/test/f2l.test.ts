// The F2L case finder's model on facelet strings. Expected positions were
// measured with cubejs (state()) and checked by hand: after R U R' the
// front-right pair's corner sits at UFL with white on the left, its edge at UF.
import { describe, expect, it } from 'vitest';
import { faceMoves } from '../src/cube/alg';
import { SOLVED, state } from '../src/cube/state';
import { stageOf } from '../src/stage';
import { DATA } from '../src/f2l/data';
import {
  acnUrl, borrowedSlots, describe as describePair, explain, findCase, fullAlg, genF2L, genFull, invert, lookupKey, normalizeAlg,
  randomCase, slotOf, slotSolved, slotState, SLOTS, trace, uCount, uTok, withAuf, type SlotName,
} from '../src/f2l/model';
import { makeLcg } from './helpers';

const home = (slot: SlotName) => ({ corner: { pos: `D${slot}`, o: 'ud' }, edge: slot });

describe('slotState', () => {
  it('reads every pair at home on a solved cube', () => {
    for (const s of SLOTS) expect(slotState(SOLVED, s)).toEqual(home(s));
  });
  it("after R U R' the front-right pair is at UFL (white left) and UF; the other three are home", () => {
    const f = state("R U R'");
    expect(slotState(f, 'FR')).toEqual({ corner: { pos: 'UFL', o: 'rl' }, edge: 'UF' });
    for (const s of ['FL', 'BR', 'BL'] as const) expect(slotState(f, s)).toEqual(home(s));
  });
  it("after R U' R' the corner is at UFR (white right), the edge at UB", () => {
    expect(slotState(state("R U' R'"), 'FR')).toEqual({ corner: { pos: 'UFR', o: 'rl' }, edge: 'UB' });
  });
  it("after R U2 R' the corner is at UBL (white back), the edge at UL", () => {
    expect(slotState(state("R U2 R'"), 'FR')).toEqual({ corner: { pos: 'UBL', o: 'fb' }, edge: 'UL' });
  });
  it('F2 swaps the two front pairs, white still up/down', () => {
    const f = state('F2');
    expect(slotState(f, 'FR')).toEqual({ corner: { pos: 'UFL', o: 'ud' }, edge: 'FL' });
    expect(slotState(f, 'FL')).toEqual({ corner: { pos: 'UFR', o: 'ud' }, edge: 'FR' });
  });
  it('a single R lifts the front-right pair (white front) and drops the back-right pair to DFR/DR', () => {
    const f = state('R');
    expect(slotState(f, 'FR')).toEqual({ corner: { pos: 'UFR', o: 'fb' }, edge: 'UR' });
    expect(slotState(f, 'BR')).toEqual({ corner: { pos: 'DFR', o: 'fb' }, edge: 'DR' });
  });
  it('the mirrored inserts read the same way on the other slots', () => {
    expect(slotState(state("L' U L"), 'FL')).toEqual({ corner: { pos: 'UFL', o: 'rl' }, edge: 'UB' });
    expect(slotState(state("R' U R"), 'BR')).toEqual({ corner: { pos: 'UBR', o: 'rl' }, edge: 'UF' });
  });
});

describe('slotSolved', () => {
  const solvedSet = (alg: string) => SLOTS.filter((s) => slotSolved(state(alg), s));
  it('all four on a solved cube and after a U turn', () => {
    expect(solvedSet('')).toEqual(SLOTS);
    expect(solvedSet('U')).toEqual(SLOTS);
  });
  it('none after D (every corner moves)', () => {
    expect(solvedSet('D')).toEqual([]);
  });
  it('each side turn breaks its own two slots', () => {
    expect(solvedSet('R')).toEqual(['FL', 'BL']);
    expect(solvedSet('L')).toEqual(['FR', 'BR']);
    expect(solvedSet('F')).toEqual(['BR', 'BL']);
    expect(solvedSet('B')).toEqual(['FR', 'FL']);
  });
  it('a last-layer alg leaves all four', () => {
    expect(solvedSet("F R U R' U' F'")).toEqual(SLOTS);
  });
  it('slotOf names the E-layer edges and D-layer corners only', () => {
    expect(slotOf([1, 0, 1])).toBe('FR');
    expect(slotOf([-1, -1, -1])).toBe('BL');
    expect(slotOf([0, 1, 1])).toBeNull();
    expect(slotOf([1, 1, 1])).toBeNull();
    expect(slotOf([0, -1, 1])).toBeNull();
  });
});

describe('scrambles', () => {
  it('genF2L keeps EO and the cross solved, mixes the pairs, and stays in <U R L D F2 B2>', () => {
    const rnd = makeLcg(11);
    for (let i = 0; i < 20; i++) {
      const alg = genF2L(rnd);
      const r = stageOf(state(alg));
      expect(r.eoBad, alg).toBe(0);
      expect(r.cross, alg).toBe(4);
      expect(r.pairs, alg).toBeLessThan(4);
      const ms = faceMoves(alg)!;
      for (const m of ms) if (m.face === 'F' || m.face === 'B') expect(m.times, alg).toBe(2);
      // nothing to cancel: no face twice in a run of one axis (D' U' D, user 2026-09-26)
      const axis = (f: string) => 'UD RL FB'.split(' ').findIndex((a) => a.includes(f));
      for (let i = 1; i < ms.length; i++) {
        expect(ms[i]!.face, alg).not.toBe(ms[i - 1]!.face);
        if (i > 1 && axis(ms[i]!.face) === axis(ms[i - 1]!.face)) expect(ms[i]!.face, alg).not.toBe(ms[i - 2]!.face);
      }
    }
  });
  it('genFull is 25 face turns', () => {
    expect(faceMoves(genFull())).toHaveLength(25);
  });
  it('randomCase draws a position the sheet knows', () => {
    const r = randomCase('BL', makeLcg(3));
    expect(DATA.slots.BL.lookup[lookupKey(r.corner, r.edge)]).toBeDefined();
  });
});

describe('sheet notation', () => {
  it("normalizeAlg splits U'D, unprimes half turns, lowers wide moves", () => {
    expect(normalizeAlg("(U2') R U2' R2' U'D Rw'")).toBe("U2 R U2 R2 U' D r'");
  });
  it('invert reverses and flips', () => {
    expect(invert("R U R'")).toBe("R U' R'");
    expect(invert("(U) R U R' U2' r2 Rw U'D")).toBe("D' U r' r2 U2 R U' R' U'");
  });
  it('uCount / uTok round trip', () => {
    for (const t of ['', 'U', 'U2', "U'"]) expect(uTok(uCount(t))).toBe(t);
    expect(uTok(-1)).toBe("U'");
    expect(uTok(5)).toBe('U');
  });
  it("withAuf adds the position's AUF to the alg's own bracket", () => {
    expect(withAuf('U', "(U') R U R'")).toEqual({ pre: '', rest: "R U R'" });
    expect(withAuf('U2', "(U2') R' U R")).toEqual({ pre: '', rest: "R' U R" });
    expect(withAuf("U'", "(U') R U R'")).toEqual({ pre: 'U2', rest: "R U R'" });
    expect(withAuf('', "R U R'")).toEqual({ pre: '', rest: "R U R'" });
    expect(withAuf('', "(U) L' U L2' U' L'")).toEqual({ pre: 'U', rest: "L' U L2 U' L'" }); // the sheet's L2' read by the strict parser
    expect(fullAlg('U', "(U) R U2' R'")).toBe("U2 R U2 R'");
  });
  it('acnUrl sets up with the inverse and shows the alg', () => {
    expect(acnUrl("U R U' R'")).toBe("https://alg.cubing.net/?setup=R_U_R-_U-&alg=U_R_U-_R-&stickering=F2L");
  });
});

describe('case lookup', () => {
  it("after R U R' from solved the front-right pair is case 1 with AUF U', which lines up as R U' R'", () => {
    const st = slotState(state("R U R'"), 'FR');
    const found = findCase('FR', st.corner, st.edge)!;
    expect(found.hit).toEqual({ n: 1, auf: "U'" });
    expect(found.c.simple).toBe("(U) R U' R'");
    expect(fullAlg(found.hit.auf, found.c.simple)).toBe("R U' R'");
  });
  it('a solved pair or a nonsense position has no case', () => {
    expect(findCase('FR', { pos: 'DFR', o: 'ud' }, 'FR')).toBeNull();
    expect(findCase('FR', { pos: 'UFR', o: 'ud' }, 'DF')).toBeNull();
  });
  it('every alg on the sheet, undone from solved, looks up its own case; the AUF composes from any U offset', () => {
    for (const slot of SLOTS) {
      for (const c of Object.values(DATA.slots[slot].cases)) {
        for (const a of [...c.algs, c.simple]) {
          const setup = invert(fullAlg('', a));
          const st = slotState(state(setup), slot);
          const found = findCase(slot, st.corner, st.edge);
          expect(found?.c.n, `${slot} ${c.n} ${a} -> ${lookupKey(st.corner, st.edge)}`).toBe(c.n);
          for (const u of ['U', "U'", 'U2']) {
            const st2 = slotState(state(`${setup} ${u}`), slot);
            const f2 = findCase(slot, st2.corner, st2.edge);
            expect(f2?.c.n, `${slot} ${c.n} ${a} after ${u}`).toBe(c.n);
            expect(slotSolved(state(`${setup} ${u} ${fullAlg(f2!.hit.auf, a)}`), slot), `${slot} ${c.n} ${a} after ${u}: AUF ${f2!.hit.auf}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('explanations', () => {
  it('names the shape of an alg', () => {
    const c1 = DATA.slots.FR.cases['1'];
    expect(explain('FR', c1, c1.simple).head).toBe('Direct insert.');
    const c4 = DATA.slots.FR.cases['4'];
    expect(explain('FR', c4, c4.algs[0]).head).toBe('D conjugate.');
    const c49 = DATA.slots.FR.cases['49'];
    expect(explain('FR', c49, c49.algs[0]).head).toBe('Slide the corner under.');
    // FR 17's corner is on top and its edge rides out through the bottom layer: no slide (test/f2l-explain.test.ts checks every claim)
    const c17 = DATA.slots.FR.cases['17'];
    expect(explain('FR', c17, c17.algs[0]).head).toBe('D conjugate.');
  });
  it('sees a borrowed slot: the half-turn alg for the white-up case lifts the back-right pair and puts it back', () => {
    const c5 = DATA.slots.FR.cases['5'];
    const alg = "(U2) R2 U2 R' U' R U' R2";
    expect(c5.algs).toContain(alg);
    expect(borrowedSlots('FR', alg, new Set())).toEqual(['BR']);
    const e = explain('FR', c5, alg);
    expect(e.head).toBe('Borrow a neighbouring slot.');
    expect(e.body).toContain('back-right');
  });
  it("R U R' from case 12's picture: the corner is carried round, the top layer repositions, the last move inserts", () => {
    const t = trace('FR', "R U R'");
    expect(t.caption).toContain('Start: corner UFR with white right, edge UB.');
    expect(t.rows.map((r) => r[0])).toEqual(['1. R', '2. U', "3. R'"]);
    expect(t.rows[0][3]).toBe('carry the corner around');
    expect(t.rows[2]).toEqual(["3. R'", 'in front-right, white down', 'in front-right', 'insert: pair solved']);
  });
  it('every alg on the sheet traces, with a move that solves the pair', () => {
    for (const slot of SLOTS) {
      for (const c of Object.values(DATA.slots[slot].cases)) {
        for (const a of [...c.algs, c.simple, ...c.others.map((o) => o.alg)]) {
          const t = trace(slot, fullAlg('', a));
          expect(t.rows.length, `${slot} ${c.n} ${a}`).toBeGreaterThan(0);
          // the insert is not always the last move: R L U' L U' R' U L2 (FR 22) ends by returning a borrowed pair
          expect(t.rows.some((r) => r[3].includes('insert: pair solved')), `${slot} ${c.n} ${a}`).toBe(true);
          explain(slot, c, a);
        }
      }
    }
  }, 30000);
  it('describes a placement in words', () => {
    expect(describePair({ pos: 'UFR', o: 'ud' }, 'FL')).toBe('corner at UFR, white facing up; edge in the front-left slot');
    expect(describePair({ pos: 'DBL', o: 'ud' }, null)).toBe('corner in the back-left slot, white facing down');
    expect(describePair(null, 'UB')).toBe('edge at UB');
    expect(describePair({ pos: 'DBR', o: 'rl' }, 'UF')).toBe('corner in the back-right slot, white on the red side; edge at UF');
  });
});

describe('the favourite alg (the case sheet\'s star)', () => {
  it('leads the list once starred, where it can be done, and the standard comes back on null', async () => {
    const { allAlgs, byLength, caseId, caseOf, f2lIsFavourite, f2lMainAlg, f2lSetMainAlg, f2lStandardAlg, fullAlg, listFor, orderedAlgs, positionAlgs, shownAlg, SLOTS } = await import('../src/f2l/model');
    const { moveCount } = await import('../src/cube/alg');
    const { DATA } = await import('../src/f2l/data');
    const c = DATA.slots.FR.cases['4']!; // three sheet algs and two slot shortcuts
    const id = caseId('FR', c.n);
    expect(caseOf(id)).toEqual({ slot: 'FR', c });
    expect(caseOf('FR-999')).toBeNull();
    // the standard: the shortest solution the filter shows that needs no slot open
    const std = f2lStandardAlg(id)!;
    expect(f2lMainAlg(id)).toBe(std);
    const ok = positionAlgs('FR', c, '').filter((x) => shownAlg(x) && !x.needs.length);
    expect(moveCount(fullAlg('', std))).toBe(Math.min(...ok.map((x) => x.n)));
    expect(moveCount(fullAlg('', std))).toBeLessThan(Math.min(...c.algs.map((a) => moveCount(fullAlg('', a))))); // the sheet's best is 11
    expect(byLength(["(U2) R U R' U R' D' R U' R' D R", "R U' R'", "R U R' U2 R U' R' U R U' R'"])).toEqual(["R U' R'", "R U R' U2 R U' R' U R U' R'", "(U2) R U R' U R' D' R U' R' D R"]);
    // the position's AUF folded in: (U') R U' R' from a U-away position is three moves, the bare alg becomes four
    expect(byLength(["R U R' U'", "(U') R U' R'"], 'U')).toEqual(["(U') R U' R'", "R U R' U'"]);
    expect(orderedAlgs('FR', DATA.slots.FR.cases['1']!, "U'")[0]).toBe("(U) R U' R'");
    expect(f2lSetMainAlg(id, "R U R' U'")).toBe(false); // not one of its algs
    const pick = c.others[0]!.alg; // a shortcut: it needs a slot open
    expect(allAlgs('FR', c)).toContain(pick);
    expect(f2lSetMainAlg(id, pick)).toBe(true);
    expect([f2lMainAlg(id), f2lIsFavourite(id)]).toEqual([pick, true]);
    expect(listFor('FR', c, '', new Set()).lead?.alg).toBe(pick); // every slot open: the pick leads
    const allSolved = listFor('FR', c, '', new Set(SLOTS));
    expect(allSolved.lead?.alg).toBe(std); // its slot solved: it cannot lead, and it is listed greyed
    expect(allSolved.rows.find((x) => x.alg === pick)?.usable).toBe(false);
    expect(f2lSetMainAlg(id, null)).toBe(true);
    expect([f2lMainAlg(id), f2lIsFavourite(id)]).toEqual([std, false]);
    expect(f2lSetMainAlg(id, std)).toBe(true); // the standard starred is no favourite
    expect(f2lIsFavourite(id)).toBe(false);
  });
  it('the move filter: a hidden kind of move takes its algs out of every list', async () => {
    const { algTools, listFor, positionAlgs, setHiddenTools, SLOTS } = await import('../src/f2l/model');
    const { DATA } = await import('../src/f2l/data');
    expect(algTools("R L' U R' L")).toEqual(['LR']);
    expect(algTools("R U R'")).toEqual([]);
    expect(algTools("R U R' U' L' U L")).toEqual([]); // one side, then the other: not at once
    expect(algTools("F2 U F2 U' F2")).toEqual(['F2x']); // three half turns: more than one pair
    expect(algTools("R U R2 F2 R F2")).toEqual(['F2']); // one F2 pair
    expect(algTools("R U B2 R' B2 R2 F2 R F2")).toEqual(['F2x']); // a pair on each face
    expect(algTools("R' F R F'")).toEqual(['FB']);
    expect(algTools("r U R' U' M")).toEqual(['wide', 'slice']);
    expect(algTools("R2 u R2 u' R2")).toEqual(['wide']);
    expect(algTools("(U) L' U S' L2 S L2 U' L")).toEqual(['slice']);
    // the D turns by their shape, as the explanations already tell them apart: one out and back, or a D2 / several
    // (the sheet has no several-D alg without a D2, so those share the D2 kind)
    expect(algTools("R' D' R U' R' D R")).toEqual(['D']);
    expect(algTools("R' D2 R U' R' D2 R")).toEqual(['D2']);
    expect(algTools("R' D' R U R' D R U' R' D' R U R' D R")).toEqual(['D2']);
    const c = DATA.slots.FR.cases['39']!;
    const anyF2 = (x: { tools: string[] }) => x.tools.includes('F2') || x.tools.includes('F2x');
    expect(positionAlgs('FR', c, '').some(anyF2)).toBe(true);
    expect(listFor('FR', c, '', new Set(SLOTS)).rows.some(anyF2)).toBe(false); // hidden to begin with (both F2 kinds)
    setHiddenTools(['D', 'D2', 'LR']);
    expect(listFor('FR', c, '', new Set(SLOTS)).rows.some(anyF2)).toBe(true);
    expect(listFor('FR', c, '', new Set(SLOTS)).rows.some((x) => x.tools.some((t) => t === 'D' || t === 'D2' || t === 'LR'))).toBe(false);
    setHiddenTools(['F2', 'F2x']);
  });
});

describe('what the move filter does (the chips say it)', () => {
  it('hiddenBy names the hidden kinds of move in a solution; toolCounts counts the algs and cases a chip alone decides', async () => {
    const { algTools, hiddenBy, positionAlgs, setHiddenTools, toolCounts, SLOTS } = await import('../src/f2l/model');
    setHiddenTools(['F2', 'F2x', 'wide']);
    expect(hiddenBy({ tools: algTools("R2 u R2 u' R2") })).toEqual(['wide']);
    expect(hiddenBy({ tools: algTools("R U R'") })).toEqual([]);
    // the ten wide/slice/rotation algs on the sheet (2026-09-28), all from the sheet itself: eight wide turns in
    // seven cases (front-left 13 has two), three with a slice or rotation (one of them, back-left 27, wide too)
    const all = toolCounts(), fr = toolCounts(['FR']);
    expect(all.wide).toEqual({ algs: 8, cases: 7 });
    expect(all.slice).toEqual({ algs: 2, cases: 2 }); // back-left 27's l U2 R' U2 x is hidden by wide as well, so slice alone would not show it
    expect(fr.wide).toEqual({ algs: 2, cases: 2 });
    // an alg hidden by two chips counts for neither: turning one on alone would not show it
    const every = SLOTS.flatMap((s) => Object.values(DATA.slots[s].cases).flatMap((c) => positionAlgs(s, c, '')));
    const both = every.filter((x) => x.tools.includes('wide') && (x.tools.includes('F2') || x.tools.includes('F2x')));
    expect(every.filter((x) => x.tools.includes('wide')).length - both.length).toBe(all.wide.algs);
    setHiddenTools(['F2', 'F2x']);
    // with wide and slice shown their counts say what each chip alone would hide: the shared alg now counts for both
    expect(toolCounts().wide.algs).toBe(8);
    expect(toolCounts().slice.algs).toBe(3);
  });
});

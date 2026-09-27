// The F2L voice drill's words: what a transcript names, the technique an alg shows, and the judging of an
// answer against a pair on a cube (the case's own picture, the other three pairs solved).
import { describe, expect, it } from 'vitest';
import { state } from '../src/cube/state';
import { DATA } from '../src/f2l/data';
import { heardF2L, judge, pairCall, techniques, TECH_NOTE, type Technique } from '../src/f2l/callout';
import { fullAlg, invert, listFor, SLOTS, type SlotName } from '../src/f2l/model';

describe('heardF2L', () => {
  it('reads a slot and a technique', () => {
    expect(heardF2L('front left D conjugate')).toMatchObject({ slot: 'FL', tech: 'dconj', n: null });
    expect(heardF2L('Front right keyhole')).toMatchObject({ slot: 'FR', tech: 'keyhole' });
    expect(heardF2L('back-left the conjugate')).toMatchObject({ slot: 'BL', tech: 'dconj' });
    expect(heardF2L('back right key hole')).toMatchObject({ slot: 'BR', tech: 'keyhole' });
    expect(heardF2L('front left F conjugate')).toMatchObject({ slot: 'FL', tech: 'fconj' });
    expect(heardF2L('front right F2')).toMatchObject({ slot: 'FR', tech: 'f2', n: null });
    expect(heardF2L('front right F two')).toMatchObject({ slot: 'FR', tech: 'f2', n: null });
    expect(heardF2L('back left insert')).toMatchObject({ slot: 'BL', tech: 'insert' });
    expect(heardF2L('front left both sides')).toMatchObject({ slot: 'FL', tech: 'sides', n: null });
    expect(heardF2L('front left D2 conjugate')).toMatchObject({ slot: 'FL', tech: 'd2conj', n: null });
    expect(heardF2L('back right d two conjugate')).toMatchObject({ slot: 'BR', tech: 'd2conj', n: null });
    expect(heardF2L('back right double D')).toMatchObject({ slot: 'BR', tech: 'ddconj' });
  });
  it('reads a case number', () => {
    expect(heardF2L('front left 17')).toMatchObject({ slot: 'FL', tech: null, n: 17 });
    expect(heardF2L('back right case twelve')).toMatchObject({ slot: 'BR', n: 12 });
  });
  it('reads a surrender, and ignores talk', () => {
    expect(heardF2L('front right tell me')).toMatchObject({ slot: 'FR', giveUp: true });
    expect(heardF2L('what is for dinner')).toBeNull();
  });
});

describe('techniques', () => {
  it('a keyhole is a D conjugate through an open slot', () => {
    expect(techniques({ tools: ['D'], needs: ['FR'], n: 5 })).toEqual(['keyhole', 'dconj']);
    expect(techniques({ tools: ['D'], needs: [], n: 8 })).toEqual(['dconj']);
    expect(techniques({ tools: ['D'], needs: [], n: 8, full: "D2 R U R' D2 R U' R'" })).toEqual(['d2conj', 'dconj']);
    expect(techniques({ tools: ['D'], needs: ['BR'], n: 8, full: "D R U R' D' D R U' R' D'" })).toEqual(['keyhole', 'ddconj', 'dconj']);
    expect(techniques({ tools: [], needs: [], n: 3 })).toEqual(['insert']);
    expect(techniques({ tools: [], needs: [], n: 7 })).toEqual(['regular']);
    expect(techniques({ tools: [], needs: ['BL'], n: 5 })).toEqual(['shortcut']);
  });
  it('every technique has a line in the note', () => {
    const all: Technique[] = ['keyhole', 'd2conj', 'ddconj', 'dconj', 'fconj', 'f2', 'wide', 'sides', 'shortcut', 'insert', 'regular'];
    expect(TECH_NOTE.map(([t]) => t).sort()).toEqual([...all].sort());
  });
});

describe('judge', () => {
  const others = (s: SlotName) => new Set(SLOTS.filter((x) => x !== s));
  it('names every case on every slot by its lead alg, and says no to a wrong technique', () => {
    let n = 0;
    for (const slot of SLOTS) {
      for (const c of Object.values(DATA.slots[slot].cases)) {
        const lead = listFor(slot, c, '', others(slot)).lead;
        if (!lead) continue;
        const f = state(invert(fullAlg('', lead.alg)));
        const call = pairCall(f, slot, others(slot));
        expect(call, `${slot} ${c.n}`).not.toBeNull();
        const techs = techniques(lead);
        expect(call!.techs).toEqual(techs);
        const said = { slot, n: null, giveUp: false };
        expect(judge({ ...said, tech: techs[0]! }, f, others(slot)).right).toBe(true);
        expect(judge({ ...said, tech: null, n: call!.n }, f, others(slot)).right).toBe(true);
        const wrong = (['wide', 'regular'] as const).find((t) => !techs.includes(t))!;
        const r = judge({ ...said, tech: wrong }, f, others(slot));
        expect(r.right).toBe(false);
        expect(r.say).toMatch(/^no, /);
        n++;
      }
    }
    expect(n).toBeGreaterThan(300);
  });
  it('a solved pair, and no pair named', () => {
    const f = state('');
    expect(judge({ slot: 'FL', tech: 'dconj', n: null, giveUp: false }, f, new Set(SLOTS)).say).toBe('front left is solved');
    expect(judge({ slot: null, tech: 'dconj', n: null, giveUp: false }, f, new Set()).right).toBeNull();
  });
});

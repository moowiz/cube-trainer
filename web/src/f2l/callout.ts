// The F2L voice drill's words (user, 2026-09-27): a pair's case named by what you would do for it - "front left
// D conjugate", "front right keyhole" - and a transcript read back as a slot and a technique. Pure, so it is
// testable without a browser or a cube; the listening and the calling out are in voice.ts.
//
// A technique is read off the alg the finder leads with for the case where it stands (your favourite when it
// can be done, else the shortest with the solved slots kept, model.listFor): what kinds of move it uses and
// whether it goes through an open slot. An answer is right when it names any technique that alg has - a keyhole
// is a D conjugate too - or the case's number.

import { dShape, findCase, listFor, slotState, SLOT_WORD, SLOTS, twinOf, type SlotName, type Solution } from './model';

export type Technique = 'keyhole' | 'd2conj' | 'ddconj' | 'dconj' | 'fconj' | 'f2' | 'wide' | 'sides' | 'shortcut' | 'insert' | 'regular';
/** What the voice says for a technique. */
export const TECH_WORD: Record<Technique, string> = {
  keyhole: 'keyhole', d2conj: 'D2 conjugate', ddconj: 'double D', dconj: 'D conjugate', fconj: 'F conjugate', f2: 'F2', wide: 'wide', sides: 'both sides',
  shortcut: 'shortcut', insert: 'insert', regular: 'regular',
};
/** How the voice says it (the synthesiser reads "F2" as "F2" the model number). */
const TECH_SAID: Partial<Record<Technique, string>> = { f2: 'F two', d2conj: 'D two conjugate', dconj: 'D conjugate', fconj: 'F conjugate' };
const techSaid = (t: Technique): string => TECH_SAID[t] ?? TECH_WORD[t];
/** For the settings note: what each technique means, in the order they are listed. */
export const TECH_NOTE: [Technique, string][] = [
  ['keyhole', 'D turns, through an open slot next to it'],
  ['d2conj', 'a D2 among the D turns: the slot opposite comes under (also a D conjugate)'],
  ['ddconj', 'D turns out and back more than once (also a D conjugate)'],
  ['dconj', 'D turns, every other slot kept'],
  ['fconj', 'an F or B quarter turn, undone later'],
  ['f2', 'F2 or B2'],
  ['wide', 'wide or slice turns'],
  ['sides', 'R and L turning at once, one slot held open'],
  ['shortcut', 'R/L/U through an open slot, leaving it changed'],
  ['insert', 'a basic insert: four moves or fewer with the U turn'],
  ['regular', 'anything else in R/L/U, one side at a time'],
];

/** Every technique an alg shows, the one to say first: keyhole before D conjugate, and so on down TECH_NOTE. */
export function techniques(s: Pick<Solution, 'tools' | 'needs' | 'n'> & { full?: string }): Technique[] {
  const out: Technique[] = [];
  const t = new Set(s.tools);
  if (t.has('D')) {
    if (s.needs.length) out.push('keyhole');
    const shape = s.full ? dShape(s.full) : 'D';
    if (shape === 'D2') out.push('d2conj'); else if (shape === 'DD') out.push('ddconj');
    out.push('dconj');
  }
  if (t.has('FB')) out.push('fconj');
  if (t.has('F2')) out.push('f2');
  if (t.has('wide')) out.push('wide');
  if (t.has('LR')) out.push('sides');
  if (!out.length && s.needs.length) out.push('shortcut');
  if (!t.size && s.n <= 4) out.push('insert');
  if (!out.length) out.push('regular');
  return out;
}

/** A pair's case on a cube (trainer frame), as the drill names it: its number, the alg and the techniques. */
export interface PairCall { slot: SlotName; n: number; caseN: number; alg: string; moves: number; techs: Technique[] }
export function pairCall(f: string, slot: SlotName, solved: ReadonlySet<SlotName>): PairCall | null {
  const st = slotState(f, slot);
  const found = findCase(slot, st.corner, st.edge);
  if (!found) return null;
  const lead = listFor(slot, found.c, found.hit.auf, new Set([...solved].filter((x) => x !== slot))).lead;
  if (!lead) return null;
  return { slot, n: twinOf(slot, found.c.n), caseN: found.c.n, alg: lead.full, moves: lead.n, techs: techniques(lead) };
}
/** "front left keyhole" */
export const callText = (c: PairCall): string => `${SLOT_WORD[c.slot].replace('-', ' ')} ${techSaid(c.techs[0]!)}`;

// ---- hearing: a slot, then a technique or a case number ----

const SLOT_RE: [RegExp, SlotName][] = [
  [/\b(front|fronts|frunt)[\s-]*(right|write|rite)\b|\bright[\s-]*front\b|\bf\s?r\b/, 'FR'],
  [/\b(front|fronts|frunt)[\s-]*left\b|\bleft[\s-]*front\b|\bf\s?l\b/, 'FL'],
  [/\b(back|bach|bak)[\s-]*(right|write|rite)\b|\bright[\s-]*back\b|\bb\s?r\b/, 'BR'],
  [/\b(back|bach|bak)[\s-]*left\b|\bleft[\s-]*back\b|\bb\s?l\b/, 'BL'],
];
// a technique as said, and as the recogniser tends to write it ("the conjugate", "key hole", "f too")
const TECH_RE: [RegExp, Technique][] = [
  [/\bkey\s*(hole|whole|hold|hall)s?\b|\bkeyhole/, 'keyhole'],
  [/\b(f|ef|eff|front|b|be|bee)\s*-?\s*(conjugate|conjugates|conjugated)\b/, 'fconj'],
  [/\b(d|dee|de|the)\s*-?\s*(2|two|too|to)\s*-?\s*(conjugate|conjugates|conjugated)\b|\bd2\s*conjugat/, 'd2conj'],
  [/\bdouble\s*(d|dee|de|the)\b/, 'ddconj'],
  [/\b(d|dee|de|the|down)\s*-?\s*(conjugate|conjugates|conjugated)\b|\bconjugate\b|\bd\s*(turn|layer)s?\b/, 'dconj'],
  [/\b(f|ef|eff|b|be|bee)\s*-?\s*(2|two|too|to)\b|\bf2\b|\bb2\b/, 'f2'],
  [/\b(wide|slice|slices|wides)\b/, 'wide'],
  [/\b(both|two)\s*sides?\b|\boverlap/, 'sides'],
  [/\bshort\s*cut|\bopen\s*slot/, 'shortcut'],
  [/\b(insert|basic|direct|easy|simple)\b/, 'insert'],
  [/\b(regular|normal|plain|r\s*u|two\s*gen|standard)\b/, 'regular'],
];
const GIVE_UP = /\b(give up|skip|tell me|pass|dunno|don'?t know|no idea|what is it|what'?s that)\b/;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

export interface Heard {
  slot: SlotName | null;
  tech: Technique | null;
  /** a case number ("case 17", "front left 17") */
  n: number | null;
  giveUp: boolean;
}
/** A transcript read as a slot and a technique or case number; null when it names none of those. */
export function heardF2L(transcript: string): Heard | null {
  let t = ` ${transcript.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ')} `;
  let slot: SlotName | null = null;
  for (const [re, s] of SLOT_RE) { const m = re.exec(t); if (m) { slot = s; t = t.replace(m[0], ' '); break; } }
  let tech: Technique | null = null;
  for (const [re, k] of TECH_RE) if (re.test(t)) { tech = k; break; }
  // a number (said as digits, or a word) is a case number, but not the "2" of an F2 nor the "two" of "two sides"
  let n: number | null = null;
  if (!tech || (tech !== 'f2' && tech !== 'sides')) {
    const d = /\b(\d{1,2})\b/.exec(t);
    const w = /\b(case|number)\s+([a-z]+)\b/.exec(t);
    if (d) n = Number(d[1]);
    else if (w && NUMBER_WORDS[w[2]!]) n = NUMBER_WORDS[w[2]!]!;
  }
  const giveUp = GIVE_UP.test(t);
  if (!slot && !tech && n === null && !giveUp) return null;
  return { slot, tech, n, giveUp };
}

/** The drill's reply to an answer about a pair on the cube: what to say, and whether it was right (null: nothing to judge). */
export function judge(h: Heard, f: string, solved: ReadonlySet<SlotName>): { say: string; right: boolean | null } {
  if (!h.slot) return { say: 'which pair?', right: null };
  const where = SLOT_WORD[h.slot].replace('-', ' ');
  if (solved.has(h.slot)) return { say: `${where} is solved`, right: null };
  const c = pairCall(f, h.slot, solved);
  if (!c) return { say: `can't read ${where}`, right: null };
  const name = `${techSaid(c.techs[0]!)}, case ${c.n}`;
  if (h.giveUp || (!h.tech && h.n === null)) return { say: `${where}: ${name}`, right: null };
  const right = (h.tech !== null && c.techs.includes(h.tech)) || (h.n !== null && h.n === c.n);
  return { say: right ? `yes${h.tech && h.tech !== c.techs[0] ? `, ${techSaid(c.techs[0]!)}` : ''}` : `no, ${name}`, right };
}

/** The open pairs' calls on a cube, in the order front right, front left, back right, back left. */
export function openCalls(f: string, solved: ReadonlySet<SlotName>): PairCall[] {
  return SLOTS.filter((s) => !solved.has(s)).flatMap((s) => { const c = pairCall(f, s, solved); return c ? [c] : []; });
}

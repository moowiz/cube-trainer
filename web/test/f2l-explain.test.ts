// explain() on every alg the F2L finder can show (each case's sheet algs, its R/L/U alg and its slot
// shortcuts, all four slots), with every claim its text makes checked against the alg's own moves.
// The checks here are independent of model.ts's: positions come straight from the facelets, "ready for
// a basic insert" is tried by doing U turns and the insert, and a shortcut's slot is the one it leaves
// changed. Any sentence the moves do not bear out fails with the slot, the case and the alg.
import { describe, expect, it } from 'vitest';
import { tokens } from '../src/cube/alg';
import { facesAt, posName, STICKERS, type Vec } from '../src/cube/geometry';
import { cubieSolved, EDGE_POS, edgeState, findCorner, findEdge } from '../src/cube/pieces';
import { CENTRE, rawFacelets, SOLVED, state, stepStates } from '../src/cube/state';
import { DATA } from '../src/f2l/data';
import { allAlgs, explain, fullAlg, invert, normalizeAlg, SLOT_WORD, slotSolved, SLOTS, withAuf, type SlotName } from '../src/f2l/model';

const INSERTS: Record<SlotName, string[]> = { FR: ["R U R'", "R U' R'"], FL: ["L' U' L", "L' U L"], BR: ["R' U' R", "R' U R"], BL: ["L U L'", "L U' L'"] };
const CROSS: Vec[] = [[0, -1, 1], [1, -1, 0], [0, -1, -1], [-1, -1, 0]];

interface At { f: string; cAt: string; eAt: string; cU: boolean; eU: boolean; cHome: boolean; eHome: boolean; white: string; joined: boolean }
function at(f: string, slot: SlotName): At {
  const c = findCorner(f, `D${slot}`, 'D');
  const ep = EDGE_POS[findEdge(f, slot)];
  const e: Vec = [slot[1] === 'R' ? 1 : -1, 0, slot[0] === 'F' ? 1 : -1];
  const cU = c.pos[1] === 1, eU = ep[1] === 1;
  // joined: side by side in the top layer, the stickers on the two faces they share the same colours
  let joined = false;
  if (cU && eU && ((ep[0] === 0 && ep[2] === c.pos[2]) || (ep[2] === 0 && ep[0] === c.pos[0]))) {
    const ci = facesAt(c.pos);
    joined = facesAt(ep).every((i) => f[i] === f[ci.find((k) => STICKERS[k]!.face === STICKERS[i]!.face)!]);
  }
  return { f, cAt: posName(c.pos), eAt: posName(ep), cU, eU, cHome: cubieSolved(f, [e[0], -1, e[2]]), eHome: cubieSolved(f, e), white: c.face, joined };
}
const liftedU = (f: string, s: SlotName) => findCorner(f, `D${s}`, 'D').pos[1] === 1 || EDGE_POS[findEdge(f, s)][1] === 1;
const ready = (f: string, slot: SlotName) => ['', 'U ', 'U2 ', "U' "].some((u) => INSERTS[slot].some((m) => slotSolved(stepStates(f, u + m).at(-1)!, slot)));
const net = (toks: string[], face: string) => toks.filter((t) => t[0] === face).reduce((n, t) => n + (t.endsWith("'") ? 3 : t.endsWith('2') ? 2 : 1), 0) % 4;

/** Every false claim in explain(slot, c, alg)'s text. */
function falseClaims(slot: SlotName, c: (typeof DATA.slots)['FR']['cases'][string], alg: string): string[] {
  const bad: string[] = [];
  const claim = (ok: boolean, what: string) => { if (!ok) bad.push(what); };
  const { head, body } = explain(slot, c, alg);
  const full = fullAlg('', alg);
  const { pre, rest } = withAuf('', alg);
  const toks = rest ? tokens(rest) : [];
  const start = state(invert(full));
  const s0 = pre ? stepStates(start, pre).at(-1)! : start;
  const S = [s0, ...stepStates(s0, toks.join(' '))].map((f) => at(f, slot));
  const end = S.at(-1)!.f;
  const up = (k: number) => (k > 0 ? toks[k - 1]! : '');
  // when each piece first leaves the spot it starts in
  const cUp = S.findIndex((x) => x.cAt !== S[0]!.cAt), eUp = S.findIndex((x) => x.eAt !== S[0]!.eAt);
  const cSlot = c.corner.startsWith('U') ? null : c.corner.slice(1), eSlot = c.edge.startsWith('U') ? null : c.edge;
  const has = (s: string) => body.includes(s);

  claim(slotSolved(end, slot), 'the alg solves the pair');
  // the edge never moving
  if (has('never moves')) claim(S.every((x) => x.eHome), 'edge never moves');
  if (head === 'Slide the corner under.' || head === 'Corner under the edge.') claim(S.every((x) => x.eHome), 'the edge stays home throughout');
  if (head === 'Slide the corner under.') claim(!!cSlot && cSlot !== slot, 'slide: corner starts in another slot');
  if (head === 'Corner under the edge.') claim(!cSlot, 'corner under: corner starts on top');
  if (has('carry it round underneath the edge')) {
    let k = S.length - 1;
    while (k > 0 && S[k - 1]!.cHome) k--;
    claim(up(k)[0] === 'D', 'a D turn brings the corner home');
  }
  if (has('so the cross ends where it started')) claim(net(toks, 'D') === 0 && CROSS.every((p) => cubieSolved(end, p)), 'D turns cancel, cross home');
  // F and B named by the face turned
  for (const m of body.matchAll(/of the (front|back) \(([FB][2']?)\)/g)) {
    claim(toks.includes(m[2]!), `${m[2]} is in the alg`);
    claim((m[1] === 'front') === (m[2]![0] === 'F'), `${m[2]} is a turn of the ${m[1]}`);
  }
  if (/^[FB] conjugate\.$/.test(head)) claim(toks.some((t) => new RegExp(`^${head[0]}'?$`).test(t)), `${head} turns ${head[0]}`);
  if (/^[FB]2 flip\.$/.test(head)) claim(toks.includes(`${head[0]}2`), `${head} turns ${head[0]}2`);
  const pairedWith = /it is paired with (\S+) later/.exec(body);
  if (pairedWith) {
    const q = /\(([FB]'?)\)/.exec(body)![1]!;
    claim(toks.indexOf(pairedWith[1]!, toks.indexOf(q) + 1) > 0, `${q} is undone by ${pairedWith[1]} later`);
  }
  if (has('every edge is oriented again at the end')) claim(edgeState(end).eo === 0, 'edges oriented at the end');
  const opens = /Here (\S+) opens the slot by lifting the solved corner/.exec(body);
  if (opens) { const k = toks.indexOf(opens[1]!); claim(S[k]!.cHome && S[k + 1]!.cU, `${opens[1]} lifts the solved corner`); }
  const putsIn = /Here (\S+) is the move that puts the pair in/.exec(body);
  if (putsIn) {
    let k = S.length - 1;
    while (k > 0 && S[k - 1]!.cHome && S[k - 1]!.eHome) k--;
    claim(up(k) === putsIn[1], `${putsIn[1]} puts the pair in`);
  }
  if (has('leaving the centres where they started')) claim(Object.entries(CENTRE).every(([face, i]) => rawFacelets(full)[i] === face), 'centres back');
  // the 3-move inserts
  if (head === 'Direct insert.') {
    claim(toks.length === 3 && toks[1]![0] === 'U', 'three moves with a U turn in the middle');
    claim(!!S[2]?.joined, 'joined over the slot after the U turn');
    claim(has('already joined') === S[0]!.joined && has('are apart') === !S[0]!.joined, 'joined or apart at the start');
  }
  const last3 = /The last three moves are the basic (.+?) insert\./.exec(body);
  if (last3) claim(INSERTS[slot].includes(last3[1]!) && toks.slice(-3).join(' ') === last3[1], `ends with ${last3[1]}`);
  if (has('one of the two basic insert pictures')) claim(!!last3, 'reaches an insert picture (and says which)');
  if (has('not lined up for a basic insert')) claim(!ready(S[0]!.f, slot), 'not lined up at the start');
  const tilt = /white no longer faces up \(move (\d+), (\S+)\)/.exec(body);
  if (head === 'Tilt, then insert.') claim(!!tilt, 'tilt names the move');
  if (tilt) { const k = Number(tilt[1]); claim(S.findIndex((x) => x.white !== 'U') === k && up(k) === tilt[2] && k < toks.length, `move ${k} (${tilt[2]}) turns white off the top`); }
  // order and means of taking the pieces out
  const piece = (w: string) => (w === 'the corner' ? cUp : eUp);
  for (const m of body.matchAll(/(the corner|the edge)(?: out)? first, then (the corner|the edge)/g)) claim(piece(m[1]!) < piece(m[2]!) && piece(m[1]!) > 0, `${m[1]} comes out before ${m[2]}`);
  for (const m of body.matchAll(/(the corner|the edge) and (the corner|the edge)(?: out)? on the same move/g)) claim(piece(m[1]!) === piece(m[2]!) && cUp > 0, 'both come out on one move');
  const ownTurn = (k: number, s: string | null) => !!s && k > 0 && s.includes(up(k)[0]!);
  if (has("Each is popped out with its own slot's turns")) claim(ownTurn(cUp, cSlot) && ownTurn(eUp, eSlot), "each popped by its own slot's turn");
  if (has("popping the corner with its slot's own turns")) claim(ownTurn(cUp, cSlot), "corner popped by its slot's turn");
  if (has("popping the edge with its slot's own turns")) claim(ownTurn(eUp, eSlot), "edge popped by its slot's turn");
  if (/pop it out with that slot's own turns|popped out with that slot's own turns/.test(body)) {
    const pc = head.startsWith('Pop the corner'), pe = head.startsWith('Pop the edge');
    claim((pe || ownTurn(cUp, cSlot)) && (pc || ownTurn(eUp, eSlot)), "popped by that slot's turn");
  }
  if (has('so it lands ready for a basic insert')) {
    const from = head.startsWith('Pop the corner') ? cUp : eUp, faces = (head.startsWith('Pop the corner') ? cSlot : eSlot)!;
    const r = S.findIndex((x, i) => i >= from && ready(x.f, slot));
    claim(r > 0 && toks.slice(0, r).every((t) => t[0] === 'U' || faces.includes(t[0]!)), 'only the pop comes before a basic insert');
  }
  if (/join|meet in the top layer|as a pair/.test(body.replace(/already joined|joins the pair over it|brings the pair over it|can't be joined/g, ''))) claim(S.some((x) => x.joined), 'the pieces are joined in the top layer at some point');
  if (has('the first three moves lift both pieces out')) claim(!!S[3]?.cU && !!S[3]?.eU, 'both on top after three moves');
  if (has('takes the corner out')) claim(cUp > 0, 'the corner comes out');
  if (has('pulls it out')) claim(eUp > 0, 'the edge comes out');
  // other slots: borrowed (lifted and put back) or used (left changed)
  const fs = [SOLVED, ...stepStates(SOLVED, normalizeAlg(full))], all = tokens(normalizeAlg(full));
  const others = SLOTS.filter((s) => s !== slot && s !== cSlot && s !== eSlot);
  const used = SLOTS.filter((s) => s !== slot && s !== cSlot && s !== eSlot && !slotSolved(fs.at(-1)!, s));
  const borrowed = others.filter((s) => !used.includes(s) && fs.some((f) => liftedU(f, s)));
  const lifts = borrowed.flatMap((b) => fs.slice(1).flatMap((f, i) => (!liftedU(fs[i]!, b) && liftedU(f, b) ? [all[i]!] : [])));
  claim(has('Along the way it lifts') === borrowed.length > 0, `borrowed: ${borrowed.join(',') || 'none'}`);
  for (const b of borrowed) claim(new RegExp(`lifts the [a-z -]*${SLOT_WORD[b]}`).test(body), `names the borrowed ${SLOT_WORD[b]} slot`);
  if (has('the half turns do that')) claim(lifts.every((t) => /2/.test(t)), `half turns lift the borrowed slot (${lifts.join(' ')})`);
  claim(has('slot shortcut') === used.length > 0, `shortcut through: ${used.join(',') || 'none'}`);
  for (const s of used) claim(body.includes(`runs through the ${SLOT_WORD[s]}`) || body.includes(`and ${SLOT_WORD[s]} slots`), `names the used ${SLOT_WORD[s]} slot`);
  const o = c.others.find((x) => x.alg === alg);
  if (o) claim([...o.free].sort().join() === [...used].sort().join(), `the sheet's free slots (${o.free}) are the ones it uses`);
  return bad.map((b) => `${slot} ${c.n} ${alg} [${head}]: ${b}`);
}

describe('explain() says only what the alg does', () => {
  for (const slot of SLOTS) {
    it(`every alg of every ${SLOT_WORD[slot]} case`, () => {
      const bad = Object.values(DATA.slots[slot].cases).flatMap((c) => allAlgs(c).flatMap((a) => falseClaims(slot, c, a)));
      expect(bad).toEqual([]);
    });
  }
  it('names what it covers: a D-layer slide, a corner slid under from the top, a back-face flip and a shortcut', () => {
    const e = (slot: SlotName, n: number, alg: string) => explain(slot, DATA.slots[slot].cases[n]!, alg);
    expect(e('FL', 41, "R U' R' U D R U' R' D'").head).toBe('Slide the corner under.');
    expect(e('FR', 48, "D R U R' D' R U' R'").head).toBe('D-layer conjugate.'); // the edge rides out and back: no slide
    expect(e('FL', 18, "R' D R U' R' D' R").head).toBe('Corner under the edge.');
    expect(e('BR', 26, "(U') r' U2 r B2").head).toBe('B2 flip.');
    const cut = DATA.slots.FR.cases['51']!.others[0]!; // the pair sits in front-left; this one also goes through back-right
    expect(cut.free).toEqual(['BR']);
    expect(e('FR', 51, cut.alg).body).toContain('runs through the back-right slot and leaves other pieces there');
  });
});

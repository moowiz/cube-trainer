// A 12-edge model of the cube for node-side EOCross analysis, in the trainer's move order
// (U U' U2 R R' R2 F F' F2 D D' D2 L L' L2 B B' B2). Slots: UF UR UB UL DF DR DB DL FR FL BR BL.
// EO is relative to the F/B axis (a quarter turn of F or B flips its four edges). Independent of the
// trainer's sticker model on purpose; tools/eocross/check.mjs verifies the two agree.
const SLOTS = ['UF','UR','UB','UL','DF','DR','DB','DL','FR','FL','BR','BL'];
const E = Object.fromEntries(SLOTS.map((n, i) => [n, i]));
// clockwise 4-cycles of slots for each face
const CYC = { U:['UF','UL','UB','UR'], D:['DF','DR','DB','DL'], R:['UR','BR','DR','FR'], L:['UL','FL','DL','BL'], F:['UF','FR','DF','FL'], B:['UB','BL','DB','BR'] };
const MOVES = [];
for (const f of 'URFDLB') for (const k of [1, 3, 2]) {
  const perm = [...Array(12).keys()]; const c = CYC[f].map(n => E[n]);
  for (let i = 0; i < 4; i++) perm[c[(i + k) % 4]] = c[i]; // perm[dest] = source
  MOVES.push({ name: f + ['', '', '2', "'"][k], face: f, perm, flip: 'FB'.includes(f) && k !== 2 });
}
const HOME = ['DF', 'DR', 'DB', 'DL'].map(n => E[n]);
// a state: {eo: 12-bit flip vector, slots: current slot of DF DR DB DL}
function apply(st, m) {
  const p = m.perm; let o = 0;
  for (let i = 0; i < 12; i++) { let b = (st.eo >> p[i]) & 1; if (m.flip && p[i] !== i) b ^= 1; o |= b << i; }
  const inv = new Array(12); for (let i = 0; i < 12; i++) inv[p[i]] = i;
  return { eo: o, slots: st.slots.map(s => inv[s]) };
}
const SOLVED = () => ({ eo: 0, slots: HOME.slice() });
const byName = Object.fromEntries(MOVES.map((m, i) => [m.name, i]));
const run = (st, alg) => alg.trim().split(/\s+/).filter(Boolean).reduce((s, n) => apply(s, MOVES[byName[n]]), st);
const inv = alg => alg.trim().split(/\s+/).filter(Boolean).reverse().map(m => m.endsWith("'") ? m[0] : m.endsWith('2') ? m : m + "'").join(' ');
function randomScramble(rng = Math.random) {
  const faces = 'URFDLB', opp = { U:'D', D:'U', R:'L', L:'R', F:'B', B:'F' }; const seq = []; let last = null, last2 = null;
  const n = 20 + Math.floor(rng() * 5);
  while (seq.length < n) { const f = faces[Math.floor(rng() * 6)]; if (f === last) continue; if (f === opp[last] && f === last2) continue;
    seq.push(f + ['', "'", '2'][Math.floor(rng() * 3)]); last2 = last; last = f; }
  return seq.join(' ');
}
module.exports = { SLOTS, E, MOVES, HOME, apply, SOLVED, run, inv, randomScramble, byName };

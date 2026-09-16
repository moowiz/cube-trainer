// @ts-nocheck - an analysis script; the typed surface is lib.ts
// Every optimal EO solution of every EO state, and what falls out of them:
// the numbers in docs/eo-patterns.md and the rules the trainer's EO
// strategy note quotes (web/src/eo/patterns.ts).
//   cd web && npx vite-node ../tools/eocross/eo-patterns.ts
import { EDGE_POS, EDGE_SLOTS, faceSlots } from '../../web/src/cube/pieces';
import { moveStr } from '../../web/src/cube/alg';
import { solveEO } from '../../web/src/eo/solver';
import * as M from './lib';

const step = (eo, m) => M.apply({ eo, slots: M.HOME }, M.MOVES[m]).eo;
const isFB = (m) => M.MOVES[m].flip;
const isHalf = (m) => M.MOVES[m].name.endsWith('2');
const bad = (eo) => { let n = 0; for (let x = eo; x; x &= x - 1) n++; return n; };
const onFace = (eo, f) => faceSlots(f).filter((s) => (eo >> s) & 1).length;
const maxFace = (eo) => Math.max(onFace(eo, 'F'), onFace(eo, 'B'));
const names = (eo) => EDGE_SLOTS.filter((_, i) => (eo >> i) & 1).join(' ');
const pct = (a, b) => `${(100 * a / b).toFixed(0)}%`;
const hist = (xs) => { const h = {}; for (const x of xs) h[x] = (h[x] || 0) + 1; return Object.keys(h).sort((a, b) => a - b).map((k) => `${k}: ${h[k]}`).join(', '); };

// every state with even parity, its distance and every optimal solution (as move ids)
const STATES = []; for (let eo = 0; eo < 4096; eo++) if (bad(eo) % 2 === 0) STATES.push(eo);
const SOL = new Map(STATES.map((eo) => { const s = solveEO(eo); return [eo, s.solutions.map((sol) => sol.map((m) => M.MOVES.findIndex((x) => x.name === moveStr(m))))]; }));
const DIST = (eo) => M.eoDist(eo);

// symmetries keeping the F/B axis: signed axis permutations fixing z up to sign, as slot permutations
const SYMS = [];
for (const perm of [[0, 1, 2], [1, 0, 2]]) for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
  const img = (v) => { const w = [v[perm[0]] * sx, v[perm[1]] * sy, v[perm[2]] * sz]; return w; };
  const key = (v) => v.join(',');
  const idx = Object.fromEntries(EDGE_POS.map((p, i) => [key(p), i]));
  SYMS.push(EDGE_POS.map((p) => idx[key(img(p))]));
}
const canon = (eo) => Math.min(...SYMS.map((p) => { let t = 0; for (let i = 0; i < 12; i++) if ((eo >> i) & 1) t |= 1 << p[i]; return t; }));
const PAT = new Map(); for (const eo of STATES) { const c = canon(eo); PAT.set(c, (PAT.get(c) || 0) + 1); }
console.log(`${STATES.length} states, ${PAT.size} patterns up to the ${SYMS.length} symmetries keeping the F/B axis, max distance ${Math.max(...STATES.map(DIST))}`);

console.log('\n== optimal length by bad-edge count (states / patterns)');
for (let k = 0; k <= 12; k += 2) {
  const ss = STATES.filter((s) => bad(s) === k), ps = [...PAT.keys()].filter((p) => bad(p) === k);
  console.log(`${String(k).padStart(2)} bad: mean ${(ss.reduce((a, s) => a + DIST(s), 0) / ss.length).toFixed(2)}  states {${hist(ss.map(DIST))}}  patterns {${hist(ps.map(DIST))}}`);
}

const OFF = ['UR', 'UL', 'DR', 'DL'].map((n) => EDGE_SLOTS.indexOf(n));
const ACROSS = [['UF', 'UB'], ['DF', 'DB'], ['FR', 'BR'], ['FL', 'BL']].map(([a, b]) => [EDGE_SLOTS.indexOf(a), EDGE_SLOTS.indexOf(b)]);
const byBucket = (title, f) => {
  console.log(`\n== mean optimal length by (bad count, ${title})`);
  for (let k = 2; k <= 12; k += 2) {
    const row = [];
    for (let m = 0; m <= 4; m++) { const ss = STATES.filter((s) => bad(s) === k && f(s) === m); if (ss.length) row.push(`${m}: ${(ss.reduce((a, s) => a + DIST(s), 0) / ss.length).toFixed(2)} (${ss.length})`); }
    console.log(`${String(k).padStart(2)} bad: ${row.join(' | ')}`);
  }
};
byBucket('bad edges in the side-middle slots UR UL DR DL', (s) => OFF.filter((i) => (s >> i) & 1).length);
byBucket('across pairs both bad (UF-UB DF-DB FR-BR FL-BL)', (s) => ACROSS.filter(([a, b]) => (s >> a) & 1 && (s >> b) & 1).length);

const profile = (eo, sol) => { const pr = [], setup = []; let k = 0, s = eo; for (const m of sol) { if (isFB(m)) { pr.push(onFace(s, M.MOVES[m].face)); setup.push(k); k = 0; } else k++; s = step(s, m); } return { pr, setup }; };
console.log('\n== F/B plans (bad on the face at each F/B quarter turn) available in some optimal solution, % of states');
for (let k = 2; k <= 12; k += 2) {
  const ss = STATES.filter((s) => bad(s) === k), c = {};
  for (const s of ss) for (const p of new Set(SOL.get(s).map((sol) => profile(s, sol).pr.join('>')))) c[p] = (c[p] || 0) + 1;
  console.log(`${String(k).padStart(2)} bad: ${Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p}: ${pct(n, ss.length)}`).join(', ')}`);
}

console.log('\n== over all optimal solutions');
const ALL = []; for (const s of STATES) if (s) for (const sol of SOL.get(s)) ALL.push([s, sol]);
console.log(`${ALL.length} solutions; first move is F/B in ${pct(ALL.filter(([, sol]) => isFB(sol[0])).length, ALL.length)}`);
const js = ALL.flatMap(([s, sol]) => profile(s, sol).pr); console.log(`bad on the face when it is turned: {${hist(js)}} of ${js.length}`);
const su = ALL.flatMap(([s, sol]) => profile(s, sol).setup); console.log(`setup moves before each F/B turn: {${hist(su)}}`);
const alt = { alternate: 0, repeat: 0, single: 0 };
for (const [, sol] of ALL) { const f = sol.filter(isFB).map((m) => M.MOVES[m].face); alt[f.length < 2 ? 'single' : f.every((x, i) => !i || x !== f[i - 1]) ? 'alternate' : 'repeat'] += 1; }
console.log(`F/B faces: ${Object.entries(alt).map(([k, n]) => `${k} ${pct(n, ALL.length)}`).join(', ')}`);
const change = {};
for (const [s, sol] of ALL) { let cur = s; sol.forEach((m, i) => { if (!isFB(m)) { const nxt = sol.slice(i + 1).find(isFB); if (nxt !== undefined) { const f = M.MOVES[nxt].face, k = `${onFace(cur, f)}>${onFace(step(cur, m), f)}`; change[k] = (change[k] || 0) + 1; } } cur = step(cur, m); }); }
const ct = Object.values(change).reduce((a, b) => a + b, 0);
console.log(`what a setup move does to the face turned next (bad before > after): ${Object.entries(change).sort().map(([k, n]) => `${k} ${pct(n, ct)}`).join(', ')}`);

console.log('\n== rules, over the states they apply to');
const firsts = (s) => new Set(SOL.get(s).map((sol) => sol[0]));
const rule = (name, applies, good) => { const ss = STATES.filter((s) => s && applies(s)); const ok = ss.filter((s) => [...firsts(s)].some((m) => isFB(m) && good(s, M.MOVES[m].face))); console.log(`${name}: ${ss.length} states, optimal in ${pct(ok.length, ss.length)}`); };
rule('a face with 4 bad -> turn it', (s) => maxFace(s) === 4, (s, f) => onFace(s, f) === 4);
rule('6 bad, a face with 3 -> turn it', (s) => bad(s) === 6 && maxFace(s) === 3, (s, f) => onFace(s, f) === 3);
rule('6 bad, a face with 1 -> turn it (to 8)', (s) => bad(s) === 6 && Math.min(onFace(s, 'F'), onFace(s, 'B')) === 1, (s, f) => onFace(s, f) === 1);
const need = (name, test) => { const every = STATES.filter((s) => s && SOL.get(s).every((sol) => test(s, sol))), some = STATES.filter((s) => s && SOL.get(s).some((sol) => test(s, sol))); console.log(`${name}: in some optimal solution ${pct(some.length, STATES.length - 1)}, in every one ${pct(every.length, STATES.length - 1)} (${every.length} states)`); };
need('a turn of a face with 2 bad', (s, sol) => profile(s, sol).pr.includes(2));
need('a turn of a face with 0 bad', (s, sol) => profile(s, sol).pr.includes(0));
need('an F2/B2', (s, sol) => sol.some((m) => isHalf(m) && 'FB'.includes(M.MOVES[m].face)));
need('a half turn', (s, sol) => sol.some(isHalf));

// a human policy: fixed F/B rules, setup moves chosen by an oracle (the true distance) or greedily
console.log('\n== policies: the F/B rules above with the setup moves chosen well or greedily');
const SIDE = M.MOVES.map((_, i) => i).filter((m) => !isFB(m));
const fbRule = (s) => { const k = bad(s); for (const f of ['F', 'B']) if (onFace(s, f) === 4) return f; for (const f of ['F', 'B']) if (k >= 6 && onFace(s, f) === 3) return f; if (k === 2) for (const f of ['F', 'B']) if (onFace(s, f) === 1) return f; return null; };
const turn = (f) => M.MOVES.findIndex((m) => m.name === f);
const gain = (s, m) => maxFace(step(s, m)) - maxFace(s);
let seed = 1; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const pick = { oracle: (s) => SIDE.reduce((a, m) => (DIST(step(s, m)) < DIST(step(s, a)) ? m : a)), greedy: (s) => { const b = Math.max(...SIDE.map((m) => gain(s, m))); const c = SIDE.filter((m) => gain(s, m) === b); return c[Math.floor(rng() * c.length)]; } };
for (const [name, p] of Object.entries(pick)) {
  let tot = 0, n = 0, stuck = 0, opt = 0; const reps = name === 'oracle' ? 1 : 4;
  for (const s0 of STATES) if (s0) for (let r = 0; r < reps; r++) {
    let s = s0, len = 0; while (s && len < 20) { const f = fbRule(s); s = step(s, f ? turn(f) : p(s)); len++; }
    n++; if (s) stuck++; else { tot += len; if (len === DIST(s0)) opt++; }
  }
  console.log(`F/B rules + ${name} setup: mean ${(tot / (n - stuck)).toFixed(2)} (optimal 4.51), optimal ${pct(opt, n)}, stuck ${pct(stuck, n)}`);
}

console.log('\n== the nine 2-bad patterns');
for (const p of [...PAT.keys()].filter((p) => bad(p) === 2).sort((a, b) => DIST(a) - DIST(b))) console.log(`  ${names(p).padEnd(6)} ${DIST(p)} moves, e.g. ${SOL.get(p)[0].map((m) => M.MOVES[m].name).join(' ')}`);
console.log('\n== the 4-bad patterns of 5 and 6 moves, and the 7-move patterns');
for (const p of [...PAT.keys()].filter((p) => (bad(p) === 4 && DIST(p) >= 5) || DIST(p) === 7).sort((a, b) => DIST(a) - DIST(b))) console.log(`  ${DIST(p)} moves, ${String(bad(p)).padStart(2)} bad: ${names(p).padEnd(35)} e.g. ${SOL.get(p)[0].map((m) => M.MOVES[m].name).join(' ')}`);

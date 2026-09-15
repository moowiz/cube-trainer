// @ts-nocheck - an analysis script; the typed surface is lib.ts
// What does optimal EOCross look like, and how close do human-executable strategies get?
//   cd web && npx vite-node ../tools/eocross/analyse.ts [scrambles=3000] [seed=1]
import * as M from './lib';
const W = M.W;
const N = +(process.argv[2] || 3000); let seed = +(process.argv[3] || 1);
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const r = M.buildTable();
const tot = r.hist.reduce((a, b) => a + b), mean = r.hist.reduce((a, b, i) => a + b * i, 0) / tot;
console.log(`EOCross table: ${tot} states, mean optimal ${mean.toFixed(2)}, by length: ${r.hist.map((n, i) => `${i}:${(100 * n / tot).toFixed(1)}%`).join(' ')}`);

// EO-only distances come from the app's solver
const EOD = { at: (eo) => M.eoDist(eo) };
const isFB = m => M.MOVES[m].flip;
// every EO solution of exactly `len` moves (len >= optimal), as move-index arrays
function eoSolutions(st, len) {
  const out = [];
  (function dfs(s, path, last) {
    if (path.length === len) { if (s === 0) out.push(path.slice()); return; }
    if (EOD.at(s) > len - path.length) return;
    for (let m = 0; m < 18; m++) { if (M.MOVES[m].face === last) continue;
      path.push(m); dfs(M.apply({ eo: s, slots: M.HOME }, M.MOVES[m]).eo, path, M.MOVES[m].face); path.pop(); }
  })(st.eo, [], null);
  return out;
}
const after = (st, sol) => sol.reduce((s, m) => M.apply(s, M.MOVES[m]), st);
const crossSolved = st => st.slots.filter((s, i) => s === M.HOME[i]).length;

const hist = (name, arr, fmt = x => x) => { const h = {}; for (const v of arr) h[v] = (h[v] || 0) + 1;
  console.log(`${name}: ` + Object.keys(h).sort((a, b) => a - b).map(k => `${fmt(k)}: ${(100 * h[k] / arr.length).toFixed(1)}%`).join('  ') + `  (mean ${(arr.reduce((a, b) => a + +b, 0) / arr.length).toFixed(2)})`); };

const S = { opt: [], eo: [], anyEO: [], bestEO: [], bestEO1: [], gapBest: [], gapBest1: [], tail: [], crossAtEO: [], lastFace: [], eoBroken: [], nOpt: [], nEOopt: [], eoSolsGood: [], firstFace: [], dMoves: [] };
for (let i = 0; i < N; i++) {
  const st = M.run(M.SOLVED(), M.randomScramble(rng));
  const sol = W.solve(st.eo, st.slots, 3000); const L = sol.length; S.opt.push(L); S.nOpt.push(sol.count);
  const e = EOD.at(st.eo); S.eo.push(e);
  // strategy: solve EO optimally (any solution) then finish optimally; or pick the best optimal-EO solution; or allow EO+1
  const eos = eoSolutions(st, e); S.nEOopt.push(eos.length);
  const totals = eos.map(s => e + W.dist(0, after(st, s).slots));
  S.anyEO.push(totals.reduce((a, b) => a + b, 0) / totals.length);
  const best = Math.min(...totals); S.bestEO.push(best); S.gapBest.push(best - L);
  S.eoSolsGood.push(totals.filter(t => t === L).length / totals.length);
  const eos1 = eoSolutions(st, e + 1); const best1 = Math.min(best, ...eos1.map(s => e + 1 + W.dist(0, after(st, s).slots)));
  S.bestEO1.push(best1); S.gapBest1.push(best1 - L);
  // shape of the optimal solutions
  for (const s of sol.solutions) {
    let lastFB = -1; for (let k = 0; k < s.length; k++) if (isFB(s[k])) lastFB = k;
    S.tail.push(s.length - 1 - lastFB);                       // moves after EO is finished
    S.crossAtEO.push(crossSolved(after(st, s.slice(0, lastFB + 1))));   // cross edges home when EO is finished
    S.lastFace.push(s.length ? M.MOVES[s[s.length - 1]].face : '-');
    S.firstFace.push(s.length ? M.MOVES[s[0]].face : '-');
    S.dMoves.push(s.filter(m => M.MOVES[m].face === 'D').length);
    let solvedBefore = false, cur = st; for (let k = 0; k < s.length; k++) { cur = M.apply(cur, M.MOVES[s[k]]); if (cur.eo === 0 && k < lastFB) solvedBefore = true; }
    S.eoBroken.push(solvedBefore ? 1 : 0);
  }
}
console.log(`\n${N} random scrambles`);
hist('optimal EOCross length', S.opt);
hist('optimal EO length', S.eo);
hist('optimal solutions per scramble', S.nOpt.map(n => n <= 5 ? n : n <= 20 ? '6-20' : n <= 100 ? '21-100' : '>100'));
console.log(`\n--- strategies (total EOCross length) ---`);
console.log(`optimal:                                   mean ${(S.opt.reduce((a, b) => a + b, 0) / N).toFixed(2)}`);
console.log(`any optimal EO, then optimal finish:       mean ${(S.anyEO.reduce((a, b) => a + b, 0) / N).toFixed(2)}`);
console.log(`best optimal-EO solution, then finish:     mean ${(S.bestEO.reduce((a, b) => a + b, 0) / N).toFixed(2)}`);
console.log(`best EO solution up to optimal+1, finish:  mean ${(S.bestEO1.reduce((a, b) => a + b, 0) / N).toFixed(2)}`);
hist('gap: best optimal-EO strategy minus optimal', S.gapBest);
hist('gap: best EO+1 strategy minus optimal', S.gapBest1);
hist('share of optimal-EO solutions that lead to an optimal EOCross', S.eoSolsGood.map(x => x === 0 ? 'none' : x < .25 ? '<25%' : x < .5 ? '<50%' : x < 1 ? '<100%' : 'all'));
console.log(`\n--- shape of optimal EOCross solutions (${S.tail.length} solutions) ---`);
hist('moves after the last F/B quarter turn (pure cross tail)', S.tail);
hist('cross edges already home when EO is finished', S.crossAtEO);
hist('EO was solved earlier and broken again', S.eoBroken);
hist('first move face', S.firstFace);
hist('last move face', S.lastFace);
hist('number of D moves in the solution', S.dMoves);

// ---- second pass: finer shape statistics on the same scrambles ----
seed = +(process.argv[3] || 1);
const S2 = { eoExtra: [], tail1: [], tailComp: [], homeBeforeLast: [], tail0eoExtra: [], dPos: [], lastFBinserts: [] };
for (let i = 0; i < N; i++) {
  const st = M.run(M.SOLVED(), M.randomScramble(rng)); const e = EOD.at(st.eo);
  const sol = W.solve(st.eo, st.slots, 3000);
  for (const s of sol.solutions) {
    let lastFB = -1; for (let k = 0; k < s.length; k++) if (isFB(s[k])) lastFB = k;
    const tail = s.slice(lastFB + 1), eoLen = lastFB + 1;
    S2.eoExtra.push(eoLen - e);                                 // EO part vs optimal EO
    if (tail.length === 1) S2.tail1.push(M.MOVES[tail[0]].face);
    if (tail.length >= 2) S2.tailComp.push(tail.map(m => M.MOVES[m].face.replace(/[RL]/, 'R/L')).join(' '));
    if (tail.length === 0) { S2.homeBeforeLast.push(crossSolved(after(st, s.slice(0, lastFB)))); S2.tail0eoExtra.push(eoLen - e); }
    if (lastFB >= 0) S2.lastFBinserts.push(crossSolved(after(st, s.slice(0, lastFB + 1))) - crossSolved(after(st, s.slice(0, lastFB))));
    s.forEach((m, k) => { if (M.MOVES[m].face === 'D') S2.dPos.push(k === s.length - 1 ? 'last' : k === 0 ? 'first' : 'middle'); });
  }
}
console.log(`\n--- finer shape ---`);
hist('EO part of an optimal EOCross (up to the last F/B turn) minus optimal EO', S2.eoExtra);
hist('tail of exactly 1 move: its face', S2.tail1);
hist('cross edges home right BEFORE the last F/B turn, tail-0 solutions', S2.homeBeforeLast);
hist('cross edges the last F/B turn puts home (all solutions)', S2.lastFBinserts);
hist('where D moves sit', S2.dPos);
{ const h = {}; for (const v of S2.tailComp) h[v] = (h[v] || 0) + 1;
  console.log('tails of 2+ moves, most common: ' + Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${(100 * n / S2.tailComp.length).toFixed(0)}%)`).join('  ')); }

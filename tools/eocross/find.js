// Find a random scramble matching a shape, for testing the trainer's per-scramble hints:
//   node tools/eocross/find.js <eo> <eocross> [tail]   e.g. 5 7 1 -> optimal EO 5, EOCross 7, every optimal solution has a 1-move tail
const M = require('./model.js'); require('../../web/public/eocross-worker.js'); const W = globalThis.EOCross; W.setPost(() => {});
W.build(M.MOVES.map(m => m.perm), M.MOVES.map(m => m.flip), M.HOME);
const EOD = new Int8Array(4096).fill(-1); EOD[0] = 0;
{ let q = [0]; while (q.length) { const nq = []; for (const s of q) for (const m of M.MOVES) { const n = M.apply({ eo: s, slots: M.HOME }, m).eo; if (EOD[n] < 0) { EOD[n] = EOD[s] + 1; nq.push(n); } } q = nq; } }
const [wantEO, wantX, wantTail] = process.argv.slice(2).map(Number);
for (let i = 0; i < 100000; i++) {
  const scr = M.randomScramble(); const st = M.run(M.SOLVED(), scr);
  if (EOD[st.eo] !== wantEO) continue;
  const sol = W.solve(st.eo, st.slots, 3000); if (sol.length !== wantX) continue;
  const tails = sol.solutions.map(s => { let k = -1; s.forEach((m, j) => { if (M.MOVES[m].flip) k = j; }); return s.length - 1 - k; });
  if (!isNaN(wantTail) && !tails.every(t => t === wantTail)) continue;
  console.log(scr); console.log(sol.solutions.map(s => s.map(m => M.MOVES[m].name).join(' ')).join('\n')); break;
}

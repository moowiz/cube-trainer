// @ts-nocheck - a helper script; the typed surface is lib.ts
// Find a random scramble matching a shape, for testing the trainer's per-scramble hints:
//   cd web && npx vite-node ../tools/eocross/find.ts <eo> <eocross> [tail]   e.g. 5 7 1 -> optimal EO 5, EOCross 7, every optimal solution has a 1-move tail
import * as M from './lib';
const W = M.W; M.buildTable();
const EOD = { at: (eo) => M.eoDist(eo) };
const [wantEO, wantX, wantTail] = process.argv.slice(2).map(Number);
for (let i = 0; i < 100000; i++) {
  const scr = M.randomScramble(); const st = M.run(M.SOLVED(), scr);
  if (EOD.at(st.eo) !== wantEO) continue;
  const sol = W.solve(st.eo, st.slots, 3000); if (sol.length !== wantX) continue;
  const tails = sol.solutions.map(s => { let k = -1; s.forEach((m, j) => { if (M.MOVES[m].flip) k = j; }); return s.length - 1 - k; });
  if (!isNaN(wantTail) && !tails.every(t => t === wantTail)) continue;
  console.log(scr); console.log(sol.solutions.map(s => s.map(m => M.MOVES[m].name).join(' ')).join('\n')); break;
}

// The ZZF2L sheet measured against search: for every case, the fewest turns in each move set (one technique each),
// beside the sheet's best alg and the tools it uses. Feeds docs/f2l-techniques.md.
//
//   npx vite-node scripts/f2l-derive.ts [slot] [--json out.json]     (slot: FR by default, or all)
//
// Move sets: own side and U (R U for a right-hand slot); R/L/U; R/L/U + D; R/L/U + F2 B2; R/L/U with every other
// slot free (the first pair of a solve). Opposite faces commute, so the search writes R before L, U before D.
import { writeFileSync } from 'node:fs';
import { moveCount, tokens } from '../src/cube/alg';
import { DATA, type F2LCase, type SlotName } from '../src/f2l/data';
import { byLength, explain, fullAlg, SLOTS } from '../src/f2l/model';
import { casePair, leftBroken, occupiedSlots, shortestAlgs } from '../src/f2l/search';

const q = (f: string) => [f, `${f}'`, `${f}2`];
const SETS: Record<string, string[]> = {
  own: [], // filled per slot
  rlu: [...q('U'), ...q('R'), ...q('L')],
  rlud: [...q('U'), ...q('R'), ...q('L'), ...q('D')],
  rluf2: [...q('U'), ...q('R'), ...q('L'), 'F2', 'B2'],
};

/** What an alg is built from: its faces beyond U, and the kind of turn. */
export function tools(slot: SlotName, a: string): string {
  const toks = tokens(fullAlg('', a)), side = slot[1]!, other = side === 'R' ? 'L' : 'R';
  const t: string[] = [];
  const has = (re: RegExp) => toks.some((x) => re.test(x));
  if (has(/^[rludfbMES]/)) t.push('wide/slice');
  if (has(/^[FB]'?$/)) t.push('F/B quarter');
  if (has(/^[FB]2$/)) t.push('F2/B2');
  if (has(/^D/)) t.push('D');
  const o = toks.map((x, i) => (x[0] === other ? i : -1)).filter((i) => i >= 0);
  if (o.length) {
    // the other side's turns in one block (U turns aside) before or after the own side's: a pop, then the insert
    const own = toks.map((x, i) => (x[0] === side ? i : -1)).filter((i) => i >= 0);
    const apart = !own.length || o.at(-1)! < own[0]! || o[0]! > own.at(-1)!;
    t.push(apart ? 'other side, apart' : 'both sides interleaved');
  }
  if (!t.length) t.push('own side + U');
  return t.join(', ');
}

const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'FR';
const slots = (which === 'all' ? SLOTS : [which]) as SlotName[];
const jsonAt = process.argv.indexOf('--json');
const rows: Record<string, unknown>[] = [];
for (const slot of slots) {
  SETS.own = [...q('U'), ...q(slot[1]!)];
  for (const c of Object.values(DATA.slots[slot].cases) as F2LCase[]) {
    const pair = casePair(slot, c);
    const keep = SLOTS.filter((s) => s !== slot && !occupiedSlots(slot, c).includes(s));
    const opt: Record<string, { n: number; algs: string[] }> = {};
    for (const [k, moves] of Object.entries(SETS)) {
      const algs = shortestAlgs(pair, keep, { moves, limit: 4, maxDepth: k === 'own' ? 18 : 13 });
      opt[k] = { n: algs[0] ? tokens(algs[0]).length : NaN, algs };
    }
    const free = shortestAlgs(pair, [], { limit: 4 });
    opt.free = { n: free[0] ? tokens(free[0]).length : NaN, algs: free };
    const best = byLength(c.algs)[0]!;
    rows.push({
      slot, n: c.n, section: c.section, head: explain(slot, c, best).head,
      sheet: best, sheetN: moveCount(fullAlg('', best)), sheetTools: tools(slot, best),
      algs: c.algs.map((a) => ({ a, n: moveCount(fullAlg('', a)), tools: tools(slot, a), head: explain(slot, c, a).head })),
      others: c.others.map((o) => ({ a: o.alg, n: moveCount(fullAlg('', o.alg)), free: o.free, breaks: leftBroken(slot, c, o.alg).slots })),
      opt,
    });
  }
}
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(rows, null, 1));
else for (const r of rows as any[]) {
  const o = r.opt;
  console.log(`${r.slot} ${r.n} [${r.section}] ${r.head} sheet ${r.sheetN} (${r.sheetTools}) | own ${o.own.n} rlu ${o.rlu.n} +D ${o.rlud.n} +F2 ${o.rluf2.n} free ${o.free.n} | ${r.sheet} | ${o.rlu.algs[0]}`);
}

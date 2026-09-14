// Headless check of the trainer's EOCross goal: serves web/ over loopback, switches the goal, waits for the
// worker's table, and verifies every listed optimal solution through the trainer's own Check button. Also
// compares the optimal length with the independent node model in tools/eocross/model.js.
//   node tools/eocross/check.mjs [scrambles=5]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const M = require('./model.js'); require(join(root, 'web', 'public', 'eocross-worker.js')); const W = globalThis.EOCross;
W.setPost(() => {}); W.build(M.MOVES.map(m => m.perm), M.MOVES.map(m => m.flip), M.HOME);
const { default: puppeteer } = await import(pathToFileURL(join(root, 'model', 'gen', 'node_modules', 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js')).href);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  const file = url === '/' ? join(root, 'web', 'index.html') : join(root, 'web', 'public', url.replaceAll('..', ''));
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.evaluate(() => ZZ.showTab('eo'));
await page.evaluate(() => document.querySelector('#eo-panel .eo-seg[data-set="goal"] button[data-v="cross"]').click()); // inside a closed <details>
const t0 = Date.now();
await page.waitForFunction(() => { document.getElementById('eo-showSol').click(); const s = document.getElementById('eo-rSub').textContent; document.getElementById('eo-showSol').click(); return /optimal solution/.test(s) && /EOCross/.test(document.getElementById('eo-rTitle').textContent); }, { timeout: 60000, polling: 500 });
console.log(`table ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

let seed = 11; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
let fails = 0;
for (let i = 0; i < +(process.argv[2] || 5); i++) {
  const scr = M.randomScramble(rng); const st = M.run(M.SOLVED(), scr); const ref = W.solve(st.eo, st.slots, 1);
  await page.evaluate(s => ZZ.eo.load(s), scr);
  await page.click('#eo-showSol');
  await page.waitForFunction(() => /optimal solution/.test(document.getElementById('eo-rSub').textContent), { timeout: 20000 });
  const out = await page.evaluate(() => ({ title: document.getElementById('eo-rTitle').textContent, sub: document.getElementById('eo-rSub').textContent,
    groups: [...document.querySelectorAll('#eo-sols .grp')].map(g => ({ head: g.querySelector('.grp-h')?.textContent, n: g.querySelectorAll('div[data-alg]').length, first: g.querySelector('div[data-alg]')?.textContent })),
    algs: [...document.querySelectorAll('#eo-sols div[data-alg]')].map(d => d.dataset.alg) }));
  await page.click('#eo-showSol');
  const len = +/(\d+) moves/.exec(out.title)[1];
  console.log(`\n${scr}\n  ${out.title} | ${out.sub}\n  node model says ${ref.length} moves, ${ref.count} solutions`);
  for (const g of out.groups) console.log(`  ${g.head}: ${g.n} lines, e.g. ${g.first}`);
  if (len !== ref.length || +/^(\d+) optimal/.exec(out.sub)[1] !== ref.count) { fails++; console.log('  MISMATCH with node model'); }
  // every listed alg must pass the trainer's own Check as an EOCross of optimal length
  for (const alg of out.algs) {
    await page.evaluate(a => { document.getElementById('eo-sol').value = a; }, alg); await page.click('#eo-check');
    const title = await page.evaluate(() => document.getElementById('eo-rTitle').textContent);
    if (title !== `EOCross done in ${len} moves`) { fails++; console.log(`  FAIL ${alg}: ${title}`); }
  }
  // the yours tag: type the last listed alg with a trailing U move and expect it pinned
  const alg = out.algs[out.algs.length - 1];
  await page.evaluate(a => { document.getElementById('eo-sol').value = a + ' U'; }, alg); await page.click('#eo-showSol');
  const yours = await page.evaluate(() => [...document.querySelectorAll('#eo-sols div[data-alg]')].filter(d => d.querySelector('.yours')).map(d => d.dataset.alg));
  await page.click('#eo-showSol');
  if (yours.length !== 1 || yours[0] !== alg) { fails++; console.log(`  FAIL yours: typed ${alg}, tagged ${JSON.stringify(yours)}`); } else console.log(`  yours tag ok (${alg})`);
  const hints = await page.evaluate(() => { const o = {}; for (const b of document.querySelectorAll('#eo-hints .eo-chip')) { b.click(); o[b.dataset.hint] = b.textContent; } return o; });
  console.log(`  hints: ${JSON.stringify(hints)}`);
}
console.log(fails ? `\n${fails} FAILURES` : '\nall ok');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);

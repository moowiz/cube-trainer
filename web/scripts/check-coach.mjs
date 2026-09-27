// Headless check of the coach (src/analysis/): serves web/dist, seeds timed
// solves with their turns straight into the page's IndexedDB (the committed
// smart-cube fixture's two solves, repeated with the times stretched so they
// differ), reloads, and asserts on the report under the last solve on the
// Solve tab and on the Coach place (the advice, the phase table, the case
// table and its switches). Phone and desktop screenshots go to
// $TMPDIR/coach-*.png.
//
//   npm run check:coach                     (run `npm run build` first)
//   npm run check:coach -- --solves a.jsonl  (seed these solves instead: one SolveRecord-like JSON per line)
import { readFileSync } from 'node:fs';
import { launchBrowser, serveDist, webDir } from './headless.mjs';

const at = process.argv.indexOf('--solves');
const file = at > 0 ? process.argv[at + 1] : `${webDir}/test/fixtures/smart/icarrye-first.solves.jsonl`;
const base = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// at least a dozen solves: the fixture's again, each turn's time stretched a little differently
const seed = [];
for (let k = 0; seed.length < Math.max(12, base.length); k++) {
  for (const s of base) {
    const f = at > 0 ? 1 : 0.85 + ((k * 7 + seed.length * 3) % 10) / 20;
    seed.push({ ...s, moves: s.moves.map((m) => ({ m: m.m, t: Math.round(m.t * f) })), time: Math.round(s.time * f) });
  }
  if (at > 0) break;
}

const server = await serveDist();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const tmp = process.env.TMPDIR ?? '/tmp';
const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); failed++; });
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(async (solves) => {
  const db = await new Promise((ok, fail) => { const o = indexedDB.open('cube-coach'); o.onsuccess = () => ok(o.result); o.onerror = () => fail(o.error); });
  const t = db.transaction(['solves', 'sessions'], 'readwrite');
  const now = Date.now(), n = solves.length;
  t.objectStore('sessions').put({ id: 'coach-sess', puzzle: '333', name: 'coach check', createdAt: now - n * 60e3 - 1, editedAt: now });
  solves.forEach((s, i) => {
    const when = now - (n - i) * 60e3;
    t.objectStore('solves').put({ id: `coach${String(i).padStart(3, '0')}`, puzzle: '333', session: 'coach-sess', when, scramble: s.scramble, time: s.time, penalty: 0, moves: s.moves, source: 'cube', editedAt: when });
  });
  await new Promise((ok) => { t.oncomplete = ok; });
}, seed);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
// the Solve tab: pick the seeded session, and the report shows under the last solve
await page.evaluate(() => { const sel = document.getElementById('tm-session'); sel.value = 'coach-sess'; sel.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 1500));
const report = await page.$eval('#tm-report', (e) => ({ hidden: e.hidden, rows: [...e.querySelectorAll('tr')].map((tr) => tr.textContent.trim()), next: e.querySelector('.nx b')?.textContent ?? null, note: e.querySelector('.nt')?.textContent ?? null }));
console.log('report rows:', report.rows.join(' | '));
console.log('report note:', report.note);
console.log('report next:', report.next);
check(!report.hidden && report.rows.length >= 7, 'the report under the last solve: a row per phase');
check(report.rows.some((r) => r.startsWith('Pair 1')) && report.rows.some((r) => r.startsWith('PLL')), 'the pairs and the last layer are there');
check(!!report.next, 'it names the next thing to work on');
await page.evaluate(() => document.getElementById('tm-report').scrollIntoView());
await page.screenshot({ path: `${tmp}/coach-phone-report.png` });

// the Coach place, from the report's Why
await page.click('#tm-report [data-coach-open]');
await new Promise((r) => setTimeout(r, 1500));
const coach = await page.evaluate(() => {
  const s = document.getElementById('coach-sheet');
  return { open: !s.hidden, title: s.querySelector('.co-next .t')?.textContent ?? null, why: s.querySelectorAll('.co-next li').length, then: s.querySelectorAll('.co-more').length, phases: s.querySelectorAll('.co table')[0]?.querySelectorAll('tr').length ?? 0, cases: s.querySelectorAll('.co-case').length, nav: document.querySelector('#bnav [data-dest="coach"]')?.classList.contains('on') };
});
console.log('coach:', JSON.stringify(coach));
check(coach.open && !!coach.title && coach.why > 0, 'the Coach opens with the next thing to work on and why');
check(coach.phases === 7, 'the phase table: five phases, the heading and the solve');
check(coach.cases > 0, 'the F2L cases met');
check(coach.nav === true, 'the bottom nav lights Coach');
await page.screenshot({ path: `${tmp}/coach-phone-top.png` });
// the case table's switches
await page.evaluate(() => [...document.querySelectorAll('#coach-sheet [data-k="kind"] [data-v="pll"]')][0].click());
await new Promise((r) => setTimeout(r, 800));
const pll = await page.$$eval('#coach-sheet .co-case .h b', (bs) => bs.map((b) => b.textContent));
console.log('PLL rows:', pll.join(', '));
check(pll.length > 0 && pll.every((t) => t.startsWith('PLL')), 'the PLL switch lists PLL cases');
await page.evaluate(() => document.querySelector('#coach-sheet .co-cases')?.scrollIntoView());
await page.screenshot({ path: `${tmp}/coach-phone-cases.png` });
// the advice's button: F2L cases into the practice pool, or the mode
const btn = await page.$('#coach-sheet .co-next [data-act]');
if (btn) {
  const label = await page.evaluate((b) => b.textContent, btn);
  await btn.click();
  await new Promise((r) => setTimeout(r, 800));
  const after = await page.evaluate(() => ({ closed: document.getElementById('coach-sheet').hidden, mode: window.ZZ.modes.current() }));
  console.log(`"${label}" ->`, JSON.stringify(after));
  check(after.closed, `"${label}" closes the Coach and goes to practice`);
}
// desktop
await page.setViewport({ width: 1280, height: 900 });
await page.evaluate(() => window.ZZ.modes.openCoach());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${tmp}/coach-desktop.png` });

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

// Headless check of Progress → Drills: the drill attempts the store holds, newest first, filtered by drill; a delete
// is a tombstone in the store (so a synced phone drops it too) and an undo brings it back.
//
//   npm run check:drillhist        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
let failed = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed++; });
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
const now = Date.now();
const att = (id, stage, ago, extra = {}) => ({ id, puzzle: '333', stage, when: now - ago, scramble: '', moves: "R U R' U'", time: 4321, assisted: false, source: 'cube', editedAt: now, ...extra });
await page.evaluate(async (xs) => { for (const x of xs) await window.ZZ.store.putAttempt(x); }, [
  att('a1', 'eo', 3_600_000, { moves: 'F R R U', optimal: 3, eoSplit: 1500, recognition: 2100 }),
  att('a2', 'pll', 60_000, { caseId: 'T' }),
  att('a3', 'f2l', 120_000, { caseId: 'FL-5' }),
]);
await page.evaluate(() => window.ZZ.modes.openProgress('drills')); await wait(800);
const rows = () => page.$$eval('#dh-list li', (es) => es.map((e) => [...e.children].map((c) => c.textContent.trim()).join(' | ')));
let r = await rows();
console.log('   ', r.join('\n     '));
check(r.length === 3 && /PLL T/.test(r[0]) && /F2L case \d+/.test(r[1]) && /\| EO \| 4\.32 \| 3 moves \(optimal 3\) · EO 1\.5 \+ cross 2\.8 · inspection 2\.1/.test(r[2]), 'newest first, with the case, the time, the moves against the optimum, the EO split');
check((await page.$eval('#dh-n', (e) => e.textContent)) === '3 attempts', 'the count');
await page.click('#dh-filter [data-v="pll"]'); await wait(300);
check((await rows()).length === 1, 'filtered to PLL');
await page.click('#dh-filter [data-v="all"]'); await wait(300);
await page.click('#dh-list button[data-del="a2"]'); await wait(400);
const del = await page.evaluate(async () => (await window.ZZ.store.attempts()).find((a) => a.id === 'a2'));
check(del?.deleted === true, 'Delete: a tombstone in the store');
check((await page.$eval('#dh-list li[data-id="a2"]', (e) => e.className)) === 'gone' && (await page.$eval('#dh-n', (e) => e.textContent)) === '2 attempts', 'struck through, with an undo; the count drops');
await page.click('#dh-list button[data-del="a2"]'); await wait(400);
const back = await page.evaluate(async () => (await window.ZZ.store.attempts()).find((a) => a.id === 'a2'));
check(back?.deleted === false && (await page.$eval('#dh-n', (e) => e.textContent)) === '3 attempts', 'Undo brings it back');
await b.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

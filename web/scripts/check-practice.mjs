// Headless check of the PLL drill's "Practice so far" section: serves
// web/dist, seeds attempts straight into the page's IndexedDB (eight cases
// over twelve days: T getting faster, Y slower, Ga and Gb barely tried),
// opens the section and asserts on the table's default order, the sort
// by heading (and its flip, and that it survives a reload), the trend
// column, and the graph (a line per case with three or more timed tries,
// the legend toggling them, a tap on a name in the table showing that
// case alone), and the tick under the cube picture that hides it. Phone and
// desktop screenshots go to $TMPDIR/practice-*.png.
//
//   npm run check:practice        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const server = await serveDist();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/?tab=pll`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
// seed: eight cases over twelve days, T getting faster, Y slower, Ga/Gb few
await page.evaluate(async () => {
  const db = await new Promise((ok, fail) => { const o = indexedDB.open('cube-coach'); o.onsuccess = () => ok(o.result); o.onerror = () => fail(o.error); });
  const t = db.transaction('attempts', 'readwrite'), st = t.objectStore('attempts');
  const day = 864e5, now = Date.now();
  let k = 0, seed = 7;
  // a fixed sequence, so the assertions on the order never depend on the noise
  Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const put = (caseId, when, time, extra = {}) => st.put({ id: `seed${k++}`, puzzle: '333', stage: 'pll', when, scramble: '', moves: '', time, assisted: false, source: 'cube', editedAt: when, caseId, recognition: 600 + Math.random() * 400, execution: time - 800, ...extra });
  for (let i = 0; i < 24; i++) put('T', now - (12 - i / 2) * day, 2600 - i * 40 + Math.random() * 300, { quiz: 'right' });
  for (let i = 0; i < 16; i++) put('Y', now - (10 - i / 2) * day, 3200 + i * 60 + Math.random() * 400, { quiz: i % 4 ? 'right' : 'wrong' });
  for (let i = 0; i < 10; i++) put('Ja', now - (6 - i / 2) * day, 2100 + Math.random() * 500);
  for (let i = 0; i < 10; i++) put('Jb', now - (6 - i / 2) * day, 2300 + Math.random() * 500, { start: 'repeat' });
  for (let i = 0; i < 2; i++) put('Ga', now - day, 4000 + Math.random() * 500);
  put('Gb', now - 2 * day, null);
  for (let i = 0; i < 9; i++) put('H', now - (4 - i / 3) * day, 1500 + Math.random() * 300, { quiz: 'right' });
  await new Promise((ok) => { t.oncomplete = ok; });
});
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => { document.getElementById('pll-practice').open = true; document.getElementById('pll-practice').scrollIntoView(); });
await new Promise((r) => setTimeout(r, 800));
const rows = async () => page.$$eval('#pll-practiceBody tbody tr td.name', (tds) => tds.map((t) => t.textContent.trim()));
const heads = await page.$$eval('#pll-practiceBody thead th button', (bs) => bs.map((b) => b.textContent.trim()));
console.log('headings', heads.join(' | '));
let r = await rows();
console.log('worst first:', r.slice(0, 6).join(', '));
check(r.indexOf('Ga') < r.indexOf('Y') && r.indexOf('Y') < r.indexOf('T'), 'the least practised first, then the slow and misnamed Y, then T');
check(await page.$('#pll-practiceGraph svg.pg-svg') !== null, 'the graph is drawn');
const lineIds = () => page.$$eval('#pll-practiceGraph .pg-case', (gs) => gs.map((g) => g.dataset.id).sort());
check((await lineIds()).join(',') === 'H,Ja,Jb,T,Y', `a line per case with three timed tries: ${(await lineIds()).join(',')}`);
check((await page.$$eval('#pll-practiceGraph .pg-legend .btn.none', (b) => b.map((x) => x.textContent.trim())).then((x) => x.join(','))) === 'Ga', 'Ga (two timed tries) listed greyed, no line yet; the untimed Gb and the untried not listed');
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/practice-phone-default.png', fullPage: false });
// sort by recent, slowest first
await page.click('#pll-practiceBody th button[data-sort="recent"]');
await new Promise((r) => setTimeout(r, 400));
r = await rows();
console.log('by recent desc:', r.slice(0, 4).join(', '));
check(r[0] === 'Ga' && r.indexOf('Gb') > r.indexOf('H'), 'recent descending: Ga slowest first, the untimed Gb after every timed case');
await page.click('#pll-practiceBody th button[data-sort="recent"]');
await new Promise((r) => setTimeout(r, 400));
r = await rows();
check(r[0] === 'H', 'a second tap flips it: H fastest first');
// trend column
await page.click('#pll-practiceBody th button[data-sort="trend"]');
await new Promise((r) => setTimeout(r, 400));
const trend = await page.$$eval('#pll-practiceBody tbody tr', (trs) => trs.map((tr) => [tr.querySelector('td.name').textContent.trim(), [...tr.querySelectorAll('td')].find((td) => td.classList.contains('faster') || td.classList.contains('slower'))?.textContent]));
console.log('trend:', JSON.stringify(trend.slice(0, 3)));
check(trend[0][0] === 'Y' && trend[0][1]?.startsWith('+'), 'Y, getting slower, tops the trend');
// a legend chip hides its line; "all" brings it back; tapping a name in the table shows that case alone
await page.click('#pll-practiceGraph .pg-legend button[data-id="Y"]');
await new Promise((r) => setTimeout(r, 300));
check((await lineIds()).join(',') === 'H,Ja,Jb,T', 'Y switched off in the legend');
await page.click('#pll-practiceGraph .pg-legend button[data-all="on"]');
await new Promise((r) => setTimeout(r, 300));
check((await lineIds()).join(',') === 'H,Ja,Jb,T,Y', 'all back on');
await page.evaluate(() => document.getElementById('pll-practiceGraphWrap').scrollIntoView());
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/practice-phone-graph.png' });
await page.click('#pll-practiceBody td.name button[data-graph="T"]');
await new Promise((r) => setTimeout(r, 500));
check((await lineIds()).join(',') === 'T', 'tapping T shows T alone');
check((await page.$$eval('#pll-practiceGraph .pg-case[data-id="T"] .pg-dot', (d) => d.length)) === 22, '22 points: 24 tries, a value from the third');
await page.evaluate(() => document.getElementById('pll-practice').scrollIntoView());
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/practice-phone-T.png' });
// the sort survives a reload
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => { document.getElementById('pll-practice').open = true; });
await new Promise((r) => setTimeout(r, 600));
check((await page.$eval('#pll-practiceBody th button.on', (b) => b.dataset.sort)) === 'trend', 'the sort is remembered');
// the tick under the picture hides it, and stays off over a reload
const picShown = () => page.evaluate(() => !document.getElementById('pll-pic').parentElement.hidden || !document.getElementById('pll-stage').hidden);
check(await picShown(), 'the picture is on by default');
await page.click('#pll-showpic');
await new Promise((r) => setTimeout(r, 200));
check(!(await picShown()), 'unticked: no diagram, no 3D cube');
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
check(!(await picShown()) && !(await page.$eval('#pll-showpic', (b) => b.checked)), 'still hidden after a reload');
await page.click('#pll-showpic');
await new Promise((r) => setTimeout(r, 200));
check(await picShown(), 'ticked again: the picture is back');
await page.evaluate(() => { document.getElementById('pll-practice').open = true; });
await new Promise((r) => setTimeout(r, 600));
await page.setViewport({ width: 1280, height: 900 });
await page.click('#pll-practiceGraph .pg-legend button[data-all="on"]');
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => document.getElementById('pll-practiceGraphWrap').scrollIntoView());
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/practice-desktop.png' });
await browser.close(); server.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);

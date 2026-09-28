// Headless check of the mode picker's EOCross row (user, 2026-09-27): EO and Cross are cells of their own, and
// picking one is where the EO page's attempt ends (EO alone, or EO then the cross); the chip and the strip follow.
//
//   npm run check:picker        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
let failed = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed++; });
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('eo')); await wait(300);
const openPicker = () => page.evaluate(() => document.querySelector('.mode-chip').click());
const state = () => page.evaluate(() => ({
  chip: document.querySelector('.mode-chip b')?.textContent,
  sub: document.getElementById('eo-sub')?.textContent,
  cells: [...document.querySelectorAll('.mp-cell[data-row="eo"], .mp-cell.same')].map((e) => `${e.textContent}${e.classList.contains('end') ? '*' : e.classList.contains('in') ? '+' : ''}`).join(' '),
  strip: [...document.querySelectorAll('#rail-strip .rl-seg')].map((e) => `${e.querySelector('b').textContent}${e.classList.contains('out') ? '-' : ''}`).join(' '),
}));
await openPicker(); await wait(200);
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/picker.png` });
let s = await state();
console.log('   ', JSON.stringify(s));
check(/^EO\S* Cross\S* F2L\S* OCLL\S* = Solve$/.test(s.cells), `the EOCross row has EO and Cross cells (${s.cells})`);
await page.click('.mp-cell[data-row="eo"][data-stop="cross"]'); await wait(300);
s = await state();
console.log('   ', JSON.stringify(s));
check(s.chip === 'EOCross' && /then build the white cross/.test(s.sub ?? ''), `Cross: the EO page runs on to the cross (${s.chip}: ${s.sub})`);
check(/^EO Cross F2L- OCLL- PLL-$/.test(s.strip), `the strip: EO and Cross (${s.strip})`);
await openPicker(); await wait(200);
await page.click('.mp-cell[data-row="eo"][data-stop="eo"]'); await wait(300);
s = await state();
console.log('   ', JSON.stringify(s));
check(s.chip === 'EO' && !/cross/.test(s.sub ?? '') && /^EO Cross- /.test(s.strip), `EO: EO alone, the cross greyed (${s.chip}, ${s.strip})`);
await openPicker(); await wait(200);
s = await state();
check(/^EO\* Cross F2L OCLL/.test(s.cells), `the picker marks EO as the stop (${s.cells})`);
await page.click('.mp-cell[data-row="eo"][data-stop="cross"]'); await wait(300);
s = await state();
check(s.chip === 'EOCross', `back to Cross from EO alone (${s.chip})`);
check(!(await page.$('#eo-settings [data-set="goal"]')) && !!(await page.$('#eo-settings [data-set="combined"] button.on[data-v="off"]')), 'no "Timed until"; combined solutions off by default');
await b.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

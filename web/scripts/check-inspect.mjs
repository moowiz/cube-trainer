// Headless check of the Solve tab's inspection clock: serves web/dist, puts a
// scramble on a replayed smart cube, and asserts that the rail's clock counts
// the inspection up while the cube waits at the scramble, that the rail's ⏱
// switch turns it into a plain "ready" (and back), and that the solve records
// and shows its inspection. Screenshot: $TMPDIR/inspect-phone.png.
//
//   npm run check:inspect        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';

const server = await serveDist();
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : m + "'")).join(' ');
/** A capture: the cube from solved through `alg` (its own letters), 180 ms a turn, then `gapMs` still, then `after`. */
function capture(alg, gapMs = 0, after = '') {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'check-inspect' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  const split = (a) => a.split(/\s+/).filter(Boolean).flatMap((x) => (x.endsWith('2') ? [x[0], x[0]] : [x]));
  const turn = (m) => lines.push(JSON.stringify({ kind: 'move', t: (t += 180), move: m, tRaw: Math.round(t * 1.01), tLocal: t }));
  split(alg).forEach(turn);
  t += gapMs;
  split(after).forEach(turn);
  return lines.join('\n') + '\n';
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); failed++; });
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('solve'));
// the Solve tab's own first scramble arrives after the page loads: wait for it, or it replaces ours
await page.waitForFunction(() => !!window.ZZ.solve.scramble(), { timeout: 20000 });
const SCR = "R U F' L2 B D2 R'"; // trainer letters
await page.evaluate((s) => window.ZZ.solve.load(s), SCR);
const cubeScr = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), SCR);
// one connection, in real time: the scramble, 4 s of inspection, the undo
await page.evaluate((text) => { void window.ZZ.smart.replay(text, 1); }, capture(cubeScr, 4000, inverse(cubeScr)));
await new Promise((r) => setTimeout(r, 2000));
const t1 = await page.$eval('#rail-time', (e) => e.textContent);
await new Promise((r) => setTimeout(r, 1000));
const t2 = await page.$eval('#rail-time', (e) => e.textContent);
console.log('rail clock while inspecting:', t1, '->', t2, '|', await page.$eval('#rail-hint', (e) => e.textContent));
check(/^\d+\.\d$/.test(t1) && Number(t2) > Number(t1), 'the inspection counts up on the rail');
check((await page.$eval('#rail-insp', (e) => e.textContent)).includes('on'), 'the rail switch says it is on');
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/inspect-phone.png` });
await page.click('#rail-insp');
await new Promise((r) => setTimeout(r, 300));
check((await page.$eval('#rail-time', (e) => e.textContent)) === 'ready', 'switched off: just "ready"');
await page.click('#rail-insp');
await new Promise((r) => setTimeout(r, 300));
check(/^\d+\.\d$/.test(await page.$eval('#rail-time', (e) => e.textContent)), 'back on: counting again');
// the undo comes after the pause: the time and the inspection are recorded and shown
await page.waitForFunction(() => document.querySelectorAll('#tm-list li').length >= 1, { timeout: 15_000 }).catch(() => undefined);
await new Promise((r) => setTimeout(r, 500));
console.log('after solve:', JSON.stringify(await page.evaluate(() => ({ state: document.getElementById('tm-state').textContent, rail: document.getElementById('rail-time').textContent, active: window.ZZ.activeTab(), scr: window.ZZ.solve.scramble() }))));
const last = await page.$eval('#tm-lastText', (e) => e.textContent);
const rec = await page.evaluate(async () => (await window.ZZ.store.solves()).sort((a, b) => b.when - a.when)[0]);
console.log('last:', last, '| inspection recorded:', rec?.inspection);
check(typeof rec?.inspection === 'number', 'the solve records its inspection');
check(/inspection \d/.test(last), 'and shows it under the time');

await browser.close();
server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

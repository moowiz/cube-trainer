// Headless checks of the LL drill on a replayed smart cube (docs/ll-drill-next-steps.md 1):
// the alg on show surviving an undo of the first move back to the scramble (user, 2026-09-24:
// the scaffold's empty box cleared the panel), and the cycle order's counter. Each replay() is
// a fresh connection, so the captures are cumulative.
//
//   npm run check:ll        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const server = await serveDist(); const browser = await launchBrowser(); const page = await browser.newPage();
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : m + "'")).join(' ');
function capture(moves) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'check-undo' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  for (const m of moves.split(/\s+/).filter(Boolean).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m]))) lines.push(JSON.stringify({ kind: 'move', t: (t += 180), move: m, tRaw: Math.round(t * 1.01), tLocal: t }));
  return lines.join('\n') + '\n';
}
let failed = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
await page.goto(`${server.origin}/?tab=pll`, { waitUntil: 'networkidle0' });
await page.evaluate(() => { const b = document.getElementById('pll-auto'); if (!b.checked) b.click(); });
const T = "R U R' U' R' F R2 U' R' U' R U R' F'"; // the T perm, trainer letters
const setup = inverse(T);
await page.evaluate((s) => window.ZZ.pll.load(s), setup);
await new Promise((r) => setTimeout(r, 300));
const scr = await page.evaluate(() => window.ZZ.pll.scramble());
const cubeScr = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), scr);
const firstCube = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), 'R');
const shown = () => page.evaluate(() => document.getElementById('pll-result').classList.contains('show'));
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(cubeScr));
await new Promise((r) => setTimeout(r, 200));
check(!(await shown()), 'at the scramble the alg is still held');
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(`${cubeScr} ${firstCube}`));
await new Promise((r) => setTimeout(r, 200));
check(await shown(), 'the first turn shows the alg');
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(`${cubeScr} ${firstCube} ${inverse(firstCube)}`));
await new Promise((r) => setTimeout(r, 200));
check(await shown(), 'undone back to the scramble: the alg stays on show');
// the cycle order: five cases picked, five New cases see each once with a counter, the sixth starts over
await page.evaluate(() => { document.getElementById('pll-cases').open = true; });
await page.click('#pll-caselist [data-cases="none"]');
for (const id of ['Ja', 'Jb', 'T', 'Y', 'H']) await page.click(`#pll-caselist [data-case="${id}"]`);
await page.select('#pll-order', 'cycle');
const seen = [];
for (let i = 1; i <= 6; i++) {
  await page.click('#pll-next'); await new Promise((r) => setTimeout(r, 400));
  seen.push(await page.evaluate(() => window.ZZ.pll.scramble()));
  const counter = await page.$eval('#pll-cycle', (e) => e.textContent);
  check(counter === `${i === 6 ? 1 : i} / 5`, `counter after New case ${i}: ${counter}`);
}
check(new Set(seen.slice(0, 5)).size === 5, 'five different scrambles in the cycle');
await page.select('#pll-order', 'random');
check((await page.$eval('#pll-cycle', (e) => e.textContent)) === '', 'at random: no counter');
await page.select('#pll-order', 'cycle'); await page.click('#pll-next'); await new Promise((r) => setTimeout(r, 400));
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/ll-cycle.png' });
await browser.close(); server.close();
console.log(failed ? `${failed} FAILED` : 'all ok'); process.exit(failed ? 1 : 0);

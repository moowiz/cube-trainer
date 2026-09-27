// Headless check that a timed Solve with the coach ends on the Solve tab (user, 2026-09-26: "when I finish it goes
// back to the F2L tab"): F2L's own "new practice scramble when solved" on, a recorded solve replayed on a cube from
// the Solve's scramble (and, with `mine`, from a hand scramble taken with Use my cube); the tabs must go through the
// stages and end on Solve, with the solve stored.
//
//   npm run check:end [-- <solves.jsonl> <line> [mine]]   (run `npm run build` first; the smart fixture by default)
import { readFileSync } from 'node:fs';
import { launchBrowser, serveDist, webDir } from './headless.mjs';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
function capture(scr, gap, sol) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'x' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  const split = (a) => a.split(/\s+/).filter(Boolean).flatMap((x) => (x.endsWith('2') ? [x[0], x[0]] : [x]));
  for (const m of split(scr)) lines.push(JSON.stringify({ kind: 'move', t: (t += 60), move: m, tRaw: t, tLocal: t }));
  t += gap;
  for (const m of sol) lines.push(JSON.stringify({ kind: 'move', t: (t += 120), move: m, tRaw: t, tLocal: t }));
  return lines.join('\n') + '\n';
}
const rec = JSON.parse(readFileSync(process.argv[2] ?? `${webDir}/test/fixtures/smart/icarrye-first.solves.jsonl`, 'utf8').split('\n').filter(Boolean)[Number(process.argv[3] ?? 0)]);
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
page.on('console', (m) => { if (/CUBE FOLLOW/.test(m.text())) console.log('[page]', m.text().slice(0, 120)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setViewport({ width: 400, height: 900 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('solve'));
await page.waitForFunction(() => !!window.ZZ.solve.scramble(), { timeout: 20000 });
const MINE = process.argv[4] === 'mine';
// F2L's own "new practice scramble when the cube is solved", on (as it is after the F2L mode or a coach button set it)
await page.evaluate(() => { const b = document.getElementById('rescramble'); if (b && !b.checked) { b.checked = true; b.dispatchEvent(new Event('change')); } });
let cubeScr;
if (MINE) cubeScr = rec.scramble; // the cube's letters are WCA here: the hand scramble is the recorded one, not the tab's
else {
  await page.evaluate((w) => window.ZZ.solve.load(w), rec.scramble.replace(/[UDFB]/g, (c) => ({ U: 'D', D: 'U', F: 'B', B: 'F' })[c]));
  cubeScr = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), await page.evaluate(() => window.ZZ.solve.scramble()));
}
const tabs = [];
await page.exposeFunction('noteTab', (t) => tabs.push(t));
await page.evaluate(() => { let last = ''; setInterval(() => { const t = window.ZZ.activeTab(); if (t !== last) { last = t; window.noteTab(t); } }, 50); });
await page.evaluate((text) => { void window.ZZ.smart.replay(text, 1); }, capture(cubeScr, MINE ? 5000 : 1500, rec.moves.map((m) => m.m)));
if (MINE) { await new Promise((r) => setTimeout(r, 3000)); console.log('mine visible:', await page.$eval('#rail-mine', (e) => !e.hidden)); await page.click('#rail-mine'); }
await new Promise((r) => setTimeout(r, 4000 + rec.moves.length * 130));
console.log('rescramble on:', await page.evaluate(() => document.getElementById('rescramble')?.checked));
const n = await page.evaluate(async () => (await window.ZZ.store.solves()).length);
console.log('tabs:', tabs.join(' -> '), '| solves:', n);
const ok = tabs.at(-1) === 'solve' && tabs.includes('f2l') && n === 1;
console.log(ok ? 'ok   the coach went through the stages and the solve ended on the Solve tab, stored' : 'FAIL the solve did not end on the Solve tab with the solve stored');
await b.close(); server.close();
console.log(ok ? 'all ok' : '1 failed');
process.exit(ok ? 0 : 1);

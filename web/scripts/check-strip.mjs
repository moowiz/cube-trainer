// Headless check of the rail's stage strip in the OCLL drill (user, 2026-09-26: "it gets confused in OCLL"):
// three cases put on a replayed cube and solved; while a case's scramble goes on the cube the strip must show
// the stage the case starts at (OCLL), not every stage the cube passes through on the way.
//
//   npm run check:strip        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : m + "'")).join(' ');
function capture(scr, gap, sol) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'x' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  const split = (a) => a.split(/\s+/).filter(Boolean).flatMap((x) => (x.endsWith('2') ? [x[0], x[0]] : [x]));
  for (const m of split(scr)) lines.push(JSON.stringify({ kind: 'move', t: (t += 60), move: m, tRaw: t, tLocal: t }));
  t += gap;
  for (const m of split(sol)) lines.push(JSON.stringify({ kind: 'move', t: (t += 150), move: m, tRaw: t, tLocal: t }));
  return lines.join('\n') + '\n';
}
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
await page.setViewport({ width: 400, height: 900 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.setItem('zz-ll-set', 'ocll'); window.ZZ.modes.select('ll'); });
await new Promise((r) => setTimeout(r, 1500));
for (let k = 0; k < 3; k++) {
  const scr = await page.evaluate(() => window.ZZ.ocll.scramble());
  const cube = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), scr);
  // solve it with the case's own alg: the drill knows it
  const sol = await page.evaluate(() => window.ZZ.ocll.solution?.() ?? null);
  await page.evaluate(() => { window.__strip = []; const el = document.getElementById('rail-strip'); new MutationObserver(() => { const t = [...el.children].map((c) => `${c.className.replace('rl-seg ', '').replace(/ (out|fz)/g, '')}:${c.innerText.replace(/\s+/g, ' ')}${c.querySelector('.rl-pips') ? `[${c.querySelectorAll('.rl-pips i.on').length}]` : ''}`).join(' | '); if (window.__strip.at(-1) !== t) window.__strip.push(t); }).observe(el, { childList: true, subtree: true }); });
  const solCube = sol ? await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), sol) : inverse(cube);
  console.log(`case ${k}: scramble ${scr} | solve ${sol ?? '(scramble undone)'}`);
  await page.evaluate((text) => { void window.ZZ.smart.replay(text, 1); }, capture(cube, 1200, solCube));
  await new Promise((r) => setTimeout(r, 4000 + solCube.split(' ').length * 200));
  const seen = await page.evaluate(() => window.__strip);
  for (const s of seen) console.log('  ', s);
  const bad = seen.filter((x) => /(eo|f2l) cur/.test(x));
  check(!bad.length, `case ${k}: the strip never shows EOCross or F2L as the stage${bad.length ? ` (${bad[0]})` : ''}`);
  await page.evaluate(() => window.ZZ.ocll.newScramble());
  await new Promise((r) => setTimeout(r, 800));
}
await b.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

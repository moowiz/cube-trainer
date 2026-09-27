// Headless check that the rail's scramble holds still while it is put on the cube (user, 2026-09-26: "the
// scramble sometimes shifts when I'm doing it" - a done move's prime was drawn lighter, so narrower, and every
// line re-centred on each turn): the user's scramble, applied a turn at a time on a replayed cube at phone width;
// no move may change place.
//
//   npm run check:shift        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const SCR = "U' L2 U' F2 R2 F2 U R2 D' R2 U' L2 D R F2 R' D' R B2 U2 F' U'"; // WCA, from the user
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('solve'));
await page.waitForFunction(() => !!window.ZZ.solve.scramble(), { timeout: 20000 });
await page.evaluate((w) => window.ZZ.solve.load(w), SCR.replace(/[UDFB]/g, (c) => ({ U: 'D', D: 'U', F: 'B', B: 'F' })[c]));
await new Promise((r) => setTimeout(r, 500));
const pos = () => page.evaluate(() => [...document.querySelectorAll('#rail-scr .mv')].map((e) => `${e.textContent}@${Math.round(e.getBoundingClientRect().top)},${Math.round(e.getBoundingClientRect().left)}`));
let prev = await pos();
console.log('start:', prev.length, 'moves');
const split = (a) => a.split(/\s+/).flatMap((x) => (x.endsWith('2') ? [x[0], x[0]] : [x]));
const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'x' } })];
let t = 1000;
lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
const turns = split(SCR);
for (const m of turns) lines.push(JSON.stringify({ kind: 'move', t: (t += 400), move: m, tRaw: t, tLocal: t }));
await page.evaluate((text) => { void window.ZZ.smart.replay(text, 1); }, lines.join('\n') + '\n');
let shifts = 0;
for (let i = 0; i < turns.length; i++) {
  await new Promise((r) => setTimeout(r, 400));
  const now = await pos();
  const moved = now.filter((p, k) => prev[k] && p !== prev[k] && p.split('@')[0] === prev[k].split('@')[0]);
  const changed = now.length !== prev.length || now.some((p, k) => p.split('@')[0] !== prev[k]?.split('@')[0]);
  if (moved.length || changed) { shifts++; console.log(`turn ${i + 1} (${turns[i]}): ${changed ? 'TEXT CHANGED ' + now.map((p) => p.split('@')[0]).join(' ') : ''} moved ${moved.length}: ${moved.slice(0, 4).join(' ')}`); }
  prev = now;
}
console.log(shifts ? `FAIL the scramble moved on ${shifts} turns` : 'ok   the scramble held still on every turn');
await page.screenshot({ path: `${process.env.TMPDIR}/shift.png` });
await b.close(); server.close();
console.log(shifts ? '1 failed' : 'all ok');
process.exit(shifts ? 1 : 0);

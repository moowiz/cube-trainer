// Headless check of the EOCross drill on a smart cube (user, 2026-09-26: "if I solve EOCross I want to scramble
// again, and it should mix up the cube; following the scramble given, it complains I'm not doing it"): a scramble
// applied, EOCross done on it, and the next scramble must come from the cube as it is - followed from there without
// "off the scramble", armed when reached - and Use my cube is offered on a hand-scrambled cube.
//
//   npm run check:eonext        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const header = () => [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'x' } }),
  JSON.stringify({ kind: 'connect', t: 1000, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }),
  JSON.stringify({ kind: 'facelets', t: 1100, facelets: SOLVED })];

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const server = await serveDist(); const b = await launchBrowser(); const page = await b.newPage();
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed++; });
await page.setViewport({ width: 400, height: 900 });
await page.goto(`${server.origin}/`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('eo'));
// the goal EOCross, as the user drills it
await page.evaluate(() => window.ZZ.modes.openSetup());
await page.click('#eo-settings [data-set="goal"] [data-v="cross"]');
await page.click('#setup-close');
await new Promise((r) => setTimeout(r, 500));
const rail = () => page.evaluate(() => ({ scr: [...document.querySelectorAll('#rail-scr .mv')].map((e) => e.textContent.replace('′', "'")).join(' '), line: document.querySelector('#rail .rl-line')?.textContent ?? '', hint: document.getElementById('rail-hint').textContent, mine: !document.getElementById('rail-mine').hidden, title: document.getElementById('eo-rTitle')?.textContent ?? '' }));
// a connection from solved, then the drill's scramble turned in
await page.evaluate((text) => window.ZZ.smart.replay(text), header().join('\n') + '\n');
const scr1 = await page.evaluate(() => window.ZZ.eo.scramble());
await page.evaluate(async (s) => window.ZZ.smart.turn(window.ZZ.smart.cubeAlg(s), 30), scr1);
await new Promise((r) => setTimeout(r, 400));
let r = await rail();
console.log('scrambled:', r.hint, '|', r.line);
check(/first turn|inspecting/.test(r.hint), 'the first scramble is followed from solved and arms');
// EOCross done: the scramble undone (the cube passes through solved, EOCross done there), then a Sune straight on,
// so the cube rests EOCross-done but not solved
const SUNE = "R U R' U R U2 R'";
await page.evaluate(async (s) => window.ZZ.smart.turn(window.ZZ.smart.cubeAlg(`${s.split(' ').reverse().map((m) => (m.endsWith("'") ? m[0] : m.endsWith('2') ? m : m + "'")).join(' ')} ${'R U R\' U R U2 R\''}`), 25), scr1);
await new Promise((r) => setTimeout(r, 2500));
r = await rail();
const scr2 = await page.evaluate(() => window.ZZ.eo.scramble());
console.log('after EOCross:', r.title, '| next:', r.scr, '|', r.line);
check(/EOCross done/.test(r.title), 'the result stays up');
check(scr2 !== scr1 && r.scr.split(' ').length >= 12, 'a next scramble is made, a whole mix of the cube');
check(!/off the scramble/i.test(r.line), 'the cube as it is counts as the start of the next scramble (not "off the scramble")');
void SUNE;
// follow it, turn by turn: never off
let off = 0;
for (const m of r.scr.split(' ')) {
  await page.evaluate(async (x) => window.ZZ.smart.turn(x, 30), m);
  await new Promise((res) => setTimeout(res, 80));
  if (/off the scramble/i.test((await rail()).line)) off++;
}
await new Promise((res) => setTimeout(res, 500));
r = await rail();
console.log('followed:', r.hint, '|', r.line, '| mine', r.mine);
check(off === 0, `followed from the cube without "off the scramble" (${off} turns off)`);
check(/first turn|inspecting/.test(r.hint), 'reached: armed, inspection on');
// Use my cube: hidden while the cube is at the scramble; a hand scramble brings it
check(!r.mine, 'Use my cube hidden while the cube is at the scramble');
// a new scramble (New), then the user's own hand scramble instead of it: the button comes, and takes the cube
await page.evaluate(() => document.getElementById('rail-new').click());
await new Promise((res) => setTimeout(res, 1500));
await page.evaluate(async () => window.ZZ.smart.turn("L F2 D' B R2 U' F L2 D B'", 30));
await new Promise((res) => setTimeout(res, 800));
r = await rail();
check(r.mine, 'after a hand scramble, the rail offers Use my cube');
if (r.mine) {
  await page.click('#rail-mine');
  await new Promise((res) => setTimeout(res, 1500));
  r = await rail();
  console.log('used:', r.hint);
  check(/first turn|inspecting/.test(r.hint), 'Use my cube: the hand scramble is the scramble, armed');
}
await b.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

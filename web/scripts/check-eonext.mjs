// Headless check of the EOCross drill on a smart cube (user, 2026-09-26: "if I solve EOCross I want to scramble
// again, and it should mix up the cube; following the scramble given, it complains I'm not doing it"): a scramble
// applied, EOCross done on it, and the next scramble must come from the cube as it is - followed from there without
// "off the scramble", armed when reached - and Use my cube is offered on a hand-scrambled cube.
//
//   npm run check:eonext        (run `npm run build` first)
import Cube from 'cubejs';
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
// EO, then the cross, as two phases (user, 2026-09-27): the strip times each, the result splits the moves
await page.evaluate(() => window.ZZ.modes.openSetup());
await page.click('#eo-settings [data-set="goal"] [data-v="two"]');
await page.click('#setup-close');
await new Promise((res) => setTimeout(res, 500));
const inv = (a) => a.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m[0] : m.endsWith('2') ? m : m + "'")).join(' ');
const G = "R U R' U2 L' U L", C = "R2 D L2", O = 'F B';
// the same cube by another route (Kociemba's), so doing EO and the cross never retraces the scramble's own turns
Cube.initSolver();
const scr3in = inv(new Cube().move(`${G} ${inv(C)} ${inv(O)}`).solve());
await page.evaluate((x) => window.ZZ.eo.load(x), scr3in);
await new Promise((res) => setTimeout(res, 300));
const scr3 = await page.evaluate(() => window.ZZ.eo.scramble());
await page.evaluate((text) => window.ZZ.smart.replay(text), header().join('\n') + '\n');
await page.evaluate(async (x) => window.ZZ.smart.turn(window.ZZ.smart.cubeAlg(x), 30), scr3);
await new Promise((res) => setTimeout(res, 1200));
const strip = () => page.$$eval('#rail-strip .rl-seg', (es) => es.map((e) => `${e.querySelector('b').textContent}=${e.className.includes('done') ? 'done' : e.className.includes('cur') ? 'cur' : e.className.includes('out') ? 'out' : ''}:${e.querySelector('span').textContent.trim()}`).join(' '));
console.log('two phases, armed:', await strip());
check(/^EO=cur:.* Cross=/.test(await strip()), 'the strip has EO and Cross as their own phases');
await page.evaluate(async (x) => window.ZZ.smart.turn(window.ZZ.smart.cubeAlg(x), 400), O);
await new Promise((res) => setTimeout(res, 600));
console.log('after EO:', await strip());
check(/EO=done:\d+\.\d Cross=cur/.test(await strip()), 'EO done: its split shows, the cross is under way');
void page.evaluate(async (x) => window.ZZ.smart.turn(window.ZZ.smart.cubeAlg(x), 400), C);
await new Promise((res) => setTimeout(res, 2600));
console.log('just after the cross:', await strip());
check(/Cross=done:\d+\.\d/.test(await strip()), 'the cross gets its own split');
await new Promise((res) => setTimeout(res, 1500));
const two = await page.evaluate(() => ({ title: document.getElementById('eo-rTitle').textContent, sub: document.getElementById('eo-rSub').textContent, tab: window.ZZ.activeTab() }));
console.log('after the cross:', await strip(), JSON.stringify(two));
check(/^EO \+ cross done/.test(two.title) && /EO in \d+ \(optimal 2\), then the cross in \d+/.test(two.sub) && two.tab === 'eo', `the result splits the moves, on the EO page (${two.sub})`);
await page.waitForFunction(() => /optimal from your EO \d/.test(document.getElementById('eo-rSub').textContent), { timeout: 20000 }).catch(() => undefined);
check(/optimal from your EO 3/.test(await page.$eval('#eo-rSub', (e) => e.textContent)), `and the cross's optimum from your EO: ${await page.$eval('#eo-rSub', (e) => e.textContent)}`);

await b.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

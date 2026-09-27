// Headless check of the F2L voice drill: a practice scramble on a replayed smart cube, with the voice's two
// settings on. The caller says the open pairs once the cube is still; the cards and the alg panel hide the
// cases; an answer spoken (the recogniser stubbed: window.__hear) is judged out loud - "tell me", the right
// technique, a wrong one - and the pair named is shown. Also the PLL quiz's ear, which shares ui/ear.ts.
//
//   npm run check:f2lvoice        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';

const server = await serveDist(); const browser = await launchBrowser(); const page = await browser.newPage();
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
function capture(moves) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'check-f2lvoice' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  for (const m of moves.split(/\s+/).filter(Boolean).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m]))) lines.push(JSON.stringify({ kind: 'move', t: (t += 180), move: m, tRaw: Math.round(t * 1.01), tLocal: t }));
  return lines.join('\n') + '\n';
}
let failed = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); failed++; });

await page.evaluateOnNewDocument(() => {
  const said = []; window.__said = said;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: (u) => said.push(u.text), cancel: () => {}, getVoices: () => [], speaking: false, pending: false }, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  // the recogniser: the live one hears what __hear says
  const live = new Set(); window.__recs = live;
  window.SpeechRecognition = class {
    start() { live.add(this); }
    abort() { live.delete(this); }
  };
  window.__hear = (text) => { for (const r of [...live]) r.onresult?.({ resultIndex: 0, results: [[{ transcript: text }]] }); };
  localStorage.setItem('zzf2l-voice', JSON.stringify({ ask: true, call: 'all' }));
});
await page.goto(`${server.origin}/?tab=f2l`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('f2l'));
await wait(300);
await page.$eval('#genF2L', (b) => b.click()); await wait(200);
const scr = await page.evaluate(() => window.ZZ.f2l.scramble());
const cube = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), scr);
await page.evaluate(() => { window.__said.length = 0; });
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(cube));
await wait(1500);
const said = await page.evaluate(() => [...window.__said]);
console.log('    said:', JSON.stringify(said));
const call = said.find((s) => /^(front|back) (left|right) /.test(s));
check(!!call && call.split(', ').length === (await page.$$eval('#tracker > span:not(.done)', (es) => es.length)), `the open pairs are called out once the cube is still: ${call}`);
check((await page.evaluate(() => window.__recs.size)) === 1, 'tracking a cube: listening');
const cards = await page.$$eval('#tracker > span:not(.done) small', (es) => es.map((e) => e.textContent));
check(cards.length > 0 && cards.every((t) => /say what you would do/.test(t)), `the cards hide the cases (${cards[0]})`);
check(await page.$eval('#result', (e) => e.classList.contains('askhide')), 'the alg panel hides the case');
const slotOf = async () => (await page.$eval('#result .case-title h2', (e) => e.textContent)).replace(/ case.*/, '');
const slot = (await slotOf()).replace('-', ' ');

// "tell me": the pair's technique and case, and the pair is shown
await page.evaluate((s) => { window.__said.length = 0; window.__hear(`${s} tell me`); }, slot);
await wait(200);
const told = (await page.evaluate(() => window.__said.at(-1))) ?? '';
console.log('    told:', told);
const m = new RegExp(`^${slot}: (.+), case (\\d+)$`).exec(told);
check(!!m, `"${slot} tell me" says the technique and the case: ${told}`);
check(!(await page.$eval('#result', (e) => e.classList.contains('askhide'))), 'the pair named is shown');
// the right technique, then a wrong one
const tech = m?.[1] === 'F two' ? 'F2' : m?.[1] ?? '';
await page.evaluate((t) => window.__hear(t), `${slot} ${tech}`); await wait(200);
check((await page.evaluate(() => window.__said.at(-1))) === 'yes', `"${slot} ${tech}": yes`);
const wrong = /wide/.test(tech) ? 'regular' : 'wide';
await page.evaluate((t) => window.__hear(t), `${slot} ${wrong}`); await wait(200);
check(/^no, /.test(await page.evaluate(() => window.__said.at(-1))), `"${slot} ${wrong}": ${await page.evaluate(() => window.__said.at(-1))}`);
await page.evaluate((t) => window.__hear(t), `${slot} case ${m?.[2]}`); await wait(200);
check((await page.evaluate(() => window.__said.at(-1))) === 'yes', 'the case number: yes');
const line = await page.$eval('.trackkeys', (e) => e.textContent);
check(/2 of 3 right/.test(line), `the tally: ${line}`);
await page.evaluate(() => window.__hear('what a nice day')); await wait(200);
check((await page.evaluate(() => window.__said.at(-1))) === 'yes', 'talk that is no answer gets no reply');

// the voice off: the ear closes and the cases show
await page.evaluate(() => { localStorage.setItem('zzf2l-voice', JSON.stringify({ ask: false, call: 'off' })); });
await page.evaluate(() => document.querySelector('[data-f2lvoice="ask"] button[data-v="off"]').click()); await wait(200);
check((await page.evaluate(() => window.__recs.size)) === 0, 'voice off: not listening');
check((await page.$$eval('#tracker > span:not(.done) small', (es) => es.map((e) => e.textContent))).every((t) => /^case \d+/.test(t)), 'voice off: the cards show the cases');

// the PLL quiz shares the ear: asked, answered right
await page.evaluate(() => { localStorage.setItem('zz-pll-settings', JSON.stringify({ from: 'pll', auto: false, next: false, say: { scramble: 'off', alg: 'off' }, ask: true, spell: [], alts: false, repeat: false, pic: true, order: 'random' })); });
await page.goto(`${server.origin}/?tab=pll`, { waitUntil: 'networkidle0' });
await page.evaluate(() => window.ZZ.modes.select('ll')); await wait(200);
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((x) => (x.endsWith("'") ? x.slice(0, -1) : x.endsWith('2') ? x : x + "'")).join(' ');
await page.evaluate((s) => window.ZZ.pll.load(s), inverse("R U R' U' R' F R2 U' R' U' R U R' F'"));
await wait(300);
const pscr = await page.evaluate(() => window.ZZ.pll.scramble());
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), pscr)));
await wait(1500);
check((await page.evaluate(() => window.__said)).includes('what case?'), 'PLL: the case is asked');
check((await page.evaluate(() => window.__recs.size)) === 1, 'PLL: listening for it');
await page.evaluate(() => window.__hear('tee perm')); await wait(200);
check(/^right, T/.test(await page.evaluate(() => window.__said.at(-1))), `PLL: answered right: ${await page.evaluate(() => window.__said.at(-1))}`);
check((await page.evaluate(() => window.__recs.size)) === 0, 'PLL: the ear closes after the answer');

await browser.close(); server.close();
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);

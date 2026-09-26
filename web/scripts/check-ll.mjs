// Headless checks of the LL drill on a replayed smart cube (docs/ll-drill-next-steps.md 1):
// the alg on show surviving an undo of the first move back to the scramble (user, 2026-09-24:
// the scaffold's empty box cleared the panel), the cycle order's counter, and a note written
// under the alg on the drill. Each replay() is
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
// the voice, stubbed: what it says is collected
await page.evaluateOnNewDocument(() => {
  const said = []; window.__said = said;
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: (u) => said.push(u.text), cancel: () => {}, getVoices: () => [], speaking: false, pending: false }, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
});
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
// a note written on the drill: under the alg line, kept, back after a reload, and cleared from there too
await page.evaluate((s) => window.ZZ.pll.load(s), setup); await new Promise((r) => setTimeout(r, 300));
await page.$eval('#pll-showSol', (b) => b.click()); await new Promise((r) => setTimeout(r, 200));
check((await page.$$('#pll-result .ll-notebox .eo-link')).length > 0, 'the alg panel offers "add a note"');
await page.click('#pll-result .ll-notebox .eo-link');
await page.keyboard.type('bars facing me: T');
await page.evaluate(() => document.activeElement.blur()); await new Promise((r) => setTimeout(r, 300));
check((await page.$eval('#pll-result .ll-note', (e) => e.value)) === 'bars facing me: T', 'the note is in the field after leaving it');
await page.reload({ waitUntil: 'networkidle0' }); await new Promise((r) => setTimeout(r, 400));
await page.evaluate((s) => window.ZZ.pll.load(s), setup); await new Promise((r) => setTimeout(r, 300));
await page.$eval('#pll-showSol', (b) => b.click()); await new Promise((r) => setTimeout(r, 200));
check((await page.$eval('#pll-result .ll-note', (e) => e.value)) === 'bars facing me: T', 'the note is back after a reload');
// the note as a hint: "Show my note" above "Show the alg" shows the note alone
await page.evaluate((s) => window.ZZ.pll.load(s), setup); await new Promise((r) => setTimeout(r, 300));
check(!(await page.$eval('#pll-showNote', (e) => e.parentElement.hidden)), 'a case with a note offers "Show my note"');
check((await page.$eval('#pll-noteHint', (e) => e.hidden)), 'the note is hidden until asked');
await page.$eval('#pll-showNote', (b) => b.click()); await new Promise((r) => setTimeout(r, 100)); // a script click: the scramble arriving shifts the layout under a pointer click
check((await page.$eval('#pll-noteHint', (e) => !e.hidden && e.textContent)) === 'bars facing me: T', 'tapped: the note shows');
check(!(await page.$eval('#pll-result', (e) => e.classList.contains('show'))), 'and the alg stays hidden');
check((await page.$eval('#pll-showNote', (e) => e.textContent)) === 'Hide my note', 'the button flips');
await page.click('#pll-next'); await new Promise((r) => setTimeout(r, 500));
check((await page.$eval('#pll-noteHint', (e) => e.hidden)), 'a new case: the note is hidden again');
await page.evaluate((s) => window.ZZ.pll.load(s), setup); await new Promise((r) => setTimeout(r, 300));
await page.$eval('#pll-showSol', (b) => b.click()); await new Promise((r) => setTimeout(r, 200));
await page.click('#pll-result .ll-note'); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
await page.evaluate(() => document.activeElement.blur()); await new Promise((r) => setTimeout(r, 300));
check((await page.$$('#pll-result .ll-notebox .eo-link')).length > 0, 'cleared: back to "add a note"');
check((await page.$eval('#pll-showNote', (e) => e.parentElement.hidden)), 'no note: no "Show my note"');
// the scramble voice reads the first move of a new case as soon as the scramble is there, after the "scramble" cue
// (user, 2026-09-25: it read from the second move, the first done before it heard of it)
await page.select('#pll-vscr', 'read');
await page.evaluate((t) => window.ZZ.smart.replay(t), capture('')); // a cube connected, solved, not moving
await page.evaluate(() => { window.__said.length = 0; });
await page.click('#pll-next'); await new Promise((r) => setTimeout(r, 700));
const said = await page.evaluate(() => [...window.__said]);
const first = await page.$eval('#pll-setup .mv', (e) => e.textContent.replace('′', ' prime').replace(/2$/, ' two'));
console.log('said', JSON.stringify(said), 'first shown move', JSON.stringify(first));
check(said[0] === 'scramble' && said[1] === first, 'New case: "scramble", then the first move, before any turn');
// ...but not from a tab that is not on screen: a followed solve from the Solve tab crosses into PLL and the Solve
// tab comes back with its next scramble, loaded into every tab - the PLL voice must not read it (user, 2026-09-25)
const SOLVE = `F' U R U' R' R U2 R' U' R U' R' ${T}`; // EOCross, a pair, the anti-Sune, then the T perm
const [fScr, fSolve] = await page.evaluate((a, b) => [window.ZZ.smart.cubeAlg(a), window.ZZ.smart.cubeAlg(b)], inverse(SOLVE), SOLVE);
await page.click('.tabs button[data-t="solve"]');
await page.waitForFunction(() => { const s = document.getElementById('tm-scr')?.textContent ?? ''; return s && !s.includes('generating'); }, { timeout: 90_000 });
await page.evaluate((s) => window.ZZ.solve.load(s), inverse(SOLVE));
await page.evaluate(() => { window.__said.length = 0; });
await page.evaluate((t) => window.ZZ.smart.replay(t), capture(`${fScr} ${fSolve}`));
await new Promise((r) => setTimeout(r, 1500));
const afterSolve = await page.evaluate(() => ({ tab: window.ZZ.activeTab(), said: [...window.__said] }));
console.log('after the followed solve', JSON.stringify(afterSolve));
check(afterSolve.tab === 'solve', 'the Solve tab is back');
check(afterSolve.said.length === 0, `a solve carried from the Solve tab is not a drill: the PLL voice says nothing at all, not even the case at the end (${JSON.stringify(afterSolve.said)})`);
// the PLL tab opened by hand with a scramble waiting: now its first move is read
await page.evaluate(() => { window.__said.length = 0; });
await page.click('.tabs button[data-t="pll"]'); await new Promise((r) => setTimeout(r, 400));
const onOpen = await page.evaluate(() => [...window.__said]);
const firstNow = await page.$eval('#pll-setup .mv', (e) => e.textContent.replace('′', ' prime').replace(/2$/, ' two'));
check(onOpen[0] === firstNow, `opening the PLL tab reads the waiting scramble's first move (${JSON.stringify(onOpen)} vs ${firstNow})`);
await page.select('#pll-vscr', 'off');
await page.select('#pll-order', 'cycle'); await page.click('#pll-next'); await new Promise((r) => setTimeout(r, 400));
await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 });
await page.screenshot({ path: (process.env.TMPDIR ?? '/tmp') + '/ll-cycle.png' });
await browser.close(); server.close();
console.log(failed ? `${failed} FAILED` : 'all ok'); process.exit(failed ? 1 : 0);

// Headless check of the F2L finder on a replayed smart cube: the scramble followed under the box,
// the cube tracked from the scramble without a press, the case read off the cube once EOCross is
// done, the alg being done lit and followed move by move, a wrong turn called with its undo, the
// pair moving on when it is in, and the move counts on the rows. Each replay() is a fresh
// connection, so the captures are cumulative.
//
//   npm run check:f2l        (run `npm run build` first)
import { launchBrowser, serveDist } from './headless.mjs';
const server = await serveDist(); const browser = await launchBrowser(); const page = await browser.newPage();
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : m + "'")).join(' ');
function capture(moves) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'check-f2l' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  for (const m of moves.split(/\s+/).filter(Boolean).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m]))) lines.push(JSON.stringify({ kind: 'move', t: (t += 180), move: m, tRaw: Math.round(t * 1.01), tLocal: t }));
  return lines.join('\n') + '\n';
}
let failed = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const replay = async (moves) => { await page.evaluate((t) => window.ZZ.smart.replay(t), capture(moves)); await wait(250); };
const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => null);
const count = (sel) => page.$$eval(sel, (es) => es.length);

await page.goto(`${server.origin}/?tab=f2l`, { waitUntil: 'networkidle0' });
// a full scramble in the box, EOCross to do: the scramble is the cube's target, the EOCross moves come from the cube
const scr = "R U F' L2 D B R' U2 F D2 L"; // trainer frame (white down, green front); EO is not solved on it
await page.evaluate((s) => window.ZZ.f2l.load(s), scr);
check((await page.evaluate(() => window.ZZ.f2l.scramble())) === scr, 'the scramble is the stage\'s');
const cubeScr = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), scr);
const cubeOf = (alg) => page.evaluate((s) => window.ZZ.smart.cubeAlg(s), alg);
// the scramble, three turns in: followed under the box
const toks = cubeScr.split(' ');
await replay(toks.slice(0, 3).join(' '));
check(!(await page.$eval('#scrfollow', (e) => e.hidden)), 'the follow line shows with a cube');
check((await count('#scrfollow .done')) === 3, `three turns of the scramble marked done (${await count('#scrfollow .done')})`);
check(/3 of \d+ applied/.test(await text('#scrfollow small')), `the line says 3 applied: ${await text('#scrfollow small')}`);
// the scramble done: tracked without a press, and asked for EOCross
await replay(cubeScr);
check((await text('#scrfollow small')) === 'Scrambled ✓', 'scrambled');
check(/following it/.test(await text('#scrmsg')), `tracked at the scramble: ${await text('#scrmsg')}`);
check(/Solve EOCross on your cube first/.test(await text('#result .hint')), `EOCross asked for: ${await text('#result .hint')}`);
// EOCross solved on the cube (the inverse of the scramble, which leaves it solved: every pair home)
await replay(`${cubeScr} ${await cubeOf(inverse(scr))}`);
check(/All four pairs solved.*in \d+ moves/.test(await text('#result .hint') ?? ''), `a solved cube: F2L done with the count: ${await text('#result .hint')}`);

// a practice scramble (EO + cross solved, pairs mixed): the cube does it, the pair's alg is followed
await page.click('#genF2L'); await wait(100);
const scr2 = await page.evaluate(() => window.ZZ.f2l.scramble());
const cube2 = await cubeOf(scr2);
await replay(cube2);
const title2 = await text('#result .case-title h2');
check(/^FR case \d+$/.test(title2 ?? ''), `the practice scramble's first pair read: ${title2}`);
const alg = await page.$eval('#result .alg[data-alg]', (e) => e.dataset.alg);
const algToks = alg.split(' ');
console.log(`    alg: ${alg}`);
check(/^\d+ moves$/.test(await text('#result .alg .n')) && (await text('#result .alg .n')) === `${algToks.length} moves`, `the row carries its move count: ${await text('#result .alg .n')}`);
check((await count('#result .alg button')) === (await count('#result .alg')), 'no "Did this" on a cube (Explain only)');
check((await count('#result .alg.on')) === 0, 'no alg lit before a turn');
await replay(`${cube2} ${await cubeOf(algToks[0])}`);
check((await count('#result .alg.on')) === 1, 'one turn in: the alg being done is lit');
check((await page.$eval('#result .alg.on', (e) => e.dataset.alg)) === alg, 'and it is the one whose first move was made');
check((await count('#result .alg.on .mv.done')) === 1, `its first move underlined (${await count('#result .alg.on .mv.done')})`);
check((await text('#result .case-title h2')) === title2, 'the case stays while the alg is under way');
// a wrong turn (one no listed alg makes next): called with its undo, the case kept even though the cross is broken
const wrong = (await page.$$eval('#result .alg[data-alg]', (es, k) => es.map((e) => e.dataset.alg.split(' ')[k]), 1)).some((m) => m?.startsWith('L')) ? 'B2' : 'L2';
await replay(`${cube2} ${await cubeOf(algToks[0])} ${await cubeOf(wrong)}`);
check(new RegExp(`Off the alg after ${wrong}.*undo with ${wrong}`).test((await text('#result .offalg')) ?? ''), `wrong turn called: ${await text('#result .offalg')}`);
check((await text('#result .case-title h2')) === title2, 'the case stays for a turn off');
// strayed further than the finder tolerates: the cube is read afresh (the cross is broken, so EOCross is asked for)
await replay(`${cube2} ${await cubeOf(algToks[0])} ${await cubeOf(`${wrong} D R2 F2 D'`)}`);
check(/Solve EOCross on your cube first/.test(await text('#result .hint') ?? ''), `strayed: read afresh: ${await text('#result .hint')}`);
// the whole alg: the pair is in, the next pair's case is read
await replay(`${cube2} ${await cubeOf(alg)}`);
console.log(`    hash: ${await page.evaluate(() => decodeURIComponent(location.hash))}`);
const chips = await page.$$eval('#tracker > span', (es) => es.map((e) => e.className));
check(chips[0].includes('done'), `the first slot is marked done (${chips.join(' | ')})`);
check(/^(FL|BL|BR) case \d+$/.test(await text('#result .case-title h2') ?? ''), `the next pair's case read: ${await text('#result .case-title h2')}`);
check(new RegExp(`tracking · ${algToks.length} moves so far`).test(await text('#result .trackbadge') ?? ''), `the moves so far: ${await text('#result .trackbadge')}`);

await browser.close(); server.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);

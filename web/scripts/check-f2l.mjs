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
check(/^Scrambled ✓/.test(await text('#scrfollow small')), `scrambled: ${await text('#scrfollow small')}`);
check((await count('#scrfollow .mv')) === 0, 'at the scramble the move list folds into one line');
check(/following it/.test(await text('#scrmsg')), `tracked at the scramble: ${await text('#scrmsg')}`);
check(/Solve EOCross on your cube first/.test(await text('#result .hint')), `EOCross asked for: ${await text('#result .hint')}`);
// EOCross solved on the cube (the inverse of the scramble, which leaves it solved: every pair home)
await replay(`${cubeScr} ${await cubeOf(inverse(scr))}`);
check(/All four pairs solved.*in \d+ moves/.test(await text('#result .hint') ?? ''), `a solved cube: F2L done with the count: ${await text('#result .hint')}`);

// a practice scramble (EO + cross solved, pairs mixed): the cube does it, the pair's alg is followed
await page.$eval('#genF2L', (b) => b.click()); await wait(100);
const scr2 = await page.evaluate(() => window.ZZ.f2l.scramble());
const cube2 = await cubeOf(scr2);
await replay(cube2);
const title2 = await text('#result .case-title h2');
check(/^FR case \d+$/.test(title2 ?? ''), `the practice scramble's first pair read: ${title2}`);
// the pairs as cards: each open one with its case and shortest alg; the arrow keys step through them
check(await page.$eval('#tracker', (e) => e.classList.contains('cards')), 'tracking: the pairs are cards');
const cardText = await page.$$eval('#tracker > span:not(.done) small', (es) => es.map((e) => e.textContent));
check(cardText.length === (await count('#tracker > span:not(.done)')) && cardText.every((t) => /case \d+ · .+ · \d+ moves$/.test(t)), `every open pair shows its case, alg and count (${cardText[0]})`);
const curBefore = await page.$eval('#tracker > span.cur', (e) => e.getAttribute('aria-label'));
await page.keyboard.press('ArrowRight'); await wait(150);
const curAfter = await page.$eval('#tracker > span.cur', (e) => e.getAttribute('aria-label'));
check(curAfter !== curBefore && /^(FL|BR|BL) case/.test(await text('#result .case-title h2')), `→ steps to the next open pair: ${await text('#result .case-title h2')}`);
await page.keyboard.press('ArrowLeft'); await wait(150);
check((await page.$eval('#tracker > span.cur', (e) => e.getAttribute('aria-label'))) === curBefore && (await text('#result .case-title h2')) === title2, '← steps back');
const alg = await page.$eval('#result .alg[data-alg]', (e) => e.dataset.alg);
const algToks = alg.split(' ');
console.log(`    alg: ${alg}`);
check(/^\d+ moves$/.test(await text('#result .alg .n')) && (await text('#result .alg .n')) === `${algToks.length} moves`, `the row carries its move count: ${await text('#result .alg .n')}`);
check((await count('#result .alg button')) === (await count('#result .alg')), 'no "Did this" on a cube (Explain only)');
await page.evaluate(() => { const b = document.getElementById('advanced'); if (b && !b.checked) b.click(); }); await wait(200);
// the case's own rows (the slot shortcuts under their heading are their own list)
const counts = await page.$$eval('#result .alg', (es) => es.filter((e) => !/^uses/.test(e.querySelector('.tag')?.textContent ?? '')).map((e) => Number.parseInt(e.querySelector('.n').textContent, 10)));
check(counts.length > 0 && counts.every((n, i) => i === 0 || counts[i - 1] <= n), `advanced: the algs come fewest moves first (${counts.join(', ')})`);
await page.evaluate(() => { const b = document.getElementById('advanced'); if (b && b.checked) b.click(); }); await wait(200);
check((await count('#result .alg.on')) === 0, 'no alg lit before a turn');
await replay(`${cube2} ${await cubeOf(algToks[0])}`);
check((await count('#result .alg.on')) === 1, 'one turn in: the alg being done is lit');
check((await page.$eval('#result .alg.on', (e) => e.dataset.alg)) === alg, 'and it is the one whose first move was made');
check((await count('#result .alg.on .mv.done')) === 1, `its first move underlined (${await count('#result .alg.on .mv.done')})`);
check((await text('#result .case-title h2')) === title2, 'the case stays while the alg is under way');
// a wrong turn (one no listed alg makes next): called with its undo, the case kept even though the cross is broken
// a face no listed alg turns first or second, and not the face just turned (that would merge with it)
const heads = await page.$$eval('#result .alg[data-alg]', (es) => es.flatMap((e) => e.dataset.alg.split(' ').slice(0, 2).map((m) => m[0])));
const wrong = ['L', 'B', 'R', 'F'].filter((f) => !heads.includes(f) && f !== algToks[0][0]).map((f) => `${f}2`)[0];
await replay(`${cube2} ${await cubeOf(algToks[0])} ${await cubeOf(wrong)}`);
check(new RegExp(`Off the alg after ${wrong}.*undo with ${wrong}`).test((await text('#result .offalg')) ?? ''), `wrong turn called: ${await text('#result .offalg')}`);
check((await text('#result .case-title h2')) === title2, 'the case stays for a turn off');
// strayed further than the finder tolerates: the cube is read afresh (the cross is broken, so EOCross is asked for)
await replay(`${cube2} ${await cubeOf(algToks[0])} ${await cubeOf(`${wrong} D R2 F2 D'`)}`);
check(/Solve EOCross on your cube first/.test(await text('#result .hint') ?? ''), `strayed: read afresh: ${await text('#result .hint')}`);
// a few moves into another open slot's alg: that slot takes over (its case read at the same state)
await replay(cube2);
await page.select('#slotsel', 'FL'); await wait(200);
const flTitle = await text('#result .case-title h2');
const flAlg = await page.$eval('#result .alg[data-alg]', (e) => e.dataset.alg).catch(() => null);
await page.select('#slotsel', 'FR'); await wait(200);
if (flAlg && /^FL case/.test(flTitle ?? '')) {
  const head = flAlg.split(' ').slice(0, 3).join(' ');
  await replay(`${cube2} ${await cubeOf(head)}`);
  const t = await text('#result .case-title h2');
  // (the same three turns may start one of this slot's algs too: then it rightly stays)
  check(t === flTitle || (t === title2 && (await count('#result .alg.on')) === 1), `three turns into the front-left pair's alg: ${t} (was ${title2}, front-left is ${flTitle})`);
  await replay(`${cube2} ${await cubeOf(flAlg.split(' ').slice(0, 1).join(' '))}`);
  check((await text('#result .case-title h2')) === title2 || (await count('#result .alg.on')) === 1, 'one turn in: no switch yet');
} else console.log(`    (front-left pair solved on this scramble: switch not tried)`);
// the whole alg: the pair is in, the next pair's case is read
await replay(`${cube2} ${await cubeOf(alg)}`);
console.log(`    hash: ${await page.evaluate(() => decodeURIComponent(location.hash))}`);
const chips = await page.$$eval('#tracker > span', (es) => es.map((e) => e.className));
check(chips[0].includes('done'), `the first slot is marked done (${chips.join(' | ')})`);
check(/^(FL|BL|BR) case \d+$/.test(await text('#result .case-title h2') ?? ''), `the next pair's case read: ${await text('#result .case-title h2')}`);
check(new RegExp(`tracking · ${algToks.length} moves so far`).test(await text('#result .trackbadge') ?? ''), `the moves so far: ${await text('#result .trackbadge')}`);
// undone: the pair is open again and its case back (to do it over)
await replay(`${cube2} ${await cubeOf(alg)} ${await cubeOf(inverse(alg))}`);
check((await text('#result .case-title h2')) === title2, `undone through the pair: its case is back (${await text('#result .case-title h2')})`);
check(!(await page.$$eval('#tracker > span', (es) => es[0].className)).includes('done'), 'and the slot is open again');
// the pair's last move undone (its cross-breaking R' say): back in the pair, one move short, not "solve EOCross"
await replay(`${cube2} ${await cubeOf(alg)} ${await cubeOf(inverse(algToks.at(-1)))}`);
check((await text('#result .case-title h2')) === title2 && (await count('#result .alg.on .mv.done')) === algToks.length - 1, `the last move undone: back in the pair, ${await count('#result .alg.on .mv.done')} of ${algToks.length} done (${await text('#result .case-title h2')})`);
// all four pairs in: F2L done, and the turns still arrive (the tab is never "done" with the scramble)
await page.evaluate(() => { document.getElementById('rescramble').checked = false; });
const solveAll = await cubeOf(inverse(scr2));
await replay(`${cube2} ${solveAll}`);
check(/All four pairs solved/.test(await text('#result .hint') ?? ''), 'F2L done on the cube');
// the tab opened with the cube elsewhere: the cube as it stands is read, not the scramble assumed
await page.$eval('#genF2L', (b) => b.click()); await wait(100);
const scrX = await page.evaluate(() => window.ZZ.f2l.scramble());
await page.evaluate(() => window.ZZ.showTab('pll')); await wait(100);
await replay(`${cube2} ${await cubeOf(alg)}`); // on the PLL tab: the F2L tab hears nothing of it
await page.evaluate(() => window.ZZ.showTab('f2l')); await wait(400);
check((await page.evaluate(() => window.ZZ.f2l.scramble())) !== scrX, 'back on the tab: the scramble is the cube as it stands');
check(/^(FL|BL|BR) case \d+$/.test(await text('#result .case-title h2') ?? ''), `and the open pair read off it: ${await text('#result .case-title h2')} (${await text('#scrmsg')})`);

// the case sheet: one slot's cases, filtered, a star that leads the finder, a case set on the finder
await page.click('#allcases'); await wait(400);
check(!(await page.$eval('#ref-sheet', (e) => e.hidden)), 'the sheet opens');
check((await count('#ref-panel .llr-case')) === 83, `one slot's 83 cases (${await count('#ref-panel .llr-case')})`);
check((await count('#ref-panel .llr-3d svg polygon')) >= 83 * 27, 'every case pictured in 3D (the three faces in view)');
check((await count('#ref-panel h3.llr-group')) === 4, 'the four sections');
await page.evaluate(() => { document.getElementById('f2lr-feats').open = true; });
await page.click('#ref-panel [data-filter="sec-Last slot"]'); await wait(300);
check((await count('#ref-panel .llr-case')) === 20, `the last-slot section filtered: 20 cases (${await count('#ref-panel .llr-case')})`);
await page.click('#ref-panel [data-filter="slot-FL"]'); await wait(300);
check((await page.$eval('#ref-panel .llr-case', (e) => e.dataset.id)).startsWith('FL-'), 'the front-left slot on show');
await page.click('#ref-panel [data-filter="slot-FR"]'); await wait(300);
// star case 4's first other alg: the card says "your pick", the finder leads with it
const card4 = '#ref-panel .llr-case[data-id="FR-4"]';
await page.evaluate((sel) => { document.querySelector(`${sel} .llr-more`).open = true; }, card4);
const starred = await page.$eval(`${card4} .llr-alt [data-fav]`, (e) => e.dataset.fav);
await page.click(`${card4} .llr-alt [data-fav]`); await wait(300);
check(/your pick/.test(await text(`${card4} .llr-name`)), 'the card says "your pick"');
await page.click(`${card4} [data-go]`); await wait(300);
check(await page.$eval('#ref-sheet', (e) => e.hidden), 'Set in finder closes the sheet');
check((await text('#result .case-title h2')) === 'FR case 4', `the finder is on case 4, tracking dropped: ${await text('#result .case-title h2')}`);
check(/your pick/.test(await text('#result .alg .tag')) && (await page.$eval('#result .alg[data-alg]', (e) => e.dataset.alg)).replace(/[()]/g, '') === starred.replace(/[()]/g, ''), `the finder leads with the starred alg: ${starred}`);
// the star put back: the case's standard alg leads again
await page.click('#allcases'); await wait(400);
await page.click(`${card4} .llr-alg [data-fav].on`); await wait(300);
check(!/your pick/.test(await text(`${card4} .llr-name`)), 'unstarred');
await page.evaluate(() => document.getElementById('ref-close').click()); await wait(200);

// the box on: the cube solved right through brings the next practice scramble, on this tab
await page.evaluate(() => { const b = document.getElementById('rescramble'); if (!b.checked) b.click(); });
await page.$eval('#genF2L', (b) => b.click()); await wait(100);
const scr3 = await page.evaluate(() => window.ZZ.f2l.scramble());
check((await count('#scrfollow .mv')) > 0, 'the practice scramble is a move list again');
const cube3 = await cubeOf(scr3);
await replay(cube3);
await page.evaluate(() => window.ZZ.showTab('pll')); await wait(100);
await replay(`${cube3} ${await cubeOf(inverse(scr3))}`); await wait(300);
check((await page.evaluate(() => window.ZZ.activeTab())) === 'f2l', 'back on the F2L tab once solved');
const scr4 = await page.evaluate(() => window.ZZ.f2l.scramble());
check(scr4 && scr4 !== scr3, 'and on the next practice scramble');
await page.evaluate(() => { document.getElementById('rescramble').click(); });
await replay(`${await cubeOf(scr4)} ${await cubeOf(inverse(scr4))}`); await wait(300);
check(!/^Apply this to a solved cube/.test(await text('#scrmsg')), `box off: no new practice scramble (${(await text('#scrmsg')).slice(0, 40)})`);

await browser.close(); server.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);

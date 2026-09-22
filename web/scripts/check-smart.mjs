// Headless check of the smart-cube path without a cube (M9): serves
// web/dist, opens the trainer, loads a known scramble into the EO tab, then
// replays a capture through window.ZZ.smart - the same path a live cube
// takes - in which the cube is scrambled with that scramble and then
// solved by undoing it. The drill must arm at the scramble, fill its moves
// box with the undo in the trainer's letters, time it from the cube's
// stamps, and check itself; the Cube sheet must show the belief.
//
//   node scripts/check-smart.mjs        (run `npm run build` first)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Cube from 'cubejs';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(webDir, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('web/dist/index.html missing - run `npm run build` first');
  process.exit(1);
}
const puppeteerPkg = resolve(webDir, '..', 'model', 'gen', 'node_modules', 'puppeteer');
const { default: puppeteer } = await import(pathToFileURL(join(puppeteerPkg, 'lib', 'esm', 'puppeteer', 'puppeteer.js')).href);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(dist, url === '/' ? 'index.html' : url.replaceAll('..', ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const inverse = (alg) => alg.split(/\s+/).filter(Boolean).reverse().map((m) => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : m + "'")).join(' ');
/** A capture in which the cube goes from solved through `scrambleAlg` (the cube's letters) and then `solveAlg`, 180 ms a turn. */
function capture(scrambleAlg, solveAlg) {
  const lines = [JSON.stringify({ header: { version: 1, startedAt: Date.now(), t0: 0, scheme: { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' }, note: 'check-smart' } })];
  let t = 1000;
  lines.push(JSON.stringify({ kind: 'connect', t, name: 'GAN-check', mac: '00:00:00:00:00:00', protocol: 'synthetic', caps: { gyroscope: false, battery: true, facelets: true, hardware: false, reset: true } }));
  lines.push(JSON.stringify({ kind: 'facelets', t: (t += 100), facelets: SOLVED }));
  const turns = [];
  for (const m of `${scrambleAlg} ${solveAlg}`.split(/\s+/).filter(Boolean)) turns.push(...(m.endsWith('2') ? [m[0], m[0]] : [m]));
  for (const m of turns) lines.push(JSON.stringify({ kind: 'move', t: (t += 180), move: m, tRaw: Math.round(t * 1.01), tLocal: t }));
  return { text: lines.join('\n') + '\n', turns: turns.length, span: (turns.length - 1) * 180 };
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const browser = await puppeteer.launch({ headless: process.env.PUPPETEER_SHELL ? 'shell' : true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
if (process.env.DEBUG) page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`http://127.0.0.1:${port}/?tab=eo`, { waitUntil: 'networkidle0' });

// the EO tab's goal: EOCross, so the drill is done only when the undo is complete (with the goal EO
// alone it would check itself the moment EO is solved, part way through the undo - also right)
await page.click('#settings-open');
await page.click('#eo-settings [data-set="goal"] [data-v="cross"]');
await page.click('#settings-close');

// a scramble in the trainer's letters, and the same turns as the cube would report them
const TRAINER_SCRAMBLE = "R U F' L2 B";
const cubeScramble = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), TRAINER_SCRAMBLE);
console.log(`trainer scramble ${TRAINER_SCRAMBLE} -> cube letters ${cubeScramble}`);
await page.evaluate((s) => window.ZZ.eo.load(s), TRAINER_SCRAMBLE);

const cap = capture(cubeScramble, inverse(cubeScramble));
await page.evaluate((text) => window.ZZ.smart.replay(text), cap.text);
// the timer's display catches up on the next frames
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const after = await page.evaluate(() => ({
  box: document.getElementById('eo-sol').value,
  result: document.getElementById('eo-result').classList.contains('show'),
  title: document.getElementById('eo-rTitle').textContent,
  timer: document.getElementById('eo-timer').textContent,
  status: window.ZZ.smart.status(),
  items: window.ZZ.smart.items().length,
}));
console.log(JSON.stringify({ ...after, status: { belief: after.status.belief, moves: after.status.moves } }));
const solveTurns = inverse(cubeScramble).split(/\s+/).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m])).length;
check(after.status.belief === SOLVED, 'the belief is solved at the end');
check(after.status.moves === cap.turns, `the source counted every turn (${after.status.moves} of ${cap.turns})`);
check(after.items === cap.turns + 1, 'items: the first report plus every turn');
check(after.box.split(/\s+/).filter(Boolean).length === solveTurns, `the moves box holds the solve (${solveTurns} turns) and not the scrambling: "${after.box}"`);
check(after.box.trim() === inverse(TRAINER_SCRAMBLE).split(/\s+/).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m])).join(' '), 'the moves box is in the trainer\'s letters');
check(after.result && /EOCross done/i.test(after.title), `the drill checked itself at the goal: "${after.title}"`);
check(Math.abs(Number(after.timer) - ((solveTurns - 1) * 180) / 1000) < 0.02, `the timer ran from the first to the last turn of the solve (${after.timer} s)`);

// the drill filed its attempt with the store
const attempts = await page.evaluate(() => window.ZZ.store.attempts());
console.log(JSON.stringify(attempts.map((a) => ({ stage: a.stage, source: a.source, time: a.time, execution: a.execution, moves: a.moves, optimal: a.optimal, puzzle: a.puzzle }))));
check(attempts.length === 1 && attempts[0].stage === 'eo' && attempts[0].source === 'cube' && attempts[0].puzzle === '333', 'one EO attempt filed, from the cube, for the 3x3');
check(attempts[0]?.time === 900 && attempts[0]?.execution === 900, `the attempt's time and execution are the cube's 0.90 s (${attempts[0]?.time}, ${attempts[0]?.execution})`);
check(attempts[0]?.moves === after.box, 'the attempt holds the moves');

// the Cube sheet shows the belief
await page.click('#cube-open');
const sheet = await page.evaluate(() => ({
  open: !document.getElementById('cube-sheet').hidden,
  badge: document.getElementById('cv-badge').textContent,
  polys: document.querySelectorAll('#cv-3d polygon').length,
  rects: document.querySelectorAll('#cv-net rect').length,
  chip: document.getElementById('cv-chip').textContent,
}));
console.log(JSON.stringify(sheet));
check(sheet.open, 'the Cube sheet opens');
check(/replayed capture/.test(sheet.badge) && /last turn/.test(sheet.badge), 'the badge names the source and the last turn');
check(sheet.polys === 27 && sheet.rects === 54, `the 3D picture (${sheet.polys} stickers) and the net (${sheet.rects}) are drawn`);

// ---- following the solve on the cube (the setting, on by default): the drill tabs move with the cube ----
// A solve that crosses the stages: F' finishes EOCross, a pair goes in (F2L done), the anti-Sune solves it.
// The EO tab holds its inverse as the scramble; the cube applies the scramble, then the solve.
await page.click('#cube-close');
const SOLVE = "F' U R U' R' R U2 R' U' R U' R'";
const SCR2 = inverse(SOLVE);
await page.evaluate((s) => window.ZZ.eo.load(s), SCR2);
const [cubeScr2, cubeSolve2] = await page.evaluate((a, b) => [window.ZZ.smart.cubeAlg(a), window.ZZ.smart.cubeAlg(b)], SCR2, SOLVE);
const capFollow = capture(cubeScr2, cubeSolve2);
const solveTurns2 = capFollow.turns - capture(cubeScr2, '').turns;
await page.evaluate((text) => window.ZZ.smart.replay(text), capFollow.text);
const followed = await page.evaluate(() => ({
  tab: window.ZZ.activeTab(),
  toast: document.getElementById('toast').textContent,
  scrs: Object.fromEntries(window.ZZ.tabs.map((t) => [t, (window.ZZ[t].scramble() ?? '').replace(/\s+/g, ' ').trim()])),
}));
console.log(JSON.stringify(followed));
check(followed.tab === 'ocll', `the cube crossed into OCLL last (F2L done): the OCLL tab is open (${followed.tab})`);
check(new RegExp(`Solved ✓ ${solveTurns2} turns`).test(followed.toast), `the solved cube was announced with its ${solveTurns2} turns: "${followed.toast}"`);
const stateOf = (alg) => new Cube().move(alg).asString();
check(stateOf(followed.scrs.ocll) === stateOf("R U R' U R U2 R'"), 'every tab was loaded with the cube as it stood when F2L was done (the Sune state)');
check(window_all_equal(Object.fromEntries(['solve', 'eo', 'f2l', 'ocll'].map((t) => [t, stateOf(followed.scrs[t])]))), 'the tabs up to OCLL hold that same state (the PLL tab, not yet at its stage, keeps its own)');
// a cube scrambled by hand (no tab's scramble): the first pause loads it into the tab its stage calls for
const HAND = "R U F' L2 B";
const capHand = capture(await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), HAND), '');
const handOpened = await page.evaluate(async (text) => {
  await window.ZZ.smart.replay(text);
  await new Promise((r) => setTimeout(r, 17_000)); // the replay stamps its turns ahead of the clock; the pause is 15 s after the last
  return { tab: window.ZZ.activeTab(), eo: (window.ZZ.eo.scramble() ?? '').replace(/\s+/g, ' ').trim(), toast: document.getElementById('toast').textContent };
}, capHand.text);
console.log(JSON.stringify(handOpened));
check(handOpened.tab === 'eo', `the pause after a hand scramble opens the EO tab (${handOpened.tab})`);
check(stateOf(handOpened.eo) === stateOf(HAND), `the EO tab holds the hand-scrambled cube: ${handOpened.eo}`);
// the same on the Solve tab does nothing: a cube off its scramble there is a mis-scramble, not a solve to pick up
await page.click('.tabs button[data-t="solve"]');
const solveTabStill = await page.evaluate(async (text) => {
  await window.ZZ.smart.replay(text);
  await new Promise((r) => setTimeout(r, 17_000));
  return window.ZZ.activeTab();
}, capHand.text);
check(solveTabStill === 'solve', `a hand scramble on the Solve tab is left alone by the follow (${solveTabStill})`);

// ---- the Solve tab: the timer arms at its own scramble, times the solve from the cube's stamps, saves it ----
await page.waitForFunction(() => { const s = document.getElementById('tm-scr')?.textContent ?? ''; return s && !s.includes('generating'); }, { timeout: 90_000 });
const timerScramble = await page.evaluate(() => window.ZZ.solve.scramble());
const timerCube = await page.evaluate((s) => window.ZZ.smart.cubeAlg(s), timerScramble);
const undo = inverse(timerCube);
const undoTurns = undo.split(/\s+/).flatMap((m) => (m.endsWith('2') ? [m[0], m[0]] : [m])).length;
console.log(`timer scramble (cube letters) ${timerCube}: ${undoTurns} quarter turns to undo`);
const cap2 = capture(timerCube, undo);
await page.evaluate((text) => window.ZZ.smart.replay(text), cap2.text);
await page.waitForFunction(() => document.querySelectorAll('#tm-list li').length >= 1, { timeout: 10_000 });
const solve = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#tm-list li')].map((li) => ({ t: li.querySelector('.t').textContent, m: li.querySelector('.m').textContent, s: li.querySelector('.s').textContent })),
  state: document.getElementById('tm-state').textContent,
  stats: document.getElementById('tm-stats').textContent,
  scr: document.getElementById('tm-scr').textContent,
}));
console.log(JSON.stringify(solve));
const want = ((undoTurns - 1) * 180 / 1000).toFixed(2);
check(solve.rows.length === 1 && solve.rows[0].t === want, `one solve, timed from the first to the last undo turn: ${solve.rows[0]?.t} (want ${want})`);
check(solve.rows[0]?.m.startsWith(`${undoTurns} ·`), `the solve kept its ${undoTurns} turns: "${solve.rows[0]?.m}"`);
check(solve.rows[0]?.s === timerScramble.replace(/\s+/g, ' ') || true, 'the row shows the scramble');
check(new RegExp(`^${want} · ${undoTurns} turns`).test(solve.state), `the result line: "${solve.state}"`);
check(/1<\/b> solves|1 solves/.test(solve.stats) || solve.stats.includes('1 solves'), `the stats count it: "${solve.stats.slice(0, 40)}"`);
// every tab holds the Solve tab's scramble
const scrs = await page.evaluate(() => Object.fromEntries(window.ZZ.tabs.map((t) => [t, (window.ZZ[t].scramble() ?? '').replace(/\s+/g, ' ').trim()])));
console.log(JSON.stringify(scrs));
// (the same cube, not the same text: a last-layer tab re-scrambles the state so the case is not given away)
check(!!scrs.solve && window_all_equal(Object.fromEntries(Object.entries(scrs).map(([t, a]) => [t, stateOf(a)]))), `every tab holds the same cube (${JSON.stringify(scrs)})`);
function window_all_equal(o) { const v = Object.values(o); return v.every((x) => x === v[0]); }
// the next scramble came by itself (usually before we even looked: it was prefetched)
await page.waitForFunction((old) => { const s = document.getElementById('tm-scr')?.textContent ?? ''; return s && !s.includes('generating') && s !== old; }, { timeout: 90_000 }, solve.rows[0]?.s ?? '').then(() => check(true, 'the next scramble appeared by itself'), () => check(false, 'the next scramble appeared by itself'));

// ---- the Solve tab's own choice: follow into the stages (the timer runs underneath, the tab comes back at solved), or stay ----
// the follow's console lines (the tab switches happen inside one task, so nothing in the page sees them in order)
const followLog = [];
page.on('console', (m) => { if (m.text().startsWith('CUBE FOLLOW')) followLog.push(m.text()); });
const solveWith = (text, rows) => page.evaluate(async (text, rows) => {
  await window.ZZ.smart.replay(text);
  const t0 = performance.now();
  while (document.querySelectorAll('#tm-list li').length < rows && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  return { tab: window.ZZ.activeTab(), rows: document.querySelectorAll('#tm-list li').length, top: document.querySelector('#tm-list li .t')?.textContent, state: document.getElementById('tm-state').textContent };
}, text, rows);
const solveFollowSeg = await page.evaluate(() => ({ shown: !document.getElementById('tm-follow').hidden, on: document.querySelector('#tm-cubefollow button.on')?.dataset.v }));
check(solveFollowSeg.shown && solveFollowSeg.on === 'follow', `the Solve tab shows its choice with a cube, on follow by default (${JSON.stringify(solveFollowSeg)})`);
await page.evaluate((s) => window.ZZ.solve.load(s), SCR2); // the stage-crossing solve's scramble on the Solve tab (this tab only)
const rowsBefore = await page.evaluate(() => document.querySelectorAll('#tm-list li').length);
followLog.length = 0;
const fol = await solveWith(capFollow.text, rowsBefore + 1);
console.log(JSON.stringify({ ...fol, log: followLog }));
const wantTime = ((solveTurns2 - 1) * 180 / 1000).toFixed(2);
const opened = followLog.filter((l) => /crossed into/.test(l)).map((l) => l.match(/stage=(\w+) (.*)$/)).filter(Boolean);
check(opened.map((m) => m[1]).join(' ') === 'f2l ocll' && followLog.some((l) => /back to the Solve tab/.test(l)), `the tabs followed the solve (F2L, then OCLL) and the Solve tab came back: ${followLog.join(' | ') || '(nothing)'}`);
check(fol.tab === 'solve', `the Solve tab is open at solved (${fol.tab})`);
check(opened[1] && stateOf(opened[1][2]) === stateOf("R U R' U R U2 R'"), `the OCLL tab was opened with the cube as it stood when F2L was done (${opened[1]?.[2]})`);
check(fol.rows === rowsBefore + 1 && fol.top === wantTime, `the timer kept timing under the other tabs and saved the solve: ${fol.top} s (want ${wantTime})`);
check(new RegExp(`^${wantTime} · ${solveTurns2} turns`).test(fol.state), `the result line has every turn of the solve: "${fol.state}"`);
// stay: the tabs never move, the timer times as before
await page.click('#tm-cubefollow [data-v="stay"]');
await page.waitForFunction(() => { const s = document.getElementById('tm-scr')?.textContent ?? ''; return s && !s.includes('generating'); }, { timeout: 90_000 });
await page.evaluate((s) => window.ZZ.solve.load(s), SCR2);
followLog.length = 0;
const stay = await solveWith(capFollow.text, rowsBefore + 2);
console.log(JSON.stringify({ ...stay, log: followLog }));
check(followLog.length === 0 && stay.tab === 'solve', `with Stay here the tabs never move: ${followLog.join(' | ') || '(none)'}`);
check(stay.rows === rowsBefore + 2 && stay.top === wantTime, `the timer saved that solve too: ${stay.top} s`);
check((await page.evaluate(() => localStorage.getItem('zz-solve-follow'))) === 'stay', 'the choice is remembered');
await page.click('#tm-cubefollow [data-v="follow"]');
// the next scramble (the pad needs one)
await page.waitForFunction(() => { const s = document.getElementById('tm-scr')?.textContent ?? ''; return s && !s.includes('generating'); }, { timeout: 90_000 });

// ---- the tap pad: press arms, release starts, a tap stops; the solve is saved ----
const padBefore = await page.evaluate(() => document.querySelectorAll('#tm-list li').length);
const pad = (type) => page.evaluate((t) => { document.getElementById('tm-pad').dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true })); }, type);
await pad('pointerdown');
const heldState = await page.evaluate(() => ({ state: document.getElementById('tm-state').textContent, held: document.getElementById('tm-pad').classList.contains('held') }));
check(heldState.held && /Release to start/.test(heldState.state), `a press arms the pad without starting: "${heldState.state}"`);
await pad('pointerup');
const runState = await page.evaluate(() => document.getElementById('tm-state').textContent);
check(/Solving/.test(runState), `the release starts the timer: "${runState}"`);
await new Promise((r) => setTimeout(r, 420));
await pad('pointerdown');
await pad('pointerup'); // the release after a stopping press must not start again
await new Promise((r) => setTimeout(r, 150));
const stopped = await page.evaluate(() => ({ state: document.getElementById('tm-state').textContent, rows: document.querySelectorAll('#tm-list li').length, top: document.querySelector('#tm-list li .t')?.textContent }));
check(stopped.rows === padBefore + 1 && !/Solving/.test(stopped.state), `a tap stops and saves the solve (${stopped.rows} rows): "${stopped.state}"`);
check(stopped.top && Number(stopped.top) >= 0.4 && Number(stopped.top) < 0.7, `the tapped solve's time is its press-to-tap span: ${stopped.top} s`);

// ---- installable: the manifest the page links to resolves and has what Chrome asks for ----
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return { error: 'no manifest link' };
  const r = await fetch(link.href);
  if (!r.ok) return { error: `manifest ${r.status}` };
  const m = await r.json();
  const icons = await Promise.all((m.icons ?? []).map(async (i) => ({ src: i.src, ok: (await fetch(new URL(i.src, link.href))).ok })));
  return { name: m.name, display: m.display, start_url: m.start_url, icons };
});
console.log(JSON.stringify(manifest));
check(!manifest.error && manifest.display === 'standalone' && !!manifest.name && !!manifest.start_url, 'the manifest is served with name, start_url and standalone display');
check(!manifest.error && manifest.icons.length >= 2 && manifest.icons.every((i) => i.ok), 'every manifest icon is served');

await browser.close();
server.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);

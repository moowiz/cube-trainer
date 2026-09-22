// Headless check of a recording end to end: starts the dev server (which has
// the sink), opens the page in headless Chrome with a fake camera, records
// for a few seconds, stops, and checks that a session folder appeared under
// <repo>/recordings/ with the video chunks, the scanner's evidence.json and a
// closed meta file. The folder is removed afterwards. Two entrances:
//
//   npm run check:record   the header Record button (src/app/record.ts) on the
//                          Solve tab: it exists only where the sink answers, and
//                          the scan sheet must come up docked as the live view
//   npm run check:rig      the scan sheet's own Record button (the rig,
//                          docs/smart-cube-design.md 4.2): --rig
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { devServer, launchBrowser, webDir } from './headless.mjs';

const rig = process.argv.includes('--rig');
const recordings = join(webDir, '..', 'recordings');
const PORT = rig ? 5198 : 5199;
const before = new Set(existsSync(recordings) ? readdirSync(recordings) : []);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await devServer(PORT);
check(server.up, 'the dev server is up and has the recording sink');

const browser = await launchBrowser({ ignoreHTTPSErrors: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || /CAPTURED|recordings|rig|record/i.test(m.text())) console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
  page.on('response', (r) => { if (r.status() >= 400) r.text().then((t) => console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()} :: ${t.slice(0, 200)}`), () => console.log(`[http ${r.status()}] ${r.url()}`)); });
  page.on('requestfailed', (r) => console.log(`[request failed] ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  if (rig) {
    await page.goto(`${server.origin}/?tab=scan`, { waitUntil: 'networkidle0', timeout: 120_000 });
    // Record needs the live camera: wait until the (fake) camera is actually delivering frames
    await page.waitForFunction(() => { const b = document.querySelector('.sc-rec'); return b && !b.disabled; }, { timeout: 60_000 });
    // the scanner draws frames to a canvas (no <video> in the DOM): the pipeline's own status text says when it runs
    await page.waitForFunction(() => /hold the cube in view|Locked|faces/.test(document.getElementById('scan-panel')?.innerText ?? ''), { timeout: 60_000 });
    await sleep(1500);
    await page.evaluate(() => document.querySelector('.sc-rec').click()); // the element itself: a headless mouse click lands on an overlay at the button's centre
    await sleep(3500);
    const state = await page.evaluate(() => document.querySelector('.sc-recState')?.textContent ?? '');
    const msg = await page.evaluate(() => document.querySelector('.sc-msg')?.textContent ?? '');
    check(/^REC/.test(state), `recording runs: "${state}"${msg ? ` (message: "${msg}")` : ''}`);
    await page.evaluate(() => document.querySelector('.sc-rec').click());
    // the stop handler downloads or streams, then fires the capture 800 ms later; give the sink a moment
    await page.waitForFunction(() => /streamed to recordings|saved /.test(document.querySelector('.sc-recState')?.textContent ?? ''), { timeout: 20_000 });
    const after = await page.evaluate(() => document.querySelector('.sc-recState')?.textContent ?? '');
    check(/streamed to recordings\//.test(after), `the recording streamed to the rig: "${after}"`);
    await sleep(4000);
  } else {
    await page.goto(`${server.origin}/?tab=solve`, { waitUntil: 'networkidle0', timeout: 120_000 });
    await page.waitForFunction(() => { const b = document.getElementById('rec-open'); return b && !b.hidden; }, { timeout: 60_000 });
    check(true, 'the header Record button appears (the sink answered)');
    await page.evaluate(() => document.getElementById('rec-open').click());
    await sleep(3500);
    const state = await page.evaluate(() => document.getElementById('rec-open')?.textContent ?? '');
    const previewUp = await page.evaluate(() => { const s = document.getElementById('scan-sheet'); return !s.hidden && s.classList.contains('docked'); });
    check(/REC \d+ s/.test(state), `recording runs: "${state.trim()}"`);
    check(previewUp, 'the scan sheet is up, docked, as the live view');
    await page.evaluate(() => document.getElementById('rec-open').click());
    await page.waitForFunction(() => /Record$/.test(document.getElementById('rec-open')?.textContent?.trim() ?? ''), { timeout: 20_000 });
    // the toast comes once the rig's stop has flushed its uploads, a moment after the label
    const toast = await page.waitForFunction(() => { const t = document.getElementById('toast')?.textContent ?? ''; return /Recorded \d+ s to recordings\//.test(t) ? t : null; }, { timeout: 20_000 }).then((h) => h.jsonValue(), () => '');
    check(/Recorded \d+ s to recordings\//.test(toast), `the toast names the session: "${toast}"`);
    await sleep(2000);
  }
} finally {
  await browser.close();
  server.close();
}

const fresh = (existsSync(recordings) ? readdirSync(recordings) : []).filter((d) => !before.has(d));
check(fresh.length === 1, `one new session folder: ${fresh.join(', ') || 'none'}`);
if (fresh.length === 1) {
  const dir = join(recordings, fresh[0]);
  const files = readdirSync(dir);
  console.log(`${fresh[0]}: ${files.map((f) => `${f} ${statSync(join(dir, f)).size} B`).join(', ')}`);
  check(files.includes('video.webm') && statSync(join(dir, 'video.webm')).size > 10_000, 'video.webm holds the streamed chunks');
  check(files.includes('evidence.json') && statSync(join(dir, 'evidence.json')).size > 100, 'evidence.json: the recording went through the scanner');
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* missing */ }
  // (one recorder since 2026-09-19: the header button records through the scanner, so the meta carries no note of which button)
  check(meta && meta.version === 2 && meta.chunks >= 2 && typeof meta.endedAt === 'number' && meta.failed === 0, `meta.json is closed: ${meta ? `${meta.chunks} chunks, failed ${meta.failed}, ended ${!!meta.endedAt}` : 'missing'}`);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);

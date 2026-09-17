// Headless check of the recording rig end to end (docs/smart-cube-design.md
// 4.2): starts the dev server (which has the sink), opens the scan sheet in
// headless Chrome with a fake camera, presses Record, waits, presses Stop,
// and checks that a session folder appeared under <repo>/recordings/ with
// the video chunks, the evidence log and a closed meta file. The folder
// is removed afterwards.
//
//   node scripts/check-rig.mjs
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordings = join(webDir, '..', 'recordings');
const puppeteerPkg = resolve(webDir, '..', 'model', 'gen', 'node_modules', 'puppeteer');
const { default: puppeteer } = await import(pathToFileURL(join(puppeteerPkg, 'lib', 'esm', 'puppeteer', 'puppeteer.js')).href);

const PORT = 5198;
const before = new Set(existsSync(recordings) ? readdirSync(recordings) : []);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the dev server, with the sink
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(1000);
  try { const r = await fetch(`https://localhost:${PORT}/__recording/`, { dispatcher: undefined }); up = r.ok; } catch { /* not yet */ }
}
if (!up) {
  // node's fetch refuses the self-signed certificate: probe through curl instead
  const { execSync } = await import('node:child_process');
  try { up = execSync(`curl -sk https://localhost:${PORT}/__recording/`, { encoding: 'utf8' }).includes('"ok":true'); } catch { up = false; }
}
check(up, 'the dev server is up and has the recording sink');

const browser = await puppeteer.launch({ headless: true, ignoreHTTPSErrors: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || /CAPTURED|recordings|rig|record/i.test(m.text())) console.log(`[page ${m.type()}]`, m.text().slice(0, 300)); });
  page.on('response', (r) => { if (r.status() >= 400) r.text().then((t) => console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()} :: ${t.slice(0, 200)}`), () => console.log(`[http ${r.status()}] ${r.url()}`)); });
  page.on('requestfailed', (r) => console.log(`[request failed] ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.goto(`https://localhost:${PORT}/?tab=scan`, { waitUntil: 'networkidle0', timeout: 120_000 });
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
  await page.evaluate(() => document.querySelector('.sc-rec').click()); // the element itself: a headless mouse click lands on an overlay at the button's centre
  // the stop handler downloads or streams, then fires the capture 800 ms later; give the sink a moment
  await page.waitForFunction(() => /streamed to recordings|saved /.test(document.querySelector('.sc-recState')?.textContent ?? ''), { timeout: 20_000 });
  const after = await page.evaluate(() => document.querySelector('.sc-recState')?.textContent ?? '');
  check(/streamed to recordings\//.test(after), `the recording streamed to the rig: "${after}"`);
  await sleep(4000);
} finally {
  await browser.close();
  vite.kill();
  try { const { execSync } = await import('node:child_process'); if (process.platform === 'win32') execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /F /PID %a`, { stdio: 'ignore', shell: 'cmd.exe' }); } catch { /* already gone */ }
}

const fresh = (existsSync(recordings) ? readdirSync(recordings) : []).filter((d) => !before.has(d));
check(fresh.length === 1, `one new session folder: ${fresh.join(', ') || 'none'}`);
if (fresh.length === 1) {
  const dir = join(recordings, fresh[0]);
  const files = readdirSync(dir);
  console.log(`${fresh[0]}: ${files.map((f) => `${f} ${statSync(join(dir, f)).size} B`).join(', ')}`);
  check(files.includes('video.webm') && statSync(join(dir, 'video.webm')).size > 10_000, 'video.webm holds the streamed chunks');
  check(files.includes('evidence.json') && statSync(join(dir, 'evidence.json')).size > 100, 'evidence.json was written at stop');
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* missing */ }
  check(meta && meta.version === 2 && meta.chunks >= 2 && typeof meta.endedAt === 'number' && meta.failed === 0, `meta.json is closed: ${meta ? `${meta.chunks} chunks, failed ${meta.failed}, ended ${!!meta.endedAt}` : 'missing'}`);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);

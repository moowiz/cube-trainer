// What the headless checks share (docs/maintenance-plan.md 4.6): the browser,
// a static server over web/dist, and the dev server with its sinks.
//
//   check-detect.mjs   the detector in the browser         serveDist
//   check-smart.mjs    the smart-cube path, replayed        serveDist
//   check-record.mjs   the recording rig (--rig: the scan sheet's own button)   devServer
//
// puppeteer is a web devDependency (it was borrowed from model/gen, so the
// checks failed on a clean clone). PUPPETEER_SHELL=1 launches the headless
// shell, which is what runs inside the WSL sandbox (docs/wsl-sandbox.md).
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

export const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Headless Chrome; `args` are added to the launch. */
export function launchBrowser(opts = {}) {
  return puppeteer.launch({ headless: process.env.PUPPETEER_SHELL ? 'shell' : true, ...opts });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** web/dist over loopback on a free port. Exits when there is no build. Returns { origin, close }. */
export async function serveDist() {
  const dist = join(webDir, 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('web/dist/index.html missing - run `npm run build` first');
    process.exit(1);
  }
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
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The vite dev server (https, with the capture and recording sinks) on `port`; resolves once
 * /__recording/ answers, up to a minute. Returns { origin, up, close }.
 */
export async function devServer(port) {
  const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try { const r = await fetch(`https://localhost:${port}/__recording/`, { dispatcher: undefined }); up = r.ok; } catch { /* not yet */ }
  }
  if (!up) {
    // node's fetch refuses the self-signed certificate: probe through curl instead
    try { up = execSync(`curl -sk https://localhost:${port}/__recording/`, { encoding: 'utf8' }).includes('"ok":true'); } catch { up = false; }
  }
  const close = () => {
    vite.kill();
    try { if (process.platform === 'win32') execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, { stdio: 'ignore', shell: 'cmd.exe' }); } catch { /* already gone */ }
  };
  return { origin: `https://localhost:${port}`, up, close };
}

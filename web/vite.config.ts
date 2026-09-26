/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Build stamp shown on the scan tab so a phone can tell which deploy it has.
function gitHash(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7); }
}
const BUILD = { hash: gitHash(), time: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' };

// version.json: the build stamp plus the deployed detector runs (the `run` field of each model's
// sidecar), served in dev and emitted into dist. nav.js shows it in the corner of every page.
function versionStamp(): Plugin {
  const body = () => {
    const models: Record<string, string> = {};
    for (const f of ['cubebox', 'facekp']) {
      try { models[f] = JSON.parse(readFileSync(p(`./public/models/${f}.json`), 'utf8')).run ?? '?'; }
      catch { models[f] = 'none'; }
    }
    return JSON.stringify({ ...BUILD, models });
  };
  return {
    name: 'version-stamp',
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body()); });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: body() }); },
  };
}

// Dev-only capture sink for headless clip replays (?tab=scan&clip=...&post=1):
// the page POSTs its debug capture here and it lands in the evidence
// fixtures folder, no download dialog involved.
function captureSink(): Plugin {
  return {
    name: 'capture-sink',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const url = new URL(req.url ?? '/', 'http://x');
        const name = (url.searchParams.get('name') ?? `capture-${Date.now()}.json`).replace(/[^A-Za-z0-9._-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = p('./test/fixtures/evidence/');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), Buffer.concat(chunks));
          res.statusCode = 200;
          res.end(name);
        });
      });
    },
  };
}

// Dev-only recording sink (docs/smart-cube-design.md 4.2): the page streams a
// session's video chunks, cube events and captures here, one small POST at
// a time, and they land under <repo>/recordings/<session>/ (gitignored), so
// a crash loses nothing and the browser never holds a whole recording.
//   GET  /__recording/                       -> 200 {ok, dir}   (the page probes this; 404 on Pages)
//   POST /__recording/<session>/<file>       -> overwrite
//   POST /__recording/<session>/<file>?append=1 -> append
// Names are [A-Za-z0-9._-]; anything else is 400.
function recordingSink(): Plugin {
  const NAME = /^[A-Za-z0-9._-]{1,120}$/;
  const root = p('../recordings/');
  return {
    name: 'recording-sink',
    configureServer(server) {
      server.middlewares.use('/__recording', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, dir: root }));
          return;
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 2 || !NAME.test(parts[0]!) || !NAME.test(parts[1]!)) { res.statusCode = 400; res.end('bad name'); return; }
        const dir = join(root, parts[0]!);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, parts[1]!);
        const append = url.searchParams.get('append') === '1';
        // read the whole body, then one write: works the same over HTTP/1.1 (curl) and HTTP/2 (the browser)
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          try { (append ? appendFileSync : writeFileSync)(file, body); res.statusCode = 200; res.end('ok'); }
          catch (err) { res.statusCode = 500; res.end(String(err)); return; }
          // the session closed (its meta carries endedAt): one clip per timed solve, in the background
          if (parts[1] === 'meta.json' && /"endedAt"\s*:\s*\d/.test(body.toString('utf8'))) {
            import('./scripts/cut-solves.mjs')
              .then((m) => m.cutSolves(dir, { log: (line: string) => server.config.logger.info(`[recording] ${line}`) }))
              .then((w) => { if (w.length) server.config.logger.info(`[recording] ${parts[0]}: ${w.length} solve clip(s) in solves/`); })
              .catch((err) => server.config.logger.warn(`[recording] ${parts[0]}: solve clips not cut: ${err instanceof Error ? err.message : err}`));
          }
        });
        req.on('error', (err) => { res.statusCode = 500; res.end(String(err)); });
      });
    },
  };
}

// onnxruntime-web's library code holds `new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url)`
// as a fallback for when no wasmPaths is configured, and Vite dutifully emits the 28 MB file as a
// hashed asset. Both session.ts and ort.worker.ts set wasmPaths to /ort/ (scripts/copy-ort.mjs
// puts the runtime there), so the runtime's own locateFile wins and the asset is never fetched:
// drop it from the bundle rather than ship the wasm twice (docs/maintenance-plan.md 2.1).
function dropBundledOrtWasm(): Plugin {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_opts, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm-simd-threaded.*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  // GitHub Pages serves project sites from /<repo>/ — the deploy workflow
  // sets BASE_PATH accordingly. Local dev and plain builds stay at '/'.
  base: process.env.BASE_PATH ?? '/',
  // HTTPS: camera access requires a secure context on phones.
  plugins: [basicSsl(), captureSink(), recordingSink(), versionStamp(), dropBundledOrtWasm()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        main: p('index.html'),
        label: p('label.html'),
        signin: p('signin.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // the smart cube library's ESM bundle names aes-js's exports, which Node's CJS interop refuses;
    // through vite's transform (as in the browser build) it loads
    server: { deps: { inline: ['smartcube-web-bluetooth'] } },
  },
});

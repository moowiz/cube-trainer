/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
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

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  // GitHub Pages serves project sites from /<repo>/ — the deploy workflow
  // sets BASE_PATH accordingly. Local dev and plain builds stay at '/'.
  base: process.env.BASE_PATH ?? '/',
  // HTTPS: camera access requires a secure context on phones.
  plugins: [basicSsl(), captureSink()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        main: p('index.html'),
        label: p('label.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

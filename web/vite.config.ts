/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Build stamp shown on the scan page so a phone can tell which deploy it has.
function gitHash(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7); }
}
const BUILD = { hash: gitHash(), time: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' };

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  // GitHub Pages serves project sites from /<repo>/ — the deploy workflow
  // sets BASE_PATH accordingly. Local dev and plain builds stay at '/'.
  base: process.env.BASE_PATH ?? '/',
  // HTTPS: camera access requires a secure context on phones.
  plugins: [basicSsl()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        main: p('index.html'),
        scan: p('scan.html'),
        label: p('label.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
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
        scanner: p('scanner.html'),
        detect: p('detect.html'),
        autoscan: p('autoscan.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

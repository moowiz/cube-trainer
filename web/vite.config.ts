/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  // HTTPS: camera access requires a secure context on phones.
  plugins: [basicSsl()],
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        main: p('index.html'),
        scanner: p('scanner.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

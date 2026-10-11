import { defineConfig } from 'vitest/config';

const SERVER = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': SERVER,
      '/card': SERVER,
      '/r/': SERVER,
      '/arena': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

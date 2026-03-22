import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))]
    },
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true
  }
});

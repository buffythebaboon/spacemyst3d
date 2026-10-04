import { defineConfig } from 'vite'

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:2567', ws: true } },
  },
})

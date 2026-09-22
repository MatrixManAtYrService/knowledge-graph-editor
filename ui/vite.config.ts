import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs: the same build is served at / by the kge server and
  // from a subpath (e.g. GitHub Pages project sites) by the static export.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8151',
      '/health': 'http://localhost:8151',
    },
  },
  build: {
    outDir: 'dist',
  },
})

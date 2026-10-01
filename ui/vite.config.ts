import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The bundled DuckDB-Wasm version: the wasm binary isn't bundled (too big
// for git), so the app fetches the matching one by version (duck.ts).
const duckdbVersion: string = JSON.parse(
  readFileSync(new URL('./node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8'),
).version

export default defineConfig({
  // Relative asset URLs: the same build is served at / by the kge server and
  // from a subpath (e.g. GitHub Pages project sites) by the static export.
  base: './',
  plugins: [react()],
  define: { __DUCKDB_VERSION__: JSON.stringify(duckdbVersion) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8151',
      '/data': 'http://localhost:8151',
      '/duckdb': 'http://localhost:8151',
      '/health': 'http://localhost:8151',
    },
  },
  build: {
    outDir: 'dist',
  },
})

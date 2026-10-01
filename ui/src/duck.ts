// DuckDB-Wasm, ebb_profile_viz's pattern: booted lazily on first query,
// and given parquet files as HTTP-backed virtual files — a query like
// `WHERE key IN (...)` then range-requests only the row groups whose min/max
// stats cover those keys. Every graph read goes through here, in the live
// editor and on static exports alike (static.ts).
//
// The JS (module, worker) is bundled with the app; the ~35 MB wasm binary
// isn't (it would bloat git with every bump). Where it comes from is the
// data source's call: the live server serves a copy it fetched once into
// its cache (data/graphs.json says where — see setWasmBase), so the editor
// works offline and behind CDN-blocking networks; a static export has no
// server, and its visitors fetch the binary from the CDN.

import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

const WASM = 'duckdb-eh.wasm'
let wasmUrl = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${__DUCKDB_VERSION__}/dist/${WASM}`

/** Serve the wasm from `base` (a site-relative dir holding one subdir per
 * DuckDB version) instead of the CDN. Must run before the first query. */
export function setWasmBase(base: string): void {
  wasmUrl = new URL(`${base}${__DUCKDB_VERSION__}/${WASM}`, new URL('.', window.location.href)).href
}

interface Duck {
  duckdb: typeof import('@duckdb/duckdb-wasm')
  database: import('@duckdb/duckdb-wasm').AsyncDuckDB
  conn: import('@duckdb/duckdb-wasm').AsyncDuckDBConnection
}

let duckPromise: Promise<Duck> | null = null
const registered = new Set<string>()

function boot(): Promise<Duck> {
  if (duckPromise) return duckPromise
  duckPromise = (async () => {
    const t0 = performance.now()
    const duckdb = await import('@duckdb/duckdb-wasm')
    const worker = new Worker(workerUrl)
    const database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
    // The eh (wasm exceptions) build only: every current browser has them.
    await database.instantiate(wasmUrl)
    // Never fall back to downloading a whole parquet file: range requests
    // only (the point of windowed loading). Static hosts that matter —
    // GitHub Pages included — support Range, and so does the kge server.
    await database.open({ path: ':memory:', filesystem: { allowFullHTTPReads: false } })
    const conn = await database.connect()
    // Cache parquet footers across queries — without this every query
    // re-downloads the file metadata, which dwarfs the row groups it reads.
    await conn.query('SET enable_object_cache=true').catch(() => {})
    // Named timings for scripts/ui_timing.py --resources (the worker's own
    // fetches are invisible to the page's resource timings).
    performance.measure('duck:boot', { start: t0 })
    return { duckdb, database, conn }
  })()
  return duckPromise
}

/** Make a parquet file queryable by its site-relative path ('data/<g>/nodes.parquet'). */
export async function registerParquet(name: string): Promise<void> {
  const { duckdb, database } = await boot()
  if (registered.has(name)) return
  registered.add(name)
  const url = new URL(name, new URL('.', window.location.href)).href
  await database.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false)
}

/** Run one query, rows as plain objects. */
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  const { conn } = await boot()
  const t0 = performance.now()
  const res = await conn.query(sql)
  performance.measure('duck:query', { start: t0 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.toArray().map((row: any) => (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }))
}

/** SQL string literal. */
export const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

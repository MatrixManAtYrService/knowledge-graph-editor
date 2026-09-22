// DuckDB-Wasm, ebb_profile_viz's pattern: booted lazily on first query so
// page-open never pays the multi-MB wasm download, loaded from a pinned CDN
// build, and given parquet files as HTTP-backed virtual files — a query like
// `WHERE key IN (...)` then range-requests only the row groups whose min/max
// stats cover those keys. This module is only reached in static windowed
// mode (big graphs); the editor and inline-mode sites never import duckdb.

// Pinned, known-good DuckDB-Wasm (avoids the withdrawn 1.3.3/1.29.2 builds).
const DUCKDB_ESM = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm'

interface Duck {
  // The duckdb-wasm module has no local types (CDN dynamic import).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  duckdb: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any
}

let duckPromise: Promise<Duck> | null = null
const registered = new Set<string>()

function boot(): Promise<Duck> {
  if (duckPromise) return duckPromise
  duckPromise = (async () => {
    const duckdb = await import(/* @vite-ignore */ DUCKDB_ESM)
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    )
    const worker = new Worker(workerUrl)
    const database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker)
    URL.revokeObjectURL(workerUrl)
    // Never fall back to downloading a whole parquet file: range requests
    // only (the point of windowed mode). Static hosts that matter — GitHub
    // Pages included — support Range.
    await database.open({ path: ':memory:', filesystem: { allowFullHTTPReads: false } })
    const conn = await database.connect()
    // Cache parquet footers across queries — without this every query
    // re-downloads the file metadata, which dwarfs the row groups it reads.
    await conn.query('SET enable_object_cache=true').catch(() => {})
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
  const res = await conn.query(sql)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.toArray().map((row: any) => (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }))
}

/** SQL string literal. */
export const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

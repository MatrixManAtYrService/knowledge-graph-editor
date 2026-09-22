// Read-only static mode: the same app, but its data source is a directory
// of files written by `kge export` (see src/kge/export.py) instead of the
// kge server. The exported index.html sets window.KGE_STATIC before the app
// module loads — that global is the whole mode switch.
//
// Two data layouts, chosen per graph by the exporter:
//
// Inline (small graphs): graph.json carries every node and edge with *lite*
// data; the full `data` of item N lives in JSON shards fetched when the
// item is inspected. One fetch shows everything; no wasm.
//
// Windowed (big graphs): graph.json carries only schema, views, aggregate
// counts, and the skewer subgraph; nodes/edges live in parquet files that
// DuckDB-Wasm queries over HTTP range requests (duck.ts). The store then
// holds just the *loaded* subset, and ensureViewLoaded keeps the invariant
// the rest of the app relies on: loaded ⊇ whatever the view shows. Focus
// BFS hops on the per-node `adj` column (point reads by key); no-focus
// views load whole included types (a contiguous range in the (type, id)-
// sorted file); everything else the view names by id is point-read.
//
// In both modes every node/edge has an integer — its row/array index — used
// by the share URLs (share.ts) and the lazy detail lookups.

import { query, registerParquet, sqlStr } from './duck'
import { SKEWER_EDGE, SKEWER_TYPE } from './graph'
import type { EdgeT, GraphInfo, GraphPayload, NodeT, Sel, View } from './types'
import { edgeKey } from './types'

declare global {
  interface Window {
    KGE_STATIC?: boolean
  }
}

export const STATIC_MODE: boolean =
  typeof window !== 'undefined' && window.KGE_STATIC === true

interface DetailMeta {
  shardSize: number
  nodeShards: number[] // shard files that actually exist (empty ones are not written)
  edgeShards: number[]
}

interface StoreBlock {
  mode: 'parquet'
  rowGroup: number
  nodes: number
  edges: number
  files: { nodes: string; edges: string; ids?: string }
  typeCounts: Record<string, number>
  edgeTypeCounts: Record<string, number>
  colorCounts: Record<string, number>
  skewers: { nodes: [number, NodeT][]; edges: [number, EdgeT][] }
}

/** [edgeKey, otherNodeKey, edgeType, otherNodeType, outgoing] — one
 * adjacency entry; `outgoing` = 1 when this node is the edge's source. */
type AdjEntry = [number, number, string, string, number]

export interface StaticTotals {
  nodes: number
  edges: number
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  colors: Record<string, number>
}

/** Everything static mode knows about the currently loaded graph. */
export interface StaticGraph {
  graphId: string
  mode: 'inline' | 'parquet'
  payload: GraphPayload // the live object the store holds (shared arrays)
  pristine: GraphPayload // deep copy of the saved state, for URL diffing
  totals: StaticTotals | null // windowed mode: what exists vs what's loaded
  nodeIdOf(i: number): string | undefined
  nodeTypeOf(i: number): string | undefined
  edgeKeyOf(i: number): string | undefined
  intOfNode(id: string): number | undefined
  intOfEdge(key: string): number | undefined
}

interface InlineState {
  meta: DetailMeta
  fetched: { node: Set<number>; edge: Set<number> }
  nodeIds: string[]
  edgeKeys: string[]
  nodeInt: Map<string, number>
  edgeInt: Map<string, number>
}

interface WindowedState {
  files: { nodes: string; edges: string; ids?: string }
  rowGroup: number // the export's parquet row-group size (the fetch unit)
  loadedNodes: Map<number, NodeT> // key -> node (insertion-ordered, resorted on publish)
  loadedEdges: Map<number, EdgeT>
  nodeGroups: Set<number> // row groups already pulled (whole-group caching)
  edgeGroups: Set<number>
  idByInt: Map<number, string>
  keyByInt: Map<number, string>
  nodeIntById: Map<string, number>
  edgeIntByKey: Map<string, number>
  adj: Map<number, AdjEntry[]>
  fullTypes: Set<string> // node types known to be fully loaded
  detail: { node: Set<number>; edge: Set<number> } // full-data fetches done
}

let current: (StaticGraph & { inline?: InlineState; windowed?: WindowedState }) | null = null
export const staticGraph = (): StaticGraph | null => current

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`GET ${url} failed: ${resp.status}`)
  return resp.json()
}

export async function staticFetchGraphs(): Promise<GraphInfo[]> {
  const raw = (await getJson('data/graphs.json')) as { graphs: GraphInfo[] }
  return raw.graphs
}

export async function staticFetchGraph(graphId: string): Promise<GraphPayload> {
  const raw = (await getJson(`data/${encodeURIComponent(graphId)}/graph.json`)) as {
    schema: GraphPayload['schema']
    views: View[]
    nodes?: NodeT[]
    edges?: EdgeT[]
    detail?: DetailMeta
    store?: StoreBlock
  }
  if (raw.nodes && raw.edges) {
    const payload: GraphPayload = {
      schema: raw.schema,
      nodes: raw.nodes,
      edges: raw.edges,
      views: raw.views,
    }
    const inline: InlineState = {
      meta: raw.detail ?? { shardSize: 64, nodeShards: [], edgeShards: [] },
      fetched: { node: new Set(), edge: new Set() },
      nodeIds: payload.nodes.map((n) => n.id),
      edgeKeys: payload.edges.map(edgeKey),
      nodeInt: new Map(payload.nodes.map((n, i) => [n.id, i])),
      edgeInt: new Map(payload.edges.map((e, i) => [edgeKey(e), i])),
    }
    current = {
      graphId,
      mode: 'inline',
      payload,
      pristine: structuredClone(payload),
      totals: null,
      inline,
      nodeIdOf: (i) => inline.nodeIds[i],
      nodeTypeOf: (i) => payload.nodes[i]?.type,
      edgeKeyOf: (i) => inline.edgeKeys[i],
      intOfNode: (id) => inline.nodeInt.get(id),
      intOfEdge: (key) => inline.edgeInt.get(key),
    }
    return payload
  }

  const block = raw.store
  if (!block || block.mode !== 'parquet') {
    throw new Error(`graph ${graphId}: unrecognized static data layout`)
  }
  const payload: GraphPayload = { schema: raw.schema, nodes: [], edges: [], views: raw.views }
  const w: WindowedState = {
    files: {
      nodes: `data/${graphId}/${block.files.nodes}`,
      edges: `data/${graphId}/${block.files.edges}`,
      ids: block.files.ids ? `data/${graphId}/${block.files.ids}` : undefined,
    },
    rowGroup: block.rowGroup || 256,
    loadedNodes: new Map(),
    loadedEdges: new Map(),
    nodeGroups: new Set(),
    edgeGroups: new Set(),
    idByInt: new Map(),
    keyByInt: new Map(),
    nodeIntById: new Map(),
    edgeIntByKey: new Map(),
    adj: new Map(),
    fullTypes: new Set(),
    detail: { node: new Set(), edge: new Set() },
  }
  // The skewer subgraph rides in whole: rails, bundles, and spacing actions
  // need every membership edge, and rails are curated (small).
  for (const [key, node] of block.skewers.nodes) {
    w.loadedNodes.set(key, node)
    w.idByInt.set(key, node.id)
    w.nodeIntById.set(node.id, key)
  }
  for (const [key, edge] of block.skewers.edges) {
    w.loadedEdges.set(key, edge)
    const k = edgeKey(edge)
    w.keyByInt.set(key, k)
    w.edgeIntByKey.set(k, key)
  }
  current = {
    graphId,
    mode: 'parquet',
    payload,
    pristine: structuredClone(payload),
    totals: {
      nodes: block.nodes,
      edges: block.edges,
      nodeTypes: block.typeCounts,
      edgeTypes: block.edgeTypeCounts,
      colors: block.colorCounts,
    },
    windowed: w,
    nodeIdOf: (i) => w.idByInt.get(i),
    nodeTypeOf: (i) => w.loadedNodes.get(i)?.type,
    edgeKeyOf: (i) => w.keyByInt.get(i),
    intOfNode: (id) => w.nodeIntById.get(id),
    intOfEdge: (key) => w.edgeIntByKey.get(key),
  }
  publishLoaded()
  return payload
}

// -- windowed loading ----------------------------------------------------------

const CHUNK = 400 // max items per IN (...) query

const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
  return out
}

const parseJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Rebuild the payload arrays from the loaded maps, in key order (the
 * export's (type, id) order, so sidebar item lists stay sorted). */
function publishLoaded(): void {
  const w = current?.windowed
  if (!current || !w) return
  current.payload.nodes = [...w.loadedNodes.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1])
  current.payload.edges = [...w.loadedEdges.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1])
}

async function loadNodeRows(where: string): Promise<number> {
  const w = current!.windowed!
  await registerParquet(w.files.nodes)
  const rows = await query(
    `SELECT key, id, type, label, lite, adj FROM '${w.files.nodes}' WHERE ${where}`,
  )
  let added = 0
  for (const r of rows) {
    const key = Number(r.key)
    if (w.loadedNodes.has(key)) continue
    const node: NodeT = {
      id: String(r.id),
      type: String(r.type),
      label: String(r.label ?? ''),
      data: parseJson(r.lite),
    }
    w.loadedNodes.set(key, node)
    w.idByInt.set(key, node.id)
    w.nodeIntById.set(node.id, key)
    w.adj.set(key, (parseJson(r.adj) as unknown as AdjEntry[]) ?? [])
    added++
  }
  return added
}

async function loadEdgeRows(where: string): Promise<number> {
  const w = current!.windowed!
  await registerParquet(w.files.edges)
  const rows = await query(
    `SELECT key, type, src, dst, lite FROM '${w.files.edges}' WHERE ${where}`,
  )
  let added = 0
  for (const r of rows) {
    const key = Number(r.key)
    if (w.loadedEdges.has(key)) continue
    const edge: EdgeT = {
      type: String(r.type),
      from: String(r.src),
      to: String(r.dst),
      data: parseJson(r.lite),
    }
    w.loadedEdges.set(key, edge)
    const k = edgeKey(edge)
    w.keyByInt.set(key, k)
    w.edgeIntByKey.set(k, key)
    added++
  }
  return added
}

/** Row-group fetching (ebb's shard pattern): only simple range/equality
 * predicates push down into duckdb's parquet scan and prune via row-group
 * stats — `key IN (...)` does not, and scans the whole file. So integer
 * lookups load whole 256-row groups with BETWEEN (each group is a tight,
 * cacheable shard; its neighbors ride along for free). */
async function ensureNodeGroups(groupIds: Iterable<number>): Promise<number> {
  const w = current!.windowed!
  let added = 0
  for (const g of groupIds) {
    if (w.nodeGroups.has(g)) continue
    w.nodeGroups.add(g)
    const lo = g * w.rowGroup
    added += await loadNodeRows(`key BETWEEN ${lo} AND ${lo + w.rowGroup - 1}`)
  }
  return added
}

async function ensureNodesByInts(ints: number[]): Promise<number> {
  const w = current!.windowed!
  const groups = new Set(ints.filter((i) => !w.loadedNodes.has(i)).map((i) => Math.floor(i / w.rowGroup)))
  return ensureNodeGroups(groups)
}

async function ensureNodesByIds(ids: string[]): Promise<number> {
  const w = current!.windowed!
  const missing = [...new Set(ids.filter((id) => !w.nodeIntById.has(id)))].sort()
  if (!missing.length) return 0
  // Two-step via the id->key sidecar (sorted by id). Equality probes prune;
  // for longer lists a sorted chunk's BETWEEN window prunes nearly as well
  // and costs one query (extra rows are filtered out client-side).
  if (w.files.ids) {
    await registerParquet(w.files.ids)
    const wanted = new Set(missing)
    const keys: number[] = []
    if (missing.length <= 8) {
      for (const id of missing) {
        const rows = await query(`SELECT key FROM '${w.files.ids}' WHERE id = ${sqlStr(id)}`)
        for (const r of rows) keys.push(Number(r.key))
      }
    } else {
      for (const c of chunks(missing)) {
        const rows = await query(
          `SELECT id, key FROM '${w.files.ids}' WHERE id BETWEEN ${sqlStr(c[0])} AND ${sqlStr(c[c.length - 1])}`,
        )
        for (const r of rows) if (wanted.has(String(r.id))) keys.push(Number(r.key))
      }
    }
    return ensureNodesByInts(keys)
  }
  let added = 0
  for (const id of missing) added += await loadNodeRows(`id = ${sqlStr(id)}`)
  return added
}

async function ensureNodesByTypes(types: string[]): Promise<number> {
  const w = current!.windowed!
  let added = 0
  // Per-type equality: pushes down, and the (type, id) sort makes each type
  // one contiguous, prunable span of row groups.
  for (const t of types) {
    if (w.fullTypes.has(t) || (current!.totals?.nodeTypes[t] ?? 0) === 0) continue
    added += await loadNodeRows(`type = ${sqlStr(t)}`)
    w.fullTypes.add(t)
  }
  return added
}

async function ensureEdgesByInts(ints: number[]): Promise<number> {
  const w = current!.windowed!
  const groups = new Set(ints.filter((i) => !w.loadedEdges.has(i)).map((i) => Math.floor(i / w.rowGroup)))
  let added = 0
  for (const g of groups) {
    if (w.edgeGroups.has(g)) continue
    w.edgeGroups.add(g)
    const lo = g * w.rowGroup
    added += await loadEdgeRows(`key BETWEEN ${lo} AND ${lo + w.rowGroup - 1}`)
  }
  return added
}

async function ensureEdgesByKeyStrings(keys: string[]): Promise<number> {
  const w = current!.windowed!
  const missing = keys.filter((k) => !w.edgeIntByKey.has(k) && k.split('|').length === 3)
  let added = 0
  for (const k of missing) {
    const [type, src, dst] = k.split('|')
    added += await loadEdgeRows(
      `type = ${sqlStr(type)} AND src = ${sqlStr(src)} AND dst = ${sqlStr(dst)}`,
    )
  }
  return added
}

/** Point-load nodes/edges referenced by share-URL integers (share.ts calls
 * this before decoding a hash, so links into unloaded territory resolve). */
export async function ensureInts(nodeInts: number[], edgeInts: number[]): Promise<void> {
  if (current?.mode !== 'parquet') return
  const added = (await ensureNodesByInts(nodeInts)) + (await ensureEdgesByInts(edgeInts))
  if (added) publishLoaded()
}

/** Hard ceiling on nodes held in the browser at once: past this, the canvas
 * and the O(n²) layout helpers stop being a pleasant place. A view that
 * asks for more gets the first slice plus a status hint to focus/filter. */
export const WINDOWED_LOAD_CAP = 4000

export interface EnsureResult {
  added: boolean
  capped: boolean // true: the view wants more than the cap; a slice was loaded
}

/** The windowed invariant: make loaded ⊇ what `view` shows, loading as
 * little as possible — explicit ids point-read, foci resolved by BFS over
 * the adj column, no-focus views by whole included types, then one sweep
 * for edges joining loaded nodes. Over-approximates (eye banishes are
 * ignored); visibleSets does the exact filtering afterwards. The caller
 * republishes the store when `added`. */
export async function ensureViewLoaded(view: View): Promise<EnsureResult> {
  const sg = current
  const w = sg?.windowed
  if (!sg || !w) return { added: false, capped: false }
  let added = 0
  let capped = false
  const room = () => WINDOWED_LOAD_CAP - w.loadedNodes.size

  // 1. Everything the view names by id.
  const ids = new Set<string>()
  for (const f of view.foci ?? []) ids.add(f.node)
  for (const id of view.nodeOverrides ?? []) ids.add(id)
  for (const id of [...(view.focusShow ?? []), ...(view.focusHide ?? [])]) {
    if (!id.includes('|')) ids.add(id)
  }
  for (const e of sg.payload.edges) if (e.type === SKEWER_EDGE) ids.add(e.to) // rail members
  added += await ensureNodesByIds([...ids])
  added += await ensureEdgesByKeyStrings([
    ...(view.edgeOverrides ?? []),
    ...(view.focusShow ?? []).filter((k) => k.includes('|')),
    ...(view.focusHide ?? []).filter((k) => k.includes('|')),
  ])

  // The view's inclusion rules, in integer form.
  const nChecked = (t: string) => view.visibleNodeTypes === null || view.visibleNodeTypes.includes(t)
  const eChecked = (t: string) => view.visibleEdgeTypes === null || view.visibleEdgeTypes.includes(t)
  const nOvInts = new Set(
    (view.nodeOverrides ?? []).map((id) => w.nodeIntById.get(id)).filter((i): i is number => i !== undefined),
  )
  const eOvInts = new Set(
    (view.edgeOverrides ?? []).map((k) => w.edgeIntByKey.get(k)).filter((i): i is number => i !== undefined),
  )
  const nodeIncluded = (int: number, type: string) =>
    type !== SKEWER_TYPE && nChecked(type) !== nOvInts.has(int)
  const edgeConducts = (int: number, type: string) =>
    type !== SKEWER_EDGE && eChecked(type) !== eOvInts.has(int)

  // 2. What the rules reach. Foci count only when they are themselves
  // included (visibleSets ignores non-included foci — and shows everything
  // included when no focus survives).
  const foci = (view.foci ?? []).filter((f) => {
    const int = w.nodeIntById.get(f.node)
    const node = int !== undefined ? w.loadedNodes.get(int) : undefined
    return int !== undefined && node !== undefined && nodeIncluded(int, node.type)
  })
  if (foci.length) {
    bfs: for (const f of foci) {
      const start = w.nodeIntById.get(f.node)!
      const seen = new Set<number>([start])
      let frontier = [start]
      for (let depth = 0; depth < f.kHops && frontier.length; depth++) {
        const next = new Set<number>()
        for (const int of frontier) {
          for (const [eInt, oInt, eType, oType] of w.adj.get(int) ?? []) {
            if (!edgeConducts(eInt, eType)) continue
            if (!nodeIncluded(oInt, oType)) continue
            if (!seen.has(oInt)) next.add(oInt)
          }
        }
        let layer = [...next]
        if (layer.filter((i) => !w.loadedNodes.has(i)).length > room()) {
          capped = true
          layer = layer.filter((i) => w.loadedNodes.has(i)).concat(
            layer.filter((i) => !w.loadedNodes.has(i)).slice(0, Math.max(0, room())),
          )
        }
        added += await ensureNodesByInts(layer)
        for (const i of layer) seen.add(i)
        frontier = layer
        if (capped) break bfs
      }
    }
  } else {
    // Whole included types, largest-last, each only if it still fits: a
    // huge unfocused view yields a first slice and a hint, not a meltdown.
    const types = Object.keys(sg.payload.schema.nodeTypes)
      .filter((t) => t !== SKEWER_TYPE && nChecked(t))
      .sort((a, b) => (sg.totals?.nodeTypes[a] ?? 0) - (sg.totals?.nodeTypes[b] ?? 0))
    for (const t of types) {
      const count = sg.totals?.nodeTypes[t] ?? 0
      if (w.fullTypes.has(t) || count === 0) continue
      if (count > room()) {
        capped = true
        continue
      }
      added += await ensureNodesByTypes([t])
    }
  }

  // 3. Edge sweep: every edge joining two loaded nodes whose type could be
  // visible. Every shown edge qualifies (its endpoints are shown ⇒ loaded),
  // and the adj entries carry enough to synthesize them without touching
  // edges.parquet (non-skewer edges have no lite data; the full payload
  // stays a point read at inspect time).
  for (const [int, node] of w.loadedNodes) {
    for (const [eInt, oInt, eType, , outgoing] of w.adj.get(int) ?? []) {
      if (w.loadedEdges.has(eInt)) continue
      const other = w.loadedNodes.get(oInt)
      if (!other || !edgeConducts(eInt, eType)) continue
      const edge: EdgeT = outgoing
        ? { type: eType, from: node.id, to: other.id, data: {} }
        : { type: eType, from: other.id, to: node.id, data: {} }
      w.loadedEdges.set(eInt, edge)
      const k = edgeKey(edge)
      w.keyByInt.set(eInt, k)
      w.edgeIntByKey.set(k, eInt)
      added++
    }
  }

  if (added) publishLoaded()
  return { added: added > 0, capped }
}

// -- lazy full data ------------------------------------------------------------

/** Pull one item's full `data` payload and merge it into the live graph.
 * Inline mode fetches the covering JSON shard; windowed mode point-reads
 * the parquet `data` column. Returns true when data changed. */
export async function hydrateDetails(sel: Sel): Promise<boolean> {
  if (!current) return false
  const kind = sel.kind === 'edge' ? 'edge' : 'node'
  if (current.mode === 'parquet') {
    const w = current.windowed!
    const int = kind === 'node' ? w.nodeIntById.get(sel.id) : w.edgeIntByKey.get(sel.id)
    if (int === undefined || w.detail[kind].has(int)) return false
    w.detail[kind].add(int)
    try {
      const file = kind === 'node' ? w.files.nodes : w.files.edges
      await registerParquet(file)
      const rows = await query(`SELECT data FROM '${file}' WHERE key = ${int}`)
      const raw = rows[0]?.data
      if (typeof raw !== 'string' || !raw) return false // lite already covers it
      const target = kind === 'node' ? w.loadedNodes.get(int) : w.loadedEdges.get(int)
      if (!target) return false
      target.data = parseJson(raw)
      return true
    } catch {
      w.detail[kind].delete(int) // transient failure: allow a retry
      return false
    }
  }

  const inline = current.inline!
  const int = (kind === 'node' ? inline.nodeInt : inline.edgeInt).get(sel.id)
  if (int === undefined) return false
  const shard = Math.floor(int / inline.meta.shardSize)
  const present = kind === 'node' ? inline.meta.nodeShards : inline.meta.edgeShards
  if (inline.fetched[kind].has(shard) || !present.includes(shard)) return false
  inline.fetched[kind].add(shard)
  try {
    const entries = (await getJson(
      `data/${encodeURIComponent(current.graphId)}/${kind}-data-${shard}.json`,
    )) as Record<string, Record<string, unknown>>
    for (const [k, data] of Object.entries(entries)) {
      const target =
        kind === 'node' ? current.payload.nodes[Number(k)] : current.payload.edges[Number(k)]
      if (target) target.data = data
    }
    return true
  } catch {
    inline.fetched[kind].delete(shard)
    return false
  }
}

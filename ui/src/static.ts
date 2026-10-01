// The data layer: every graph is read the same way, whether from a directory
// of files written by `kge export` (see src/kge/export.py) or from the live
// server, which serves the same data/ URLs out of its parquet cache
// (src/kge/cache.py). What differs is only what the source allows:
// data/graphs.json lists `capabilities` (write, selection) — a live server
// grants them, an export grants none.
//
// One data layout for every graph, whatever its size: graph.json carries
// only schema, views, aggregate counts, and the skewer subgraph; nodes and
// edges live in parquet files that DuckDB-Wasm queries over HTTP range
// requests (duck.ts). The store holds just the *loaded* subset, and
// ensureViewLoaded keeps the invariant the rest of the app relies on:
// loaded ⊇ whatever the view shows. Focus BFS hops on the per-node `adj`
// column (point reads by key); no-focus views load whole included types (a
// contiguous range in the (type, id)-sorted file); everything else the
// view names by id is point-read via the sorted ids sidecar.
//
// Every node/edge has an integer — its parquet row index — used by the
// share URLs (share.ts) and the lazy detail lookups. Integers are only good
// for one version of the data: after a save the graph reloads, and anything
// held across it is held by id.
//
// The store's graph is the editable copy and the authority on what's in
// it: loads only *add* rows it hasn't seen (drainLoaded → share.ts), so a
// local delete stays deleted. `base` keeps each row as the server sent it;
// ops.ts diffs the store against it to save.

import { query, registerParquet, setWasmBase, sqlStr } from './duck'
import { SKEWER_EDGE, SKEWER_TYPE } from './graph'
import type { EdgeT, GraphInfo, GraphPayload, NodeT, Sel, View } from './types'
import { edgeKey } from './types'

/** What the data source allows; absent = no (a static export grants nothing). */
export interface Capabilities {
  write?: boolean // edits can be saved (POST /api/graphs/{id}/ops)
  selection?: boolean // the selection is published for agents (POST /api/selection)
}

let caps: Capabilities = {}
export const capabilities = (): Capabilities => caps

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

/** Everything the data layer knows about the currently loaded graph. */
export interface StaticGraph {
  graphId: string
  version: string // the data version loaded ('' from an export)
  generation: number // bumps on every (re)load, so watchers can tell
  pristine: GraphPayload // the saved schema + views (nodes/edges: see base)
  base: { nodes: Map<string, NodeT>; edges: Map<string, EdgeT> } // loaded rows as saved
  loaded(): { nodes: number; edges: number }
  totals: StaticTotals // what exists in the data vs what's loaded
  nodeIdOf(i: number): string | undefined
  nodeTypeOf(i: number): string | undefined
  edgeKeyOf(i: number): string | undefined
  intOfNode(id: string): number | undefined
  intOfEdge(key: string): number | undefined
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
  fresh: { nodes: NodeT[]; edges: EdgeT[] } // loaded but not yet handed to the store
}

/** One loaded version of a graph. A reload builds a new one in the
 * background and only then makes it current (share.ts), so the canvas
 * never sees a half-loaded graph. */
export type Loaded = StaticGraph & {
  windowed: WindowedState
  payload: GraphPayload // schema, views, and the rows loaded with them
}

let current: Loaded | null = null
let generation = 0
export const staticGraph = (): StaticGraph | null => current

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`GET ${url} failed: ${resp.status}`)
  return resp.json()
}

export async function staticFetchGraphs(): Promise<GraphInfo[]> {
  const raw = (await getJson('data/graphs.json')) as {
    graphs: GraphInfo[]
    capabilities?: Capabilities
    duckdbWasmBase?: string // where the server keeps DuckDB's wasm (duck.ts); absent: the CDN
  }
  caps = raw.capabilities ?? {}
  if (raw.duckdbWasmBase) setWasmBase(raw.duckdbWasmBase)
  return raw.graphs
}

/** Load and activate: what a plain (re)load does. */
export async function staticFetchGraph(graphId: string): Promise<GraphPayload> {
  const sg = await loadGraph(graphId)
  activate(sg)
  return sg.payload
}

export function activate(sg: Loaded): void {
  current = sg
}

/** Fetch a graph's current version, without making it current. */
export async function loadGraph(graphId: string): Promise<Loaded> {
  const raw = (await getJson(`data/${encodeURIComponent(graphId)}/graph.json`)) as {
    schema: GraphPayload['schema']
    views: View[]
    store?: StoreBlock
    version?: string
  }
  const block = raw.store
  if (!block || block.mode !== 'parquet') {
    throw new Error(`graph ${graphId}: unrecognized static data layout (re-run kge export)`)
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
    fresh: { nodes: [], edges: [] },
  }
  const base = { nodes: new Map<string, NodeT>(), edges: new Map<string, EdgeT>() }
  const sg: Loaded = {
    graphId,
    payload,
    version: raw.version ?? '',
    generation: ++generation,
    pristine: structuredClone(payload),
    base,
    loaded: () => ({ nodes: w.loadedNodes.size, edges: w.loadedEdges.size }),
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
  // The skewer subgraph rides in whole: rails, bundles, and spacing actions
  // need every membership edge, and rails are curated (small).
  for (const [key, node] of block.skewers.nodes) addNode(sg, key, node)
  for (const [key, edge] of block.skewers.edges) addEdge(sg, key, edge)
  const first = drainLoaded(sg)
  payload.nodes = first.nodes
  payload.edges = first.edges
  return sg
}

/** Record a newly loaded row: indexed, snapshotted as saved, queued for the store. */
function addNode(sg: Loaded, key: number, node: NodeT): void {
  const w = sg.windowed
  w.loadedNodes.set(key, node)
  w.idByInt.set(key, node.id)
  w.nodeIntById.set(node.id, key)
  sg.base.nodes.set(node.id, structuredClone(node))
  w.fresh.nodes.push(node)
}

function addEdge(sg: Loaded, key: number, edge: EdgeT): void {
  const w = sg.windowed
  w.loadedEdges.set(key, edge)
  const k = edgeKey(edge)
  w.keyByInt.set(key, k)
  w.edgeIntByKey.set(k, key)
  sg.base.edges.set(k, structuredClone(edge))
  w.fresh.edges.push(edge)
}

/** Rows loaded since the last call, for the store to merge in (share.ts). */
export function drainLoaded(sg: Loaded | null = current): { nodes: NodeT[]; edges: EdgeT[] } {
  const w = sg?.windowed
  if (!w) return { nodes: [], edges: [] }
  const out = w.fresh
  w.fresh = { nodes: [], edges: [] }
  return out
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

async function loadNodeRows(sg: Loaded, where: string): Promise<number> {
  const w = sg.windowed
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
    addNode(sg, key, node)
    w.adj.set(key, (parseJson(r.adj) as unknown as AdjEntry[]) ?? [])
    added++
  }
  return added
}

async function loadEdgeRows(sg: Loaded, where: string): Promise<number> {
  const w = sg.windowed
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
    addEdge(sg, key, edge)
    added++
  }
  return added
}

/** Row-group fetching (ebb's shard pattern): only simple range/equality
 * predicates push down into duckdb's parquet scan and prune via row-group
 * stats — `key IN (...)` does not, and scans the whole file. So integer
 * lookups load whole 256-row groups with BETWEEN (each group is a tight,
 * cacheable shard; its neighbors ride along for free). */
async function ensureNodeGroups(sg: Loaded, groupIds: Iterable<number>): Promise<number> {
  const w = sg.windowed
  let added = 0
  for (const g of groupIds) {
    if (w.nodeGroups.has(g)) continue
    w.nodeGroups.add(g)
    const lo = g * w.rowGroup
    added += await loadNodeRows(sg, `key BETWEEN ${lo} AND ${lo + w.rowGroup - 1}`)
  }
  return added
}

async function ensureNodesByInts(sg: Loaded, ints: number[]): Promise<number> {
  const w = sg.windowed
  const groups = new Set(ints.filter((i) => !w.loadedNodes.has(i)).map((i) => Math.floor(i / w.rowGroup)))
  return ensureNodeGroups(sg, groups)
}

async function ensureNodesByIds(sg: Loaded, ids: string[]): Promise<number> {
  const w = sg.windowed
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
    return ensureNodesByInts(sg, keys)
  }
  let added = 0
  for (const id of missing) added += await loadNodeRows(sg, `id = ${sqlStr(id)}`)
  return added
}

async function ensureNodesByTypes(sg: Loaded, types: string[]): Promise<number> {
  const w = sg.windowed
  let added = 0
  // Per-type equality: pushes down, and the (type, id) sort makes each type
  // one contiguous, prunable span of row groups.
  for (const t of types) {
    if (w.fullTypes.has(t) || (sg.totals?.nodeTypes[t] ?? 0) === 0) continue
    added += await loadNodeRows(sg, `type = ${sqlStr(t)}`)
    w.fullTypes.add(t)
  }
  return added
}

async function ensureEdgesByInts(sg: Loaded, ints: number[]): Promise<number> {
  const w = sg.windowed
  const groups = new Set(ints.filter((i) => !w.loadedEdges.has(i)).map((i) => Math.floor(i / w.rowGroup)))
  let added = 0
  for (const g of groups) {
    if (w.edgeGroups.has(g)) continue
    w.edgeGroups.add(g)
    const lo = g * w.rowGroup
    added += await loadEdgeRows(sg, `key BETWEEN ${lo} AND ${lo + w.rowGroup - 1}`)
  }
  return added
}

async function ensureEdgesByKeyStrings(sg: Loaded, keys: string[]): Promise<number> {
  const w = sg.windowed
  const missing = keys.filter((k) => !w.edgeIntByKey.has(k) && k.split('|').length === 3)
  let added = 0
  for (const k of missing) {
    const [type, src, dst] = k.split('|')
    added += await loadEdgeRows(sg, 
      `type = ${sqlStr(type)} AND src = ${sqlStr(src)} AND dst = ${sqlStr(dst)}`,
    )
  }
  return added
}

/** Point-load nodes/edges referenced by share-URL integers (share.ts calls
 * this before decoding a hash, so links into unloaded territory resolve). */
export async function ensureInts(
  nodeInts: number[],
  edgeInts: number[],
  sg: Loaded | null = current,
): Promise<void> {
  if (!sg) return
  await ensureNodesByInts(sg, nodeInts)
  await ensureEdgesByInts(sg, edgeInts)
}

/** Point-load nodes by id (and edges by edgeKey) — e.g. whatever pending
 * local edits touch, before replaying them onto a reloaded graph. */
export async function ensureIds(nodeIds: string[], edgeKeys: string[], sg: Loaded): Promise<void> {
  await ensureNodesByIds(sg, nodeIds)
  await ensureEdgesByKeyStrings(sg, edgeKeys)
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
export async function ensureViewLoaded(view: View, sg: Loaded | null = current): Promise<EnsureResult> {
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
  for (const e of w.loadedEdges.values()) if (e.type === SKEWER_EDGE) ids.add(e.to) // rail members
  added += await ensureNodesByIds(sg, [...ids])
  added += await ensureEdgesByKeyStrings(sg, [
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
        added += await ensureNodesByInts(sg, layer)
        for (const i of layer) seen.add(i)
        frontier = layer
        if (capped) break bfs
      }
    }
  } else {
    // Whole included types, largest-last, each only if it still fits: a
    // huge unfocused view yields a first slice and a hint, not a meltdown.
    const types = Object.keys(sg.pristine.schema.nodeTypes)
      .filter((t) => t !== SKEWER_TYPE && nChecked(t))
      .sort((a, b) => (sg.totals?.nodeTypes[a] ?? 0) - (sg.totals?.nodeTypes[b] ?? 0))
    for (const t of types) {
      const count = sg.totals?.nodeTypes[t] ?? 0
      if (w.fullTypes.has(t) || count === 0) continue
      if (count > room()) {
        capped = true
        continue
      }
      added += await ensureNodesByTypes(sg, [t])
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
      addEdge(sg, eInt, edge)
      added++
    }
  }

  return { added: added > 0, capped }
}

// -- lazy full data ------------------------------------------------------------

/** Pull one item's full `data` payload — a point read of the parquet `data`
 * column — and merge it into the live graph. Returns true when data changed. */
export async function hydrateDetails(sel: Sel): Promise<boolean> {
  if (sel.kind === 'skewer') return false // skewer rows ride in whole
  if (!current) return false
  const kind = sel.kind === 'edge' ? 'edge' : 'node'
  const w = current.windowed
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
    // The full payload is what's saved, too: diff edits against it.
    const saved = kind === 'node' ? current.base.nodes.get(sel.id) : current.base.edges.get(sel.id)
    if (saved) saved.data = structuredClone(target.data)
    return true
  } catch {
    w.detail[kind].delete(int) // transient failure: allow a retry
    return false
  }
}

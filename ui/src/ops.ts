// Save as operations (POST /api/graphs/{id}/ops; src/kge/ops.py has the
// vocabulary). The store holds only the loaded part of a graph, so saving
// can't send it whole: diff it against the rows as loaded (static.ts
// `base`) and the saved schema + views, and send only what changed. Data
// travels as per-key set/unset, so an item whose full data never loaded
// can't overwrite the keys it didn't see.

import { staticGraph } from './static'
import type { EdgeT, GraphPayload, NodeT } from './types'
import { edgeKey } from './types'

export type Op = Record<string, unknown> & { op: string }

/** JSON with sorted keys: equality that ignores key order. */
const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
const same = (a: unknown, b: unknown) => canon(a) === canon(b)

function dataPatch(was: Record<string, unknown>, now: Record<string, unknown>) {
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(now)) if (!(k in was) || !same(was[k], v)) set[k] = v
  const unset = Object.keys(was).filter((k) => !(k in now))
  return { set, unset, changed: Object.keys(set).length > 0 || unset.length > 0 }
}

const edgeRef = (e: EdgeT) => ({ type: e.type, from: e.from, to: e.to })

/** The ops that turn the loaded rows as saved into `g`. Empty: nothing to save. */
export function diffOps(g: GraphPayload): Op[] {
  const sg = staticGraph()
  if (!sg) return []
  const ops: Op[] = []
  const { base, pristine } = sg

  // Schema first: new types must exist before nodes and edges use them.
  for (const kind of ['node', 'edge'] as const) {
    const was = kind === 'node' ? pristine.schema.nodeTypes : pristine.schema.edgeTypes
    const now = kind === 'node' ? g.schema.nodeTypes : g.schema.edgeTypes
    for (const [name, def] of Object.entries(now)) {
      if (!(name in was) || !same(was[name], def)) ops.push({ op: 'put_type', kind, name, def })
    }
  }
  const schemaFields: Op = { op: 'set_schema' }
  if ((g.schema.colorKey ?? '') !== (pristine.schema.colorKey ?? '')) schemaFields.colorKey = g.schema.colorKey
  if (!same(g.schema.colorValues ?? {}, pristine.schema.colorValues ?? {}))
    schemaFields.colorValues = g.schema.colorValues
  if (Object.keys(schemaFields).length > 1) ops.push(schemaFields)

  const nodes = new Map<string, NodeT>(g.nodes.map((n) => [n.id, n]))
  const removed = new Set<string>()
  for (const id of base.nodes.keys()) {
    if (!nodes.has(id)) {
      removed.add(id)
      ops.push({ op: 'remove_node', id }) // the server drops its edges too
    }
  }
  for (const n of g.nodes) {
    const was = base.nodes.get(n.id)
    if (!was) {
      ops.push({ op: 'create_node', id: n.id, type: n.type, label: n.label, data: n.data })
      continue
    }
    const p = dataPatch(was.data, n.data)
    if (n.type === was.type && n.label === was.label && !p.changed) continue
    const op: Op = { op: 'patch_node', id: n.id }
    if (n.type !== was.type) op.type = n.type
    if (n.label !== was.label) op.label = n.label
    if (p.changed) Object.assign(op, { set: p.set, unset: p.unset })
    ops.push(op)
  }

  const edges = new Map<string, EdgeT>(g.edges.map((e) => [edgeKey(e), e]))
  for (const [k, e] of base.edges) {
    if (edges.has(k) || removed.has(e.from) || removed.has(e.to)) continue
    ops.push({ op: 'remove_edge', ...edgeRef(e) })
  }
  for (const [k, e] of edges) {
    const was = base.edges.get(k)
    if (!was) {
      ops.push({ op: 'create_edge', ...edgeRef(e), data: e.data })
      continue
    }
    const p = dataPatch(was.data, e.data)
    if (p.changed) ops.push({ op: 'patch_edge', ...edgeRef(e), set: p.set, unset: p.unset })
  }

  // Types last out: removing one is only valid once nothing uses it.
  for (const kind of ['node', 'edge'] as const) {
    const was = kind === 'node' ? pristine.schema.nodeTypes : pristine.schema.edgeTypes
    const now = kind === 'node' ? g.schema.nodeTypes : g.schema.edgeTypes
    for (const name of Object.keys(was)) if (!(name in now)) ops.push({ op: 'remove_type', kind, name })
  }

  const views = new Set(g.views.map((v) => v.id))
  for (const v of g.views) {
    const was = pristine.views.find((x) => x.id === v.id)
    if (!was || !same(was, v)) ops.push({ op: 'put_view', view: v })
  }
  for (const v of pristine.views) if (!views.has(v.id)) ops.push({ op: 'remove_view', id: v.id })
  return ops
}

/** Take `g` as the new saved state: later diffs show only edits made after
 * this (a save in flight must not be sent twice). Returns an undo, for when
 * the save never reached the server. */
export function rebase(g: GraphPayload): () => void {
  const sg = staticGraph()
  if (!sg) return () => {}
  const was = { base: sg.base, pristine: sg.pristine }
  sg.base = {
    nodes: new Map(g.nodes.map((n) => [n.id, structuredClone(n)])),
    edges: new Map(g.edges.map((e) => [edgeKey(e), structuredClone(e)])),
  }
  sg.pristine = structuredClone({ ...g, nodes: [], edges: [] })
  return () => {
    sg.base = was.base
    sg.pristine = was.pristine
  }
}

/** Everything `ops` touch, so a reload can load it before replaying them. */
export function opRefs(ops: Op[]): { nodes: string[]; edges: string[] } {
  const nodes = new Set<string>()
  const edges = new Set<string>()
  for (const op of ops) {
    if (typeof op.id === 'string' && op.op.endsWith('_node')) nodes.add(op.id)
    if (typeof op.from === 'string' && typeof op.to === 'string') {
      nodes.add(op.from)
      nodes.add(op.to)
      edges.add(edgeKey({ type: String(op.type), from: op.from, to: op.to }))
    }
  }
  return { nodes: [...nodes], edges: [...edges] }
}

/** Replay `ops` onto `g` (in place) — local edits not yet saved, on top of a
 * freshly reloaded graph. Mirrors src/kge/ops.py, except that an op the
 * reloaded graph no longer fits (its node is gone, its id now taken) is
 * dropped: the server's state wins. Returns how many were dropped. */
export function applyOps(g: GraphPayload, ops: Op[]): number {
  let dropped = 0
  const nodeAt = (id: unknown) => g.nodes.findIndex((n) => n.id === id)
  const edgeAt = (op: Op) =>
    g.edges.findIndex((e) => e.type === op.type && e.from === op.from && e.to === op.to)
  const patch = (data: Record<string, unknown>, op: Op) => {
    const out = { ...data }
    for (const k of (op.unset as string[] | undefined) ?? []) delete out[k]
    return Object.assign(out, (op.set as Record<string, unknown> | undefined) ?? {})
  }
  for (const op of ops) {
    switch (op.op) {
      case 'create_node':
        if (nodeAt(op.id) >= 0) dropped++
        else g.nodes.push({ id: String(op.id), type: String(op.type), label: String(op.label ?? ''), data: (op.data as Record<string, unknown>) ?? {} })
        break
      case 'patch_node': {
        const i = nodeAt(op.id)
        if (i < 0) {
          dropped++
          break
        }
        const n = { ...g.nodes[i] }
        if (op.type !== undefined) n.type = String(op.type)
        if (op.label !== undefined) n.label = String(op.label)
        n.data = patch(n.data, op)
        g.nodes[i] = n
        break
      }
      case 'remove_node':
        if (nodeAt(op.id) < 0) dropped++
        g.nodes = g.nodes.filter((n) => n.id !== op.id)
        g.edges = g.edges.filter((e) => e.from !== op.id && e.to !== op.id)
        break
      case 'create_edge':
        if (edgeAt(op) >= 0 || nodeAt(op.from) < 0 || nodeAt(op.to) < 0) dropped++
        else g.edges.push({ type: String(op.type), from: String(op.from), to: String(op.to), data: (op.data as Record<string, unknown>) ?? {} })
        break
      case 'patch_edge': {
        const i = edgeAt(op)
        if (i < 0) dropped++
        else g.edges[i] = { ...g.edges[i], data: patch(g.edges[i].data, op) }
        break
      }
      case 'remove_edge': {
        const i = edgeAt(op)
        if (i < 0) dropped++
        else g.edges.splice(i, 1)
        break
      }
      case 'put_type':
      case 'remove_type': {
        const table = op.kind === 'node' ? g.schema.nodeTypes : g.schema.edgeTypes
        if (op.op === 'put_type') table[String(op.name)] = structuredClone(op.def) as (typeof table)[string]
        else delete table[String(op.name)]
        break
      }
      case 'set_schema':
        if ('colorKey' in op) g.schema.colorKey = op.colorKey as string
        if ('colorValues' in op) g.schema.colorValues = op.colorValues as Record<string, string>
        break
      case 'put_view': {
        const v = structuredClone(op.view) as GraphPayload['views'][number]
        const i = g.views.findIndex((x) => x.id === v.id)
        if (i >= 0) g.views[i] = v
        else g.views.push(v)
        break
      }
      case 'remove_view':
        g.views = g.views.filter((v) => v.id !== op.id)
        break
    }
  }
  return dropped
}

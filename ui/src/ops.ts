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

// Pure helpers over the payload: visibility filtering and skewer interpretation.
//
// Skewers are stored *in the graph* as a `skewer` node plus `skewer-order`
// edges (data.index gives the order) — agents create them through the same
// API as any other fact. The view interprets them: it never draws the raw
// skewer node, but renders a rail segment and places the visible members
// evenly along it, so hiding members compacts the skewer for free.

import type { GraphPayload, Position, SkewerGeom, View } from './types'
import { edgeKey } from './types'

export const SKEWER_TYPE = 'skewer'
export const SKEWER_EDGE = 'skewer-order'

export interface Skewer {
  id: string
  label: string
  members: string[] // ordered by skewer-order data.index
}

export function skewersOf(g: GraphPayload): Skewer[] {
  const out: Skewer[] = []
  for (const n of g.nodes) {
    if (n.type !== SKEWER_TYPE) continue
    const rows = g.edges
      .filter((e) => e.type === SKEWER_EDGE && e.from === n.id)
      .map((e, i) => ({
        id: e.to,
        idx: typeof e.data.index === 'number' ? (e.data.index as number) : i,
      }))
      .sort((x, y) => x.idx - y.idx)
    out.push({ id: n.id, label: n.label || n.id, members: rows.map((r) => r.id) })
  }
  return out
}

/** Is this specific skewer interpreted in this view? (Its own checkbox in the
 * tree: the skewer type's state XOR an individual override.) */
export function skewerShown(v: View, skewerId: string): boolean {
  const base = v.visibleNodeTypes === null || v.visibleNodeTypes.includes(SKEWER_TYPE)
  return (v.nodeOverrides ?? []).includes(skewerId) ? !base : base
}

/** Which nodes/edges the view shows: type checkboxes XOR per-item overrides,
 * then optional k-hop focus. Skewer nodes and skewer-order edges are never
 * part of the normal sets — they're interpreted, not drawn, and don't
 * conduct reachability. */
export function visibleSets(
  g: GraphPayload,
  v: View,
): { nodes: Set<string>; edges: Set<string>; hops: Map<string, number> | null } {
  const nOv = new Set(v.nodeOverrides ?? [])
  const eOv = new Set(v.edgeOverrides ?? [])
  const nodeTypeChecked = (t: string) =>
    v.visibleNodeTypes === null || v.visibleNodeTypes.includes(t)
  const edgeTypeChecked = (t: string) =>
    v.visibleEdgeTypes === null || v.visibleEdgeTypes.includes(t)
  const nodeOk = (n: { id: string; type: string }) =>
    n.type !== SKEWER_TYPE && nodeTypeChecked(n.type) !== nOv.has(n.id)
  const edgeTypeOk = (e: { type: string; from: string; to: string }) =>
    e.type !== SKEWER_EDGE && edgeTypeChecked(e.type) !== eOv.has(edgeKey(e))

  const included = new Set(g.nodes.filter(nodeOk).map((n) => n.id))
  let nodes = included
  const edgeVisible = (e: { type: string; from: string; to: string }) =>
    edgeTypeOk(e) && nodes.has(e.from) && nodes.has(e.to)

  let hops: Map<string, number> | null = null
  if (v.focus && nodes.has(v.focus.node)) {
    const adj = new Map<string, string[]>()
    for (const e of g.edges) {
      if (!edgeVisible(e)) continue
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
    }
    const dist = new Map<string, number>([[v.focus.node, 0]])
    const queue = [v.focus.node]
    while (queue.length) {
      const cur = queue.shift()!
      const d = dist.get(cur)!
      if (d >= v.focus.kHops) continue
      for (const next of adj.get(cur) ?? []) {
        if (!dist.has(next)) {
          dist.set(next, d + 1)
          queue.push(next)
        }
      }
    }
    nodes = new Set([...nodes].filter((n) => dist.has(n)))
    hops = dist
  }

  // Eye adjustments on top of the focus: summon included items back, banish
  // shown ones. Summoned edges still need both endpoints shown to render.
  const show = new Set(v.focusShow ?? [])
  const hide = new Set(v.focusHide ?? [])
  if (show.size || hide.size) {
    nodes = new Set(nodes)
    for (const id of show) if (included.has(id)) nodes.add(id)
    for (const id of hide) nodes.delete(id)
  }

  const edges = new Set(
    g.edges.filter((e) => edgeVisible(e) && !hide.has(edgeKey(e))).map((e) => edgeKey(e)),
  )
  return { nodes, edges, hops }
}

/** The nodes the view *includes* (type checkboxes XOR overrides), before any
 * focus or eye adjustment — the "enabled" set the legend compares against. */
export function includedNodeIds(g: GraphPayload, v: View): Set<string> {
  const nOv = new Set(v.nodeOverrides ?? [])
  const checked = (t: string) => v.visibleNodeTypes === null || v.visibleNodeTypes.includes(t)
  return new Set(
    g.nodes.filter((n) => n.type !== SKEWER_TYPE && checked(n.type) !== nOv.has(n.id)).map((n) => n.id),
  )
}

export type DimLevel = 'near' | 'outer'

/**
 * Which shown nodes are the *periphery* of the focus, and how dimmed.
 *
 * Distances are computed over the SHOWN subgraph. Base bands per the global
 * radius k: d == k dims heavily, d == k-1 lightly (when k >= 3). On top:
 *   - nodes beyond the radius (only reachable via eye-summons, or left
 *     dangling by banishes) are the new periphery and dim heavily — but any
 *     node on a simple path from the center to such a node is exempt: the
 *     frontier moves outward along summoned paths.
 *   - nodes on a cycle through the center (same biconnected block, of size
 *     >= 3) are never dimmed: a loop has no dead end.
 */
export function peripheryDim(
  g: GraphPayload,
  v: View,
  shownNodes: Set<string>,
  shownEdges: Set<string>,
): Map<string, DimLevel> {
  const dim = new Map<string, DimLevel>()
  const center = v.focus?.node
  const k = v.focus?.kHops ?? 0
  if (!center || !shownNodes.has(center)) return dim

  // Deduped adjacency over the shown subgraph.
  const adjSet = new Map<string, Set<string>>()
  for (const id of shownNodes) adjSet.set(id, new Set())
  for (const e of g.edges) {
    if (!shownEdges.has(edgeKey(e)) || e.from === e.to) continue
    adjSet.get(e.from)!.add(e.to)
    adjSet.get(e.to)!.add(e.from)
  }
  const adj = new Map([...adjSet.entries()].map(([id, s]) => [id, [...s]]))

  // Distances from the center within the shown subgraph.
  const d = new Map<string, number>([[center, 0]])
  const queue = [center]
  while (queue.length) {
    const cur = queue.shift()!
    for (const nb of adj.get(cur) ?? []) {
      if (!d.has(nb)) {
        d.set(nb, d.get(cur)! + 1)
        queue.push(nb)
      }
    }
  }

  // Biconnected components (iterative Tarjan) for simple-path and cycle queries.
  const disc = new Map<string, number>()
  const low = new Map<string, number>()
  const vblocks = new Map<string, Set<number>>()
  const blockSize = new Map<number, number>()
  const blockMembers = new Map<number, Set<string>>()
  let time = 0
  let blockId = 0
  const edgeStack: [string, string][] = []
  const addToBlock = (vertex: string, b: number) => {
    let set = vblocks.get(vertex)
    if (!set) {
      set = new Set()
      vblocks.set(vertex, set)
    }
    set.add(b)
    let members = blockMembers.get(b)
    if (!members) {
      members = new Set()
      blockMembers.set(b, members)
    }
    members.add(vertex)
    blockSize.set(b, members.size)
  }
  for (const root of adj.keys()) {
    if (disc.has(root)) continue
    disc.set(root, time)
    low.set(root, time)
    time++
    const stack: [string, string | null, number][] = [[root, null, 0]]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const [vtx, parent] = frame
      const neighbors = adj.get(vtx)!
      if (frame[2] < neighbors.length) {
        const w = neighbors[frame[2]++]
        if (w === parent) continue
        if (!disc.has(w)) {
          edgeStack.push([vtx, w])
          disc.set(w, time)
          low.set(w, time)
          time++
          stack.push([w, vtx, 0])
        } else if (disc.get(w)! < disc.get(vtx)!) {
          edgeStack.push([vtx, w])
          low.set(vtx, Math.min(low.get(vtx)!, disc.get(w)!))
        }
      } else {
        stack.pop()
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent)!, low.get(vtx)!))
          if (low.get(vtx)! >= disc.get(parent)!) {
            const b = blockId++
            let top: [string, string]
            do {
              top = edgeStack.pop()!
              addToBlock(top[0], b)
              addToBlock(top[1], b)
            } while (edgeStack.length && !(top[0] === parent && top[1] === vtx))
          }
        }
      }
    }
  }

  // On a real cycle (block of >= 3 vertices) through the center => never dim.
  const centerBlocks = vblocks.get(center) ?? new Set<number>()
  const onCycleWithCenter = (n: string): boolean =>
    [...(vblocks.get(n) ?? [])].some((b) => centerBlocks.has(b) && (blockSize.get(b) ?? 0) >= 3)

  // Block-cut structure as a bipartite tree (vertices <-> blocks): BFS from
  // the center; vertices on some simple center->m path are exactly the union
  // of the blocks along the tree path to m.
  const parentOf = new Map<string, string>() // bipartite keys 'v:x' / 'b:n'
  {
    const bfs = [`v:${center}`]
    parentOf.set(`v:${center}`, '')
    while (bfs.length) {
      const cur = bfs.shift()!
      const next: string[] = []
      if (cur.startsWith('v:')) {
        for (const b of vblocks.get(cur.slice(2)) ?? []) next.push(`b:${b}`)
      } else {
        for (const m of blockMembers.get(Number(cur.slice(2))) ?? []) next.push(`v:${m}`)
      }
      for (const n of next) {
        if (!parentOf.has(n)) {
          parentOf.set(n, cur)
          bfs.push(n)
        }
      }
    }
  }
  const simplePathVertices = (m: string): Set<string> => {
    const out = new Set<string>()
    let cur = parentOf.has(`v:${m}`) ? `v:${m}` : null
    while (cur) {
      if (cur.startsWith('b:')) {
        for (const w of blockMembers.get(Number(cur.slice(2))) ?? []) out.add(w)
      } else {
        out.add(cur.slice(2))
      }
      const p = parentOf.get(cur)
      cur = p ? p : null
    }
    return out
  }

  // Beyond-the-radius shown nodes: the manual periphery.
  const beyond = [...shownNodes].filter((n) => n !== center && (d.get(n) ?? Infinity) > k)
  const exempt = new Set<string>()
  for (const m of beyond) {
    if (!d.has(m)) continue // disconnected: nothing to exempt
    for (const w of simplePathVertices(m)) if (w !== m) exempt.add(w)
    if (onCycleWithCenter(m)) exempt.add(m)
  }

  for (const n of shownNodes) {
    if (n === center || exempt.has(n)) continue
    const dn = d.get(n) ?? Infinity
    if (dn > k) {
      dim.set(n, 'outer')
      continue
    }
    if (onCycleWithCenter(n)) continue
    if (dn === k) dim.set(n, 'outer')
    else if (k >= 3 && dn === k - 1) dim.set(n, 'near')
  }
  return dim
}

/** Even placement of the visible members along the a→b segment. Hidden
 * members simply drop out, so the survivors re-space — instant compaction. */
export function placeAlong(geom: SkewerGeom, ids: string[]): Record<string, Position> {
  const out: Record<string, Position> = {}
  const n = ids.length
  ids.forEach((id, i) => {
    const t = (i + 0.5) / n
    out[id] = {
      x: geom.a.x + (geom.b.x - geom.a.x) * t,
      y: geom.a.y + (geom.b.y - geom.a.y) * t,
    }
  })
  return out
}

// -- post-layout de-collision -------------------------------------------------

const NODE_R = 13 // ui NODE_SIZE / 2
const RAIL_HW = 3 // ui RAIL_WIDTH / 2
const MARGIN = 6
const EDGE_CLEAR = NODE_R + 1 + MARGIN // node-center clearance from an edge segment

export interface SkewerRig {
  geom: SkewerGeom
  visMembers: string[]
}

const segPointDist = (a: Position, b: Position, p: Position): { d: number; cx: number; cy: number } => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const denom = abx * abx + aby * aby
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom))
  const cx = a.x + t * abx
  const cy = a.y + t * aby
  return { d: Math.hypot(p.x - cx, p.y - cy), cx, cy }
}

const orient = (a: Position, b: Position, c: Position): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

const segsCross = (a1: Position, b1: Position, a2: Position, b2: Position): boolean => {
  const d1 = orient(a2, b2, a1)
  const d2 = orient(a2, b2, b1)
  const d3 = orient(a1, b1, a2)
  const d4 = orient(a1, b1, b2)
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0
}

/**
 * Iterative separation solver, run after fcose: resolve *visual* overlaps the
 * quotient layout can't see (fcose never considers edge-node crossings, and
 * its overlap avoidance is soft). Rigid-body rules match dragging: a member
 * collision translates its whole skewer; pinned nodes/skewers never move
 * (their counterpart takes the full displacement). Same-skewer edges are
 * skipped — they're drawn as arcs, not chords. Edges themselves are never
 * pushed; the offending node is moved off the segment instead.
 */
export function resolveCollisions(
  free: Record<string, Position>,
  pinnedNodes: Set<string>,
  rigs: Record<string, SkewerRig>,
  edges: { from: string; to: string }[],
): { free: Record<string, Position>; geoms: Record<string, SkewerGeom>; settled: boolean } {
  const freePos: Record<string, Position> = Object.fromEntries(
    Object.entries(free).map(([k, p]) => [k, { ...p }]),
  )
  const geoms: Record<string, SkewerGeom> = Object.fromEntries(
    Object.entries(rigs).map(([k, r]) => [k, { a: { ...r.geom.a }, b: { ...r.geom.b }, pinned: r.geom.pinned }]),
  )
  const memberOf = new Map<string, string>()
  for (const [sid, r] of Object.entries(rigs)) for (const m of r.visMembers) memberOf.set(m, sid)

  const movable = (id: string): boolean => {
    const sid = memberOf.get(id)
    return sid ? !geoms[sid].pinned : !pinnedNodes.has(id)
  }

  let settled = false
  let lastHard = Infinity
  for (let iter = 0; iter < 60 && !settled; iter++) {
    const pos: Record<string, Position> = { ...freePos }
    for (const [sid, r] of Object.entries(rigs)) {
      Object.assign(pos, placeAlong(geoms[sid], r.visMembers))
    }
    const nodeDelta = new Map<string, Position>()
    const skewerDelta = new Map<string, Position>()
    let worstHard = 0 // unresolved collision depth
    let worstSoft = 0 // pending angular-spreading movement

    const push = (id: string, dx: number, dy: number) => {
      const sid = memberOf.get(id)
      const map = sid ? skewerDelta : nodeDelta
      const key = sid ?? id
      const cur = map.get(key) ?? { x: 0, y: 0 }
      map.set(key, { x: cur.x + dx, y: cur.y + dy })
    }

    const separate = (i: string, j: string, pen: number, dirX: number, dirY: number) => {
      worstHard = Math.max(worstHard, pen)
      const mi = movable(i)
      const mj = movable(j)
      if (mi && mj) {
        push(i, (dirX * pen) / 2, (dirY * pen) / 2)
        push(j, (-dirX * pen) / 2, (-dirY * pen) / 2)
      } else if (mi) push(i, dirX * pen, dirY * pen)
      else if (mj) push(j, -dirX * pen, -dirY * pen)
    }

    const ids = Object.keys(pos)

    // node - node
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = pos[ids[i]]
        const q = pos[ids[j]]
        // Same-skewer members are spaced by the rail; skip them.
        const si = memberOf.get(ids[i])
        if (si !== undefined && si === memberOf.get(ids[j])) continue
        const d = Math.hypot(p.x - q.x, p.y - q.y)
        const min = 2 * NODE_R + MARGIN
        if (d >= min) continue
        const [dx, dy] = d > 1e-6 ? [(p.x - q.x) / d, (p.y - q.y) / d] : [0, -1]
        separate(ids[i], ids[j], min - d, dx, dy)
      }
    }

    // node - rail
    for (const [sid, geom] of Object.entries(geoms)) {
      for (const id of ids) {
        if (memberOf.get(id) === sid) continue
        const { d, cx, cy } = segPointDist(geom.a, geom.b, pos[id])
        const min = NODE_R + RAIL_HW + MARGIN
        if (d >= min) continue
        const [dx, dy] =
          d > 1e-6
            ? [(pos[id].x - cx) / d, (pos[id].y - cy) / d]
            : [-(geom.b.y - geom.a.y), geom.b.x - geom.a.x].map(
                (v, _, arr) => v / (Math.hypot(arr[0], arr[1]) || 1),
              ) as [number, number]
        const pen = min - d
        worstHard = Math.max(worstHard, pen)
        const nodeMv = movable(id)
        const railMv = !geom.pinned
        if (nodeMv && railMv) {
          push(id, (dx * pen) / 2, (dy * pen) / 2)
          const cur = skewerDelta.get(sid) ?? { x: 0, y: 0 }
          skewerDelta.set(sid, { x: cur.x - (dx * pen) / 2, y: cur.y - (dy * pen) / 2 })
        } else if (nodeMv) push(id, dx * pen, dy * pen)
        else if (railMv) {
          const cur = skewerDelta.get(sid) ?? { x: 0, y: 0 }
          skewerDelta.set(sid, { x: cur.x - dx * pen, y: cur.y - dy * pen })
        }
      }
    }

    // edge - node: alter the ANGLE the edge protrudes at, not the obstacle's
    // position — rotate a movable endpoint around the other endpoint until the
    // segment swings clear. The obstacle is only nudged as a last resort when
    // neither endpoint can move.
    for (const e of edges) {
      const sf = memberOf.get(e.from)
      if (sf !== undefined && sf === memberOf.get(e.to)) continue // drawn as an arc
      const p1 = pos[e.from]
      const p2 = pos[e.to]
      if (!p1 || !p2) continue
      for (const id of ids) {
        if (id === e.from || id === e.to) continue
        const P = pos[id]
        const { d, cx, cy } = segPointDist(p1, p2, P)
        if (d >= EDGE_CLEAR) continue
        const pen = EDGE_CLEAR - d
        worstHard = Math.max(worstHard, pen)

        let best: { id: string; dx: number; dy: number; len: number } | null = null
        const candidates: [string, Position, Position][] = [
          [e.from, p2, p1], // rotate `from` around `to`
          [e.to, p1, p2], // rotate `to` around `from`
        ]
        for (const [movingId, pivot, moving] of candidates) {
          if (!movable(movingId)) continue
          const rPA = Math.hypot(P.x - pivot.x, P.y - pivot.y)
          if (rPA < 1e-6) continue
          const aAB = Math.atan2(moving.y - pivot.y, moving.x - pivot.x)
          const aAP = Math.atan2(P.y - pivot.y, P.x - pivot.x)
          let diff = aAB - aAP
          while (diff > Math.PI) diff -= 2 * Math.PI
          while (diff < -Math.PI) diff += 2 * Math.PI
          // Minimum angular separation between the edge and the obstacle's
          // bearing so the line passes EDGE_CLEAR away from it.
          const needed = Math.asin(Math.min(1, EDGE_CLEAR / rPA))
          if (Math.abs(diff) >= needed) continue // grazing an endpoint; node-node handles it
          const dTheta = (diff >= 0 ? 1 : -1) * (needed - Math.abs(diff))
          const cos = Math.cos(dTheta)
          const sin = Math.sin(dTheta)
          const vx = moving.x - pivot.x
          const vy = moving.y - pivot.y
          const dx = pivot.x + vx * cos - vy * sin - moving.x
          const dy = pivot.y + vx * sin + vy * cos - moving.y
          const len = Math.hypot(dx, dy)
          if (!best || len < best.len) best = { id: movingId, dx, dy, len }
        }
        if (best) {
          push(best.id, best.dx, best.dy)
        } else if (movable(id)) {
          // Neither endpoint can rotate: nudge the obstacle off the segment.
          const [dx, dy] =
            d > 1e-6
              ? [(P.x - cx) / d, (P.y - cy) / d]
              : ([-(p2.y - p1.y), p2.x - p1.x].map((v, _, arr) => v / (Math.hypot(arr[0], arr[1]) || 1)) as [
                  number,
                  number,
                ])
          push(id, dx * pen, dy * pen)
        }
      }
    }

    // soft minimum edge length: an edge needs room for its label between the
    // node circles. Swing-based collision fixes can shorten edges; this
    // gently re-lengthens them (free endpoints only — never drags skewers).
    {
      const EDGE_MIN_LEN = 110
      const LEN_GAIN = 0.2
      for (const e of edges) {
        const sf = memberOf.get(e.from)
        if (sf !== undefined && sf === memberOf.get(e.to)) continue // arcs handle their own room
        const p1 = pos[e.from]
        const p2 = pos[e.to]
        if (!p1 || !p2) continue
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y)
        if (d >= EDGE_MIN_LEN) continue
        const deficit = EDGE_MIN_LEN - d
        const [dx, dy] = d > 1e-6 ? [(p1.x - p2.x) / d, (p1.y - p2.y) / d] : [0, -1]
        const fromFree = !memberOf.has(e.from) && movable(e.from)
        const toFree = !memberOf.has(e.to) && movable(e.to)
        if (!fromFree && !toFree) continue
        const step = deficit * LEN_GAIN
        worstSoft = Math.max(worstSoft, step)
        if (fromFree && toFree) {
          push(e.from, (dx * step) / 2, (dy * step) / 2)
          push(e.to, (-dx * step) / 2, (-dy * step) / 2)
        } else if (fromFree) push(e.from, dx * step, dy * step)
        else push(e.to, -dx * step, -dy * step)
      }
    }

    // angular spreading: don't settle at minimum clearance — around each node,
    // push incident edges toward an equal share of the full circle, so the
    // arrangement uses the angular room that exists. Soft force (gain-scaled),
    // so hard collision pushes above always win; it converges as gaps equalize.
    {
      const SPREAD_GAIN = 0.15
      // `other: null` marks an immovable phantom bearing that only occupies
      // angular space (used for rail directions at member nodes).
      const incident = new Map<string, { other: string | null; angle: number }[]>()
      for (const e of edges) {
        const p1 = pos[e.from]
        const p2 = pos[e.to]
        if (!p1 || !p2 || (p1.x === p2.x && p1.y === p2.y)) continue
        incident.set(e.from, [
          ...(incident.get(e.from) ?? []),
          { other: e.to, angle: Math.atan2(p2.y - p1.y, p2.x - p1.x) },
        ])
        incident.set(e.to, [
          ...(incident.get(e.to) ?? []),
          { other: e.from, angle: Math.atan2(p1.y - p2.y, p1.x - p2.x) },
        ])
      }
      // The rail occupies angular space at each of its members: inject its two
      // directions as phantoms, so edges spread away from the rail instead of
      // running alongside it (parallel edges collide by label, not by path).
      const wrap = (a: number) => ((a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
      for (const [sid, r] of Object.entries(rigs)) {
        const geom = geoms[sid]
        const railAngle = Math.atan2(geom.b.y - geom.a.y, geom.b.x - geom.a.x)
        for (const m of r.visMembers) {
          const list = incident.get(m)
          if (!list) continue
          list.push({ other: null, angle: wrap(railAngle) }, { other: null, angle: wrap(railAngle + Math.PI) })
        }
      }
      for (const [v, list] of incident) {
        if (list.length < 2) continue
        const pv = pos[v]
        list.sort((x, y) => x.angle - y.angle)
        const fair = (2 * Math.PI) / list.length
        for (let i = 0; i < list.length; i++) {
          const cur = list[i]
          const nxt = list[(i + 1) % list.length]
          let gap = nxt.angle - cur.angle
          if (i === list.length - 1) gap += 2 * Math.PI
          const deficit = fair - gap
          if (deficit <= 1e-3) continue
          const dTheta = (deficit * SPREAD_GAIN) / 2 // each side of the gap takes half
          for (const [ent, sgn] of [
            [cur, -1],
            [nxt, 1],
          ] as [typeof cur, number][]) {
            // Spreading only swings free endpoints — phantoms are immovable,
            // and it never drags skewers or pinned nodes.
            if (ent.other === null || memberOf.has(ent.other) || !movable(ent.other)) continue
            const po = pos[ent.other]
            const cos = Math.cos(sgn * dTheta)
            const sin = Math.sin(sgn * dTheta)
            const vx = po.x - pv.x
            const vy = po.y - pv.y
            const dx = pv.x + vx * cos - vy * sin - po.x
            const dy = pv.y + vx * sin + vy * cos - po.y
            push(ent.other, dx, dy)
            worstSoft = Math.max(worstSoft, Math.hypot(dx, dy)) // pending arc-length; gain-scaled, so it converges
          }
        }
      }
    }

    // rail - rail: translate crossing/near skewers apart
    const sids = Object.keys(geoms)
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        const g1 = geoms[sids[i]]
        const g2 = geoms[sids[j]]
        const crossing = segsCross(g1.a, g1.b, g2.a, g2.b)
        const d = crossing
          ? 0
          : Math.min(
              segPointDist(g1.a, g1.b, g2.a).d,
              segPointDist(g1.a, g1.b, g2.b).d,
              segPointDist(g2.a, g2.b, g1.a).d,
              segPointDist(g2.a, g2.b, g1.b).d,
            )
        const min = 2 * RAIL_HW + MARGIN
        if (d >= min) continue
        const pen = min - d
        worstHard = Math.max(worstHard, pen)
        const m1 = { x: (g1.a.x + g1.b.x) / 2, y: (g1.a.y + g1.b.y) / 2 }
        const m2 = { x: (g2.a.x + g2.b.x) / 2, y: (g2.a.y + g2.b.y) / 2 }
        const dd = Math.hypot(m1.x - m2.x, m1.y - m2.y)
        const [dx, dy] = dd > 1e-6 ? [(m1.x - m2.x) / dd, (m1.y - m2.y) / dd] : [0, -1]
        const mv1 = !g1.pinned
        const mv2 = !g2.pinned
        const half = (v: number) => (mv1 && mv2 ? v / 2 : v)
        if (mv1) {
          const cur = skewerDelta.get(sids[i]) ?? { x: 0, y: 0 }
          skewerDelta.set(sids[i], { x: cur.x + half(dx * pen), y: cur.y + half(dy * pen) })
        }
        if (mv2) {
          const cur = skewerDelta.get(sids[j]) ?? { x: 0, y: 0 }
          skewerDelta.set(sids[j], { x: cur.x - half(dx * pen), y: cur.y - half(dy * pen) })
        }
      }
    }

    lastHard = worstHard
    if (worstHard < 0.5 && worstSoft < 0.5) {
      settled = true
      break
    }

    // Apply, damped and capped, so opposing pushes settle instead of exploding.
    const apply = (p: Position, d: Position): Position => {
      const len = Math.hypot(d.x, d.y)
      const scale = (len > 40 ? 40 / len : 1) * 0.7
      return { x: p.x + d.x * scale, y: p.y + d.y * scale }
    }
    for (const [id, d] of nodeDelta) freePos[id] = apply(freePos[id], d)
    for (const [sid, d] of skewerDelta) {
      const geom = geoms[sid]
      geom.a = apply(geom.a, d)
      geom.b = apply(geom.b, d)
    }
  }

  // `settled` reports collisions only: running out of iterations while the
  // soft spreading is still micro-converging is not a failure.
  return { free: freePos, geoms, settled: settled || lastHard < 0.5 }
}

/**
 * Greedy compaction: pull the ends of over-long edges toward each other,
 * re-settle with resolveCollisions, and rescore — keep the step only while
 * the score doesn't get worse, stop as soon as it does (or shortening stalls).
 * Rigid rules as everywhere: members drag their skewer, pinned things stay.
 */
export function compactEdges(
  free: Record<string, Position>,
  pinnedNodes: Set<string>,
  rigs: Record<string, SkewerRig>,
  edges: { from: string; to: string }[],
): { free: Record<string, Position>; geoms: Record<string, SkewerGeom> } {
  const EDGE_IDEAL = 170 // matches fcose idealEdgeLength
  const PULL = 0.3

  const memberOf = new Map<string, string>()
  for (const [sid, r] of Object.entries(rigs)) for (const m of r.visMembers) memberOf.set(m, sid)
  const rigsWith = (geoms: Record<string, SkewerGeom>): Record<string, SkewerRig> =>
    Object.fromEntries(
      Object.entries(rigs).map(([sid, r]) => [sid, { geom: geoms[sid], visMembers: r.visMembers }]),
    )
  const derive = (f: Record<string, Position>, geoms: Record<string, SkewerGeom>) => {
    const pos: Record<string, Position> = { ...f }
    for (const [sid, r] of Object.entries(rigs)) Object.assign(pos, placeAlong(geoms[sid], r.visMembers))
    return pos
  }
  const straight = edges.filter((e) => {
    const sf = memberOf.get(e.from)
    return !(sf !== undefined && sf === memberOf.get(e.to))
  })
  const totalLen = (pos: Record<string, Position>) =>
    straight.reduce((sum, e) => {
      const p1 = pos[e.from]
      const p2 = pos[e.to]
      return p1 && p2 ? sum + Math.hypot(p1.x - p2.x, p1.y - p2.y) : sum
    }, 0)

  let curFree = free
  let curGeoms: Record<string, SkewerGeom> = Object.fromEntries(
    Object.entries(rigs).map(([sid, r]) => [sid, r.geom]),
  )
  let curScore = scoreArrangement(curFree, rigsWith(curGeoms), edges).score
  let curLen = totalLen(derive(curFree, curGeoms))

  for (let step = 0; step < 15; step++) {
    const pos = derive(curFree, curGeoms)
    const movable = (id: string): boolean => {
      const sid = memberOf.get(id)
      return sid ? !curGeoms[sid].pinned : !pinnedNodes.has(id)
    }
    const nodeDelta = new Map<string, Position>()
    const skewerDelta = new Map<string, Position>()
    const pull = (id: string, dx: number, dy: number) => {
      const sid = memberOf.get(id)
      const map = sid ? skewerDelta : nodeDelta
      const key = sid ?? id
      const cur = map.get(key) ?? { x: 0, y: 0 }
      map.set(key, { x: cur.x + dx, y: cur.y + dy })
    }

    let pulled = false
    for (const e of straight) {
      const p1 = pos[e.from]
      const p2 = pos[e.to]
      if (!p1 || !p2) continue
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y)
      if (d <= EDGE_IDEAL) continue
      const step2 = (d - EDGE_IDEAL) * PULL
      const dx = (p2.x - p1.x) / d
      const dy = (p2.y - p1.y) / d
      const mf = movable(e.from)
      const mt = movable(e.to)
      if (!mf && !mt) continue
      pulled = true
      if (mf && mt) {
        pull(e.from, (dx * step2) / 2, (dy * step2) / 2)
        pull(e.to, (-dx * step2) / 2, (-dy * step2) / 2)
      } else if (mf) pull(e.from, dx * step2, dy * step2)
      else pull(e.to, -dx * step2, -dy * step2)
    }
    if (!pulled) break

    const candFree: Record<string, Position> = Object.fromEntries(
      Object.entries(curFree).map(([k, p]) => [k, { ...p }]),
    )
    const candGeoms: Record<string, SkewerGeom> = Object.fromEntries(
      Object.entries(curGeoms).map(([k, g]) => [k, { a: { ...g.a }, b: { ...g.b }, pinned: g.pinned }]),
    )
    for (const [id, d] of nodeDelta) {
      candFree[id] = { x: candFree[id].x + d.x, y: candFree[id].y + d.y }
    }
    for (const [sid, d] of skewerDelta) {
      const g = candGeoms[sid]
      g.a = { x: g.a.x + d.x, y: g.a.y + d.y }
      g.b = { x: g.b.x + d.x, y: g.b.y + d.y }
    }

    // Contraction may have caused overlaps: re-settle, then judge by score.
    const res = resolveCollisions(candFree, pinnedNodes, rigsWith(candGeoms), edges)
    const candScore = scoreArrangement(res.free, rigsWith(res.geoms), edges).score
    const candLen = totalLen(derive(res.free, res.geoms))
    if (candScore > curScore || candLen >= curLen - 1) break // hurts, or stalled: keep `cur`
    curFree = res.free
    curGeoms = res.geoms
    curScore = candScore
    curLen = candLen
  }

  return { free: curFree, geoms: curGeoms }
}

/**
 * Score a resolved arrangement so random-restart trials can be compared:
 * residual collisions dominate (each counts, plus its depth), edge crossings
 * break ties. Lower is better.
 */
export function scoreArrangement(
  free: Record<string, Position>,
  rigs: Record<string, SkewerRig>,
  edges: { from: string; to: string }[],
): { score: number; collisions: number; crossings: number } {
  const pos: Record<string, Position> = { ...free }
  for (const [, r] of Object.entries(rigs)) Object.assign(pos, placeAlong(r.geom, r.visMembers))
  const memberOf = new Map<string, string>()
  for (const [sid, r] of Object.entries(rigs)) for (const m of r.visMembers) memberOf.set(m, sid)
  const ids = Object.keys(pos)

  let pen = 0
  let collisions = 0
  const hit = (p: number) => {
    if (p > 0.5) {
      pen += p
      collisions++
    }
  }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const si = memberOf.get(ids[i])
      if (si !== undefined && si === memberOf.get(ids[j])) continue
      const d = Math.hypot(pos[ids[i]].x - pos[ids[j]].x, pos[ids[i]].y - pos[ids[j]].y)
      hit(2 * NODE_R + MARGIN - d)
    }
  }
  for (const [sid, r] of Object.entries(rigs)) {
    for (const id of ids) {
      if (memberOf.get(id) === sid) continue
      hit(NODE_R + RAIL_HW + MARGIN - segPointDist(r.geom.a, r.geom.b, pos[id]).d)
    }
  }
  const straight = edges.filter((e) => {
    const sf = memberOf.get(e.from)
    return !(sf !== undefined && sf === memberOf.get(e.to)) && pos[e.from] && pos[e.to]
  })
  for (const e of straight) {
    for (const id of ids) {
      if (id === e.from || id === e.to) continue
      hit(EDGE_CLEAR - segPointDist(pos[e.from], pos[e.to], pos[id]).d)
    }
  }
  const sids = Object.keys(rigs)
  for (let i = 0; i < sids.length; i++) {
    for (let j = i + 1; j < sids.length; j++) {
      const g1 = rigs[sids[i]].geom
      const g2 = rigs[sids[j]].geom
      if (segsCross(g1.a, g1.b, g2.a, g2.b)) hit(2 * RAIL_HW + MARGIN)
    }
  }

  let crossings = 0
  for (let i = 0; i < straight.length; i++) {
    for (let j = i + 1; j < straight.length; j++) {
      const a = straight[i]
      const b = straight[j]
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue
      if (segsCross(pos[a.from], pos[a.to], pos[b.from], pos[b.to])) crossings++
    }
  }

  return { score: pen * 10 + collisions * 100 + crossings * 25, collisions, crossings }
}

/** First geometry for a skewer that has none in this view: a segment through
 * the members' current positions if known, otherwise a horizontal one. */
export function defaultGeom(members: string[], seed: Record<string, Position>): SkewerGeom {
  const ps = members.map((m) => seed[m]).filter(Boolean)
  if (ps.length >= 2) {
    const first = ps[0]
    const last = ps[ps.length - 1]
    // Extend by a half-step each way so t=(i+0.5)/n lands on the old endpoints.
    const half = 0.5 / Math.max(ps.length - 1, 1)
    return {
      a: { x: first.x - (last.x - first.x) * half, y: first.y - (last.y - first.y) * half },
      b: { x: last.x + (last.x - first.x) * half, y: last.y + (last.y - first.y) * half },
      pinned: false,
    }
  }
  const c = ps[0] ?? { x: 0, y: 0 }
  const len = 90 * Math.max(members.length - 1, 1)
  return {
    a: { x: c.x - len / 2, y: c.y },
    b: { x: c.x + len / 2, y: c.y },
    pinned: false,
  }
}

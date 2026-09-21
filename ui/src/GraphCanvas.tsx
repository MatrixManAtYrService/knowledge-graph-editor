// The cytoscape canvas. The store's payload is the source of truth; this
// component projects the visible subgraph into cy elements, interprets
// skewers (rail segment + end handles; members placed evenly along it),
// writes drag/layout results back into the view, and exposes imperative
// helpers (runLayout, skewerFromSelection) that need live positions.

import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useEffect, useRef } from 'react'
import {
  alignGeom,
  angleOf,
  axisTicks,
  compactEdges,
  defaultGeom,
  fociOf,
  formatOrderValue,
  groupOpts,
  LANE_GAP,
  nodeColor,
  peripheryDim,
  placeAlong,
  railTs,
  resolveCollisions,
  scoreArrangement,
  skewerShown,
  skewersOf,
  snapLanes,
  visibleSets,
  type DimLevel,
  type Skewer,
  type SkewerRig,
} from './graph'
import type { AxisInfo } from './types'
import { useStore } from './store'
import type { Position, Sel, SkewerGeom } from './types'

cytoscape.use(fcose)

// Shared dimensions, so derived offsets stay correct if these change.
const NODE_SIZE = 26
const RAIL_WIDTH = 6
// Focus-fringe fade: the outermost hop is heavily faded, the penultimate
// (when focus-hops > 2) lightly — the view reads "the graph continues here".
const FRINGE_NEAR_OPACITY = 0.65
const FRINGE_OUTER_OPACITY = 0.35

// Red crosshairs marking the focus center (drawn beyond the node's circle).
const CROSSHAIR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">' +
      '<g stroke="#dc2626" stroke-width="3" fill="none">' +
      '<circle cx="22" cy="22" r="14"/>' +
      '<line x1="22" y1="0" x2="22" y2="10"/><line x1="22" y1="34" x2="22" y2="44"/>' +
      '<line x1="0" y1="22" x2="10" y2="22"/><line x1="34" y1="22" x2="44" y2="22"/>' +
      '</g></svg>',
  )

/** The element opacity an element's stylesheet resolves to (for animation
 * targets). Fringe NODES dim via component opacities (fill, label,
 * crosshair) so their selection border stays bright — their element opacity
 * is 1; fringe edges dim as whole elements. */
const targetOpacity = (ele: cytoscape.SingularElementReturnValue): number =>
  ele.group() === 'nodes'
    ? 1
    : ele.hasClass('rail')
      ? 0.75
      : ele.hasClass('fringe-outer')
        ? FRINGE_OUTER_OPACITY
        : ele.hasClass('fringe-near')
          ? FRINGE_NEAR_OPACITY
          : 1

export const cyRef: { current: cytoscape.Core | null } = { current: null }

interface Rig {
  visMembers: string[] // members this skewer OWNS (spaced on its straight baseline)
  chain: string[] // ALL visible members in order — the rail threads through them,
  // bending at members owned by a higher-priority skewer
  geom: SkewerGeom
  ts?: number[] // per-owned-member rail fractions (value spacing); even when absent
}

// Rail color ramps: light at the base (bulb) to dark at the tip (arrow).
const lerpHex = (a: string, b: string, t: number): string => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const RAIL_RAMP = ['#e8eaed', '#5f6368']
const RAIL_PINNED_RAMP = ['#f3c1c1', '#b91c1c']

interface KgeScratch {
  memberOf: Map<string, string>
  rigs: Record<string, Rig>
  /** skewer -> its ALIGNED bundle mates: they follow its every drag, keeping
   * only their sideways offsets. */
  alignPeers: Map<string, string[]>
  /** skewer -> its GROUPED bundle mates: rail drags translate them rigidly
   * along (each keeps its own position, angle, and length). */
  groupPeers: Map<string, string[]>
  axisSkewers: Set<string> // skewers whose group draws an axis (dragfree must rebuild it)
}

const scratch = (cy: cytoscape.Core): KgeScratch =>
  (cy.scratch('kge') as KgeScratch) ?? {
    memberOf: new Map(),
    rigs: {},
    alignPeers: new Map(),
    groupPeers: new Map(),
    axisSkewers: new Set(),
  }

const handleId = (skewer: string, end: 'a' | 'b') => `skh:${end}:${skewer}`

/** Reflect the two-slot selection as element classes (skewers select via
 * their rail — every segment of it). A primary NODE also marks its incident
 * graph edges, which draw thicker — the selection's edges stand out even
 * when the node sits in a dense or dimmed neighborhood. */
function applySel(cy: cytoscape.Core, primary: Sel | null, secondary: Sel | null): void {
  cy.elements('.sel-primary').removeClass('sel-primary')
  cy.elements('.sel-secondary').removeClass('sel-secondary')
  cy.elements('.sel-incident').removeClass('sel-incident')
  const elOf = (s: Sel) =>
    s.kind === 'skewer'
      ? cy.edges('.rail').filter((e) => e.data('skewer') === s.id)
      : cy.$id(s.id)
  if (secondary) elOf(secondary).addClass('sel-secondary')
  if (primary) {
    const el = elOf(primary)
    el.addClass('sel-primary')
    // '[etype]' keeps this to real graph edges — rail segments stay put.
    if (primary.kind === 'node') el.connectedEdges('[etype]').addClass('sel-incident')
  }
}

/** Viewport center in graph coordinates — where new nodes appear. */
export function viewportCenter(): Position {
  const cy = cyRef.current
  if (!cy) return { x: 0, y: 0 }
  const ext = cy.extent()
  return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 }
}

/** Current positions of the given nodes (for pinning before recording). */
export function positionsOf(ids: string[]): Record<string, Position> {
  const cy = cyRef.current
  const out: Record<string, Position> = {}
  if (!cy) return out
  for (const id of ids) {
    const n = cy.$id(id)
    if (n.nonempty()) out[id] = { ...n.position() }
  }
  return out
}

/** Skewer the current selection: order it along its dominant axis, create the
 * skewer node + ordered skewer-order edges, and give the view a segment
 * through the members' current positions. */
export function skewerFromSelection(): void {
  const cy = cyRef.current
  const st = useStore.getState()
  if (!cy || !st.graph) return
  // Native multi-select (shift-click / box) wins; else fall back to the
  // two-slot click selection — clicking two nodes is enough for a pair.
  let picked = cy.nodes(':selected').map((n) => n.id())
  if (picked.length < 2) {
    picked = [
      ...new Set(
        [st.secondary, st.primary]
          .filter((s): s is Sel => s !== null && s.kind === 'node')
          .map((s) => s.id),
      ),
    ]
  }
  const pts = picked.flatMap((nid) => {
    const n = cy.$id(nid)
    return n.nonempty() ? [{ id: nid, p: { ...n.position() } }] : []
  })
  if (pts.length < 2) {
    st.setStatus('select at least 2 nodes to skewer (click two, or shift/box-select)')
    return
  }
  const xs = pts.map((o) => o.p.x)
  const ys = pts.map((o) => o.p.y)
  const axis: 'x' | 'y' =
    Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 'x' : 'y'
  pts.sort((u, w) => u.p[axis] - w.p[axis])
  const ids = pts.map((o) => o.id)
  const seed: Record<string, Position> = {}
  for (const o of pts) seed[o.id] = o.p
  const suggested = `skewer:s${skewersOf(st.graph).length + 1}`
  const id = window.prompt('skewer id', suggested)
  if (!id) return
  st.createSkewer(id, ids, defaultGeom(ids, seed))
}

// Set before bump() when the freshly committed layout should be fitted once
// the canvas rebuilds (a random restart can land anywhere in the plane).
const fitAfterBuild = { flag: false }

/** One random-restart trial: fcose on the quotient graph from a fresh random
 * arrangement (pinned nodes/skewers stay fixed). Resolves with positions. */
function runQuotientTrial(
  els: cytoscape.ElementDefinition[],
  fixed: { nodeId: string; position: Position }[],
): Promise<Record<string, Position>> {
  const cloned = els.map((e) => ({
    ...e,
    data: { ...e.data },
    ...(e.position ? { position: { ...e.position } } : {}),
  }))
  return new Promise((resolve) => {
    const head = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: cloned,
      style: [
        {
          selector: 'node',
          style: { width: 'data(w)', height: 'data(h)', shape: 'rectangle' },
        } as never,
      ],
    })
    const layout = head.layout({
      name: 'fcose',
      animate: false,
      randomize: true, // multi-start: every trial begins somewhere new
      idealEdgeLength: () => 170, // room for edge labels between node circles
      nodeRepulsion: () => 8000,
      ...(fixed.length ? { fixedNodeConstraint: fixed } : {}),
    } as never)
    layout.one('layoutstop', () => {
      const out: Record<string, Position> = {}
      head.nodes().forEach((n) => {
        out[n.id()] = { ...n.position() }
      })
      head.destroy()
      resolve(out)
    })
    layout.run()
  })
}

const shuffled = <T,>(arr: T[]): T[] => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length

/**
 * Lay an aligned bundle out as equidistant lanes. Three moves, in order:
 *
 * 1. The lane ORDER is searched — the current order plus a few random
 *    shuffles, scored by how many rails the bundle's own inter-rail edges
 *    cross without terminating there — so heavily connected rails end up
 *    neighbors.
 * 2. Free nodes with edges into the bundle are tried at every gap (outside
 *    the first lane, between each pair, outside the last) and take the gap
 *    whose edges cross the fewest rails — they interleave between the rails
 *    they connect. A perfect score isn't always possible; least-bad wins.
 * 3. Free nodes with no edge into the bundle are pushed out of the band
 *    sideways — nothing unrelated sits between lanes.
 *
 * A pinned rail keeps its geometry and anchors the whole grid; pinned free
 * nodes are never moved. Mutates `positions` (free nodes) and returns the
 * rails' new geometries.
 */
function layoutLaneBundle(args: {
  rails: { id: string; geom: SkewerGeom; mine: string[]; ts?: number[] }[]
  positions: Record<string, Position>
  edges: { from: string; to: string }[]
  ownerOf: Map<string, string>
  visN: Set<string>
  pinnedNodes: Set<string>
}): Record<string, SkewerGeom> {
  const { rails, positions, edges, ownerOf, visN, pinnedNodes } = args
  const n = rails.length
  const refIdx = Math.max(rails.findIndex((r) => r.geom.pinned), 0)
  const ang = angleOf(rails[refIdx].geom)
  const ux = Math.cos(ang)
  const uy = Math.sin(ang)
  const nx = -uy
  const ny = ux
  const lens = rails.map((r) => Math.hypot(r.geom.b.x - r.geom.a.x, r.geom.b.y - r.geom.a.y))
  const maxHalf = Math.max(...lens) / 2
  const off = (lane: number) => (lane - (n - 1) / 2) * LANE_GAP

  // Members' offsets along their own rail, centered on the rail's midpoint.
  const railIdxOf = new Map(rails.map((r, i) => [r.id, i]))
  const memberU = new Map<string, number>()
  rails.forEach((r, i) => {
    r.mine.forEach((m, j) => {
      const f = r.ts?.[j] ?? (j + 0.5) / r.mine.length
      memberU.set(m, (f - 0.5) * lens[i])
    })
  })

  const railEdges: { ia: number; ib: number; ua: number; ub: number }[] = []
  for (const e of edges) {
    const ia = railIdxOf.get(ownerOf.get(e.from) ?? '')
    const ib = railIdxOf.get(ownerOf.get(e.to) ?? '')
    const ua = memberU.get(e.from)
    const ub = memberU.get(e.to)
    if (ia === undefined || ib === undefined || ia === ib) continue
    if (ua === undefined || ub === undefined) continue
    railEdges.push({ ia, ib, ua, ub })
  }

  /** Rails the segment (u1,p1)→(u2,p2) crosses without terminating on them,
   * under the lane assignment laneRail (lane -> rail index). */
  const crossings = (laneRail: number[], u1: number, p1: number, u2: number, p2: number): number => {
    let c = 0
    for (let k = 0; k < n; k++) {
      const pk = off(k)
      if ((pk - p1) * (pk - p2) >= -1e-9) continue // not strictly between
      const t = (pk - p1) / (p2 - p1)
      const uc = u1 + t * (u2 - u1)
      if (Math.abs(uc) <= lens[laneRail[k]] / 2 + NODE_SIZE / 2 + 6) c++
    }
    return c
  }

  const scoreOrder = (laneRail: number[]): number => {
    const laneOf: number[] = []
    laneRail.forEach((r, lane) => (laneOf[r] = lane))
    let s = 0
    for (const e of railEdges) {
      s += crossings(laneRail, e.ua, off(laneOf[e.ia]), e.ub, off(laneOf[e.ib]))
    }
    return s
  }

  let laneRail = rails.map((_, i) => i)
  let orderScore = scoreOrder(laneRail)
  for (let t = 0; t < 24 && orderScore > 0; t++) {
    const cand = shuffled(laneRail)
    const sc = scoreOrder(cand)
    if (sc < orderScore) {
      orderScore = sc
      laneRail = cand
    }
  }
  const laneOfRail: number[] = []
  laneRail.forEach((r, lane) => (laneOfRail[r] = lane))

  // A pinned rail anchors the grid; otherwise it centers on the current mids.
  const mids = rails.map((r) => ({
    x: (r.geom.a.x + r.geom.b.x) / 2,
    y: (r.geom.a.y + r.geom.b.y) / 2,
  }))
  const pinnedIdx = rails.findIndex((r) => r.geom.pinned)
  const center: Position =
    pinnedIdx >= 0
      ? {
          x: mids[pinnedIdx].x - nx * off(laneOfRail[pinnedIdx]),
          y: mids[pinnedIdx].y - ny * off(laneOfRail[pinnedIdx]),
        }
      : { x: mean(mids.map((m) => m.x)), y: mean(mids.map((m) => m.y)) }

  const out: Record<string, SkewerGeom> = {}
  rails.forEach((r, i) => {
    if (r.geom.pinned) {
      out[r.id] = r.geom
      return
    }
    const o = off(laneOfRail[i])
    const mid = { x: center.x + nx * o, y: center.y + ny * o }
    const hx = ux * (lens[i] / 2)
    const hy = uy * (lens[i] / 2)
    out[r.id] = {
      a: { x: mid.x - hx, y: mid.y - hy },
      b: { x: mid.x + hx, y: mid.y + hy },
      pinned: false,
    }
  })

  const midU = rails.map((r) => {
    const geom = out[r.id]
    return ((geom.a.x + geom.b.x) / 2 - center.x) * ux + ((geom.a.y + geom.b.y) / 2 - center.y) * uy
  })
  const loc = (p: Position) => ({
    u: (p.x - center.x) * ux + (p.y - center.y) * uy,
    p: (p.x - center.x) * nx + (p.y - center.y) * ny,
  })
  const memberLocal = (m: string) => {
    const i = railIdxOf.get(ownerOf.get(m)!)!
    return { u: midU[i] + memberU.get(m)!, p: off(laneOfRail[i]) }
  }

  // Free visible nodes, split into bundle-connected (to interleave) and not.
  const adj = new Map<string, string[]>()
  const others = new Map<string, string[]>()
  const isBundleMember = (id: string) => railIdxOf.has(ownerOf.get(id) ?? '')
  for (const e of edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      if (ownerOf.has(a) || !visN.has(a) || pinnedNodes.has(a)) continue
      if (isBundleMember(b)) adj.set(a, [...(adj.get(a) ?? []), b])
      else others.set(a, [...(others.get(a) ?? []), b])
    }
  }

  const gapP = (gp: number) =>
    gp === 0 ? off(0) - LANE_GAP * 0.75 : gp === n ? off(n - 1) + LANE_GAP * 0.75 : (off(gp - 1) + off(gp)) / 2

  // Most-connected first, and each placement is visible to the next node's
  // scoring through `positions`.
  const connected = [...adj.entries()].sort((x, y) => y[1].length - x[1].length)
  for (const [id, nbrs] of connected) {
    const locals = nbrs.map(memberLocal)
    const uMean = Math.max(-maxHalf, Math.min(maxHalf, mean(locals.map((l) => l.u))))
    const meanLaneP = mean(locals.map((l) => l.p))
    let bestGap = 0
    let bestCost = Infinity
    for (let gp = 0; gp <= n; gp++) {
      const p = gapP(gp)
      let cost = 0
      for (const l of locals) cost += crossings(laneRail, uMean, p, l.u, l.p)
      for (const o of others.get(id) ?? []) {
        const po = positions[o]
        if (!po) continue
        const lo = loc(po)
        cost += crossings(laneRail, uMean, p, lo.u, lo.p)
      }
      // Tiny tiebreak: among equal-crossing gaps, sit nearest the neighbors.
      const withTie = cost + Math.abs(p - meanLaneP) / (n * LANE_GAP * 100)
      if (withTie < bestCost) {
        bestCost = withTie
        bestGap = gp
      }
    }
    const p = gapP(bestGap)
    positions[id] = { x: center.x + ux * uMean + nx * p, y: center.y + uy * uMean + ny * p }
  }

  // Nothing unrelated between the lanes: push it out the nearest side.
  const bandHalfP = ((n - 1) / 2) * LANE_GAP + LANE_GAP * 0.75
  const bandHalfU = maxHalf + 50
  for (const id of Object.keys(positions)) {
    if (adj.has(id) || ownerOf.has(id) || !visN.has(id) || pinnedNodes.has(id)) continue
    const lp = loc(positions[id])
    if (Math.abs(lp.p) >= bandHalfP || Math.abs(lp.u) >= bandHalfU) continue
    const side = lp.p >= 0 ? 1 : -1
    positions[id] = {
      x: center.x + ux * lp.u + nx * side * (bandHalfP + 40),
      y: center.y + uy * lp.u + ny * side * (bandHalfP + 40),
    }
  }

  return out
}

/** Rigid-body layout with random restarts: collapse each skewer into one long
 * thin meta-node — and each aligned BUNDLE into one meta-node, laid out
 * internally as equidistant lanes (see layoutLaneBundle) — run fcose on the
 * quotient graph from THREE random starts, de-collide each result, score them
 * (residual collisions, then crossings), and commit the best. Click again for
 * a new roll of the dice. */
export async function runLayout(): Promise<void> {
  const st = useStore.getState()
  const g = st.graph
  const v = st.view()
  if (!g || !v) return
  const { nodes: visN, edges: visE } = visibleSets(g, v)
  const skewers = skewersOf(g).filter(
    (s) => skewerShown(v, s.id) && s.members.some((m) => visN.has(m)),
  )
  const memberOf = new Map<string, string>()
  for (const s of skewers) {
    for (const m of s.members) if (!memberOf.has(m)) memberOf.set(m, s.id)
  }
  const geoms: Record<string, SkewerGeom> = {}
  for (const s of skewers) {
    geoms[s.id] = v.layout.skewers[s.id] ?? defaultGeom(s.members, v.layout.seedPositions)
  }

  // Aligned bundles are laid out as lanes and travel through fcose as ONE
  // rigid body each; their internals are arranged by layoutLaneBundle.
  const laneGroups = new Map<string, Skewer[]>()
  for (const s of skewers) {
    if (s.group && groupOpts(v, s.group).align) {
      laneGroups.set(s.group, [...(laneGroups.get(s.group) ?? []), s])
    }
  }
  const railBundle = new Map<string, string>()
  for (const [group, rails] of laneGroups) for (const s of rails) railBundle.set(s.id, group)

  const mineOf: Record<string, string[]> = {}
  const tsOf: Record<string, number[] | undefined> = {}
  for (const s of skewers) {
    const mine = s.members.filter((m) => visN.has(m) && memberOf.get(m) === s.id)
    mineOf[s.id] = mine
    tsOf[s.id] = railTs(v, s.id, mine)
  }

  const seed = v.layout.seedPositions
  const pinnedNodes = new Set(v.layout.pinned)
  const els: cytoscape.ElementDefinition[] = []
  const fixed: { nodeId: string; position: Position }[] = []

  for (const s of skewers) {
    if (railBundle.has(s.id)) continue
    const geom = geoms[s.id]
    const mid = { x: (geom.a.x + geom.b.x) / 2, y: (geom.a.y + geom.b.y) / 2 }
    els.push({
      group: 'nodes',
      data: {
        id: s.id,
        w: Math.abs(geom.b.x - geom.a.x) + 50,
        h: Math.abs(geom.b.y - geom.a.y) + 50,
      },
      position: mid,
    })
    if (geom.pinned) fixed.push({ nodeId: s.id, position: mid })
  }
  const bundleCentroids = new Map<string, Position>()
  for (const [group, rails] of laneGroups) {
    const mids = rails.map((s) => {
      const geom = geoms[s.id]
      return { x: (geom.a.x + geom.b.x) / 2, y: (geom.a.y + geom.b.y) / 2 }
    })
    const centroid = { x: mean(mids.map((m) => m.x)), y: mean(mids.map((m) => m.y)) }
    bundleCentroids.set(group, centroid)
    const ref = rails.find((s) => geoms[s.id].pinned) ?? rails[0]
    const ang = angleOf(geoms[ref.id])
    const w = Math.max(...rails.map((s) => {
      const geom = geoms[s.id]
      return Math.hypot(geom.b.x - geom.a.x, geom.b.y - geom.a.y)
    })) + 100
    const h = (rails.length - 1) * LANE_GAP + 100
    els.push({
      group: 'nodes',
      data: {
        id: `qb:${group}`,
        w: Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * h,
        h: Math.abs(Math.sin(ang)) * w + Math.abs(Math.cos(ang)) * h,
      },
      position: centroid,
    })
    if (rails.some((s) => geoms[s.id].pinned)) fixed.push({ nodeId: `qb:${group}`, position: centroid })
  }
  for (const id of visN) {
    if (memberOf.has(id)) continue
    const pos = seed[id] ?? { x: 0, y: 0 }
    els.push({ group: 'nodes', data: { id, w: 40, h: 40 }, position: { ...pos } })
    if (pinnedNodes.has(id)) fixed.push({ nodeId: id, position: { ...pos } })
  }
  const quo = (id: string): string => {
    const rail = memberOf.get(id)
    if (!rail) return id
    const b = railBundle.get(rail)
    return b ? `qb:${b}` : rail
  }
  const seen = new Set<string>()
  for (const e of g.edges) {
    if (!visE.has(`${e.type}|${e.from}|${e.to}`)) continue
    const src = quo(e.from)
    const dst = quo(e.to)
    if (src === dst) continue
    const key = src < dst ? `${src}~${dst}` : `${dst}~${src}`
    if (seen.has(key)) continue
    seen.add(key)
    els.push({ group: 'edges', data: { id: `q:${key}`, source: src, target: dst } })
  }
  // A lane bundle is worth arranging even when it's the only thing on canvas.
  if (els.filter((e) => e.group === 'nodes').length < 2 && !laneGroups.size) {
    st.setStatus('nothing to lay out')
    return
  }

  const visEdgeList = g.edges
    .filter((e) => visE.has(`${e.type}|${e.from}|${e.to}`))
    .map((e) => ({ from: e.from, to: e.to }))


  const TRIALS = 3
  let best:
    | {
        free: Record<string, Position>
        geoms: Record<string, SkewerGeom>
        settled: boolean
        score: number
        collisions: number
        crossings: number
      }
    | null = null

  for (let t = 0; t < TRIALS; t++) {
    const positions = await runQuotientTrial(els, fixed)

    // Expand the quotient: translate each skewer by its meta-node's movement,
    // then arrange each lane bundle internally at its meta-node's landing.
    const rigs: Record<string, SkewerRig> = {}
    for (const s of skewers) {
      if (railBundle.has(s.id)) continue
      const geom = geoms[s.id]
      const oldMid = { x: (geom.a.x + geom.b.x) / 2, y: (geom.a.y + geom.b.y) / 2 }
      const newMid = positions[s.id]
      const dx = newMid.x - oldMid.x
      const dy = newMid.y - oldMid.y
      delete positions[s.id]
      rigs[s.id] = {
        geom: {
          a: { x: geom.a.x + dx, y: geom.a.y + dy },
          b: { x: geom.b.x + dx, y: geom.b.y + dy },
          pinned: geom.pinned,
        },
        visMembers: mineOf[s.id],
        ts: tsOf[s.id],
      }
    }
    for (const [group, rails] of laneGroups) {
      const centroid = bundleCentroids.get(group)!
      const landed = positions[`qb:${group}`] ?? centroid
      const dx = landed.x - centroid.x
      const dy = landed.y - centroid.y
      delete positions[`qb:${group}`]
      const laneGeoms = layoutLaneBundle({
        rails: rails.map((s) => {
          const geom = geoms[s.id]
          return {
            id: s.id,
            geom: geom.pinned
              ? geom
              : {
                  a: { x: geom.a.x + dx, y: geom.a.y + dy },
                  b: { x: geom.b.x + dx, y: geom.b.y + dy },
                  pinned: false,
                },
            mine: mineOf[s.id],
            ts: tsOf[s.id],
          }
        }),
        positions,
        edges: visEdgeList,
        ownerOf: memberOf,
        visN,
        pinnedNodes,
      })
      for (const s of rails) {
        rigs[s.id] = { geom: laneGeoms[s.id], visMembers: mineOf[s.id], ts: tsOf[s.id] }
      }
    }

    // De-collide the real geometry, greedily shorten over-long edges while
    // the score tolerates it, then score the settled result.
    const resolved = resolveCollisions(positions, pinnedNodes, rigs, visEdgeList)
    const resolvedRigs: Record<string, SkewerRig> = Object.fromEntries(
      Object.entries(rigs).map(([sid, r]) => [
        sid,
        { geom: resolved.geoms[sid], visMembers: r.visMembers, ts: r.ts },
      ]),
    )
    const compacted = compactEdges(resolved.free, pinnedNodes, resolvedRigs, visEdgeList)
    // De-collision and compaction can drift an aligned bundle: re-impose the
    // align contract against the reference rail, then re-snap the lanes to
    // the equidistant grid (order kept; a pinned rail anchors it).
    for (const [, rails] of laneGroups) {
      const present = rails.map((s) => s.id).filter((id) => compacted.geoms[id])
      const refId = present.find((id) => compacted.geoms[id].pinned) ?? present[0]
      if (!refId) continue
      for (const id of present) {
        if (id === refId || compacted.geoms[id].pinned) continue
        compacted.geoms[id] = alignGeom(compacted.geoms[refId], compacted.geoms[id])
      }
      Object.assign(
        compacted.geoms,
        snapLanes(present.map((id) => ({ id, geom: compacted.geoms[id] })), LANE_GAP),
      )
    }
    const compactedRigs: Record<string, SkewerRig> = Object.fromEntries(
      Object.entries(resolvedRigs).map(([sid, r]) => [
        sid,
        { geom: compacted.geoms[sid], visMembers: r.visMembers, ts: r.ts },
      ]),
    )
    const sc = scoreArrangement(compacted.free, compactedRigs, visEdgeList)
    if (!best || sc.score < best.score) {
      best = { free: compacted.free, geoms: compacted.geoms, settled: resolved.settled, ...sc }
    }
  }
  if (!best) return

  for (const [sid, geom] of Object.entries(best.geoms)) {
    st.setSkewerGeom(sid, geom)
  }
  st.setPositions(best.free)
  fitAfterBuild.flag = true
  st.bump()
  const noun = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  st.setStatus(
    `layout: best of ${TRIALS} — ${noun(best.collisions, 'collision')}, ${noun(best.crossings, 'crossing')}` +
      (best.settled ? '' : ' (not fully resolved)') +
      ' — click Layout again for a different roll',
  )
}

/** The floating axis for one proportionally spaced bundle: a segment beside
 * its rails, pointing the reference rail's way, spanning their extent. Ticks
 * are plain dots with value labels; the whole thing is inert (no
 * grab/select). */
function axisElements(
  key: string,
  info: AxisInfo,
  geoms: SkewerGeom[],
): cytoscape.ElementDefinition[] {
  if (!geoms.length) return []
  const AXIS_OFFSET = 90 // clearance between the rails' extent and the rule
  const ang = angleOf(geoms[0])
  const ux = Math.cos(ang)
  const uy = Math.sin(ang)
  const nx = -uy
  const ny = ux
  let sMin = Infinity
  let sMax = -Infinity
  let pMax = -Infinity
  for (const geom of geoms) {
    for (const p of [geom.a, geom.b]) {
      sMin = Math.min(sMin, p.x * ux + p.y * uy)
      sMax = Math.max(sMax, p.x * ux + p.y * uy)
      pMax = Math.max(pMax, p.x * nx + p.y * ny)
    }
  }
  const off = pMax + AXIS_OFFSET
  const at = (f: number): Position => ({
    x: (sMin + (sMax - sMin) * f) * ux + off * nx,
    y: (sMin + (sMax - sMin) * f) * uy + off * ny,
  })
  const span = info.max - info.min
  const marks = [
    { t: info.min, f: 0 },
    ...axisTicks(info.min, info.max, info.isDate).map((t) => ({ t, f: (t - info.min) / span })),
    { t: info.max, f: 1 },
  ]
  const out: cytoscape.ElementDefinition[] = []
  marks.forEach((m, i) => {
    out.push({
      group: 'nodes',
      data: { id: `axis:${key}:${i}`, label: formatOrderValue(m.t, info.isDate) },
      position: at(m.f),
      classes: 'axis-tick',
      selectable: false,
      grabbable: false,
    })
    if (i > 0) {
      out.push({
        group: 'edges',
        data: { id: `axisl:${key}:${i}`, source: `axis:${key}:${i - 1}`, target: `axis:${key}:${i}` },
        classes: 'axis-line',
        selectable: false,
      })
    }
  })
  return out
}

export function GraphCanvas() {
  const divRef = useRef<HTMLDivElement>(null)
  const firstBuild = useRef(true)
  const version = useStore((s) => s.version)
  const viewId = useStore((s) => s.viewId)
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)

  // Create the instance once.
  useEffect(() => {
    const cy = cytoscape({
      container: divRef.current,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            width: NODE_SIZE,
            height: NODE_SIZE,
            'font-size': 11,
            color: '#333',
            'text-valign': 'bottom',
            'text-margin-y': 6,
          },
        },
        { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#111' } },
        {
          selector: 'node.pinned',
          style: { 'border-width': 2, 'border-color': '#555', 'border-style': 'double' },
        },
        {
          selector: 'node.sel-secondary',
          style: { 'border-width': 3, 'border-color': '#94a3b8', 'border-style': 'dotted' },
        },
        {
          selector: 'node.sel-primary',
          style: { 'border-width': 3, 'border-color': '#2563eb' },
        },
        {
          selector: 'node.focus-center',
          style: {
            'background-image': CROSSHAIR,
            'background-fit': 'none',
            'background-width': '44px',
            'background-height': '44px',
            'background-clip': 'none',
            'bounds-expansion': '12px',
          } as never,
        },
        {
          selector: 'node.skewer-handle', // the b end: a small grip under the arrowhead
          style: {
            width: 11,
            height: 11,
            shape: 'diamond',
            'background-color': 'data(tint)', // the rail's dark-end color (see ramp)
            label: '',
          },
        },
        {
          selector: 'node.skewer-bulb', // the a end: the bulb carries the name
          style: {
            width: 18,
            height: 18,
            shape: 'ellipse',
            'background-color': 'data(tint)',
            label: 'data(label)',
            'font-size': 9,
            color: 'data(tint)',
            'text-valign': 'bottom',
            'text-margin-y': 5,
          },
        },
        {
          // Only real graph edges carry etype/color data; rails style themselves.
          selector: 'edge[etype]',
          style: {
            width: 2,
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 1.1,
            'curve-style': 'bezier',
            label: 'data(etype)',
            'font-size': 9,
            color: '#666',
            'text-rotation': 'autorotate',
            'text-background-color': '#fff',
            'text-background-opacity': 0.9,
            'text-background-padding': '2',
          } as never,
        },
        // Edges touching the primary-selected node thicken so its
        // connections read at a glance.
        { selector: 'edge.sel-incident', style: { width: 4 } },
        { selector: 'edge:selected', style: { width: 4 } },
        {
          selector: 'edge.sel-secondary',
          style: { width: 3, 'overlay-color': '#94a3b8', 'overlay-padding': 3, 'overlay-opacity': 0.15 } as never,
        },
        {
          selector: 'edge.sel-primary',
          style: { width: 4, 'overlay-color': '#2563eb', 'overlay-padding': 3, 'overlay-opacity': 0.15 } as never,
        },
        {
          // Both endpoints on the same skewer: the straight line would lie on
          // the rail. Bow out perpendicular to it, arc-diagram style.
          selector: 'edge.arc',
          style: {
            'curve-style': 'unbundled-bezier',
            'control-point-distances': 'data(arcDist)',
            'control-point-weights': '0.5',
          } as never,
        },
        {
          // Rails are chains of segments threading through their members in
          // order — straight through owned members, bending at members owned
          // by a higher-priority skewer. Each segment's color comes from a
          // light→dark ramp along the chain (direction), computed at build.
          selector: 'edge.rail',
          style: {
            width: RAIL_WIDTH,
            'curve-style': 'straight',
            'line-color': 'data(segColor)',
            opacity: 0.75,
          } as never,
        },
        {
          selector: 'edge.rail.rail-tip', // last segment carries the arrowhead
          style: {
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'data(segColor)',
            'arrow-scale': 1.4,
          } as never,
        },
        {
          selector: 'edge.rail.rail-pinned',
          style: { width: RAIL_WIDTH + 2 } as never,
        },
        { selector: 'edge.rail:selected', style: { width: RAIL_WIDTH + 3, opacity: 1 } },
        {
          selector: 'node.axis-tick',
          style: {
            width: 7,
            height: 7,
            shape: 'ellipse',
            'background-color': '#94a3b8',
            label: 'data(label)',
            'font-size': 9,
            color: '#64748b',
            'text-valign': 'bottom',
            'text-margin-y': 4,
          },
        },
        {
          selector: 'edge.axis-line',
          style: { width: 2, 'curve-style': 'straight', 'line-color': '#cbd5e1' } as never,
        },
        // Fringe nodes dim by their components — fill, label, crosshair —
        // not element opacity, so a selection border still draws bright on a
        // dimmed node. Edges have no such marker; they dim wholesale.
        {
          selector: 'node.fringe-near',
          style: {
            'background-opacity': FRINGE_NEAR_OPACITY,
            'text-opacity': FRINGE_NEAR_OPACITY,
            'background-image-opacity': FRINGE_NEAR_OPACITY,
          } as never,
        },
        {
          selector: 'node.fringe-outer',
          style: {
            'background-opacity': FRINGE_OUTER_OPACITY,
            'text-opacity': FRINGE_OUTER_OPACITY,
            'background-image-opacity': FRINGE_OUTER_OPACITY,
          } as never,
        },
        { selector: 'edge.fringe-near', style: { opacity: FRINGE_NEAR_OPACITY } },
        { selector: 'edge.fringe-outer', style: { opacity: FRINGE_OUTER_OPACITY } },
      ],
    })
    cyRef.current = cy

    // Native cy selection (shift-click / box) feeds bulk operations only.
    const syncMulti = () => {
      useStore.getState().setMultiNodes(cy.$('node:selected').map((n) => n.id()))
    }
    cy.on('select unselect', syncMulti)

    // Two-slot selection: every tap promotes to primary, old primary trails.
    cy.on('tap', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      if (n.hasClass('skewer-handle') || n.hasClass('axis-tick')) return
      useStore.getState().tapSelect({ kind: 'node', id: n.id() })
    })
    cy.on('tap', 'edge', (evt) => {
      const e = evt.target as cytoscape.EdgeSingular
      const st = useStore.getState()
      if (e.hasClass('rail')) st.tapSelect({ kind: 'skewer', id: e.data('skewer') as string })
      else st.tapSelect({ kind: 'edge', id: e.id() })
    })
    cy.on('tap', (evt) => {
      if (evt.target === cy) useStore.getState().tapSelect(null)
    })

    // -- skewer dragging --------------------------------------------------------
    // Three distinct gestures: drag the RAIL to translate the whole skewer,
    // drag an END HANDLE to rotate/stretch it, drag a MEMBER to slide it
    // along the rail (hand-placing its fraction, kept between its rail
    // neighbors so the stored order stays true).
    let dragCtx: {
      kind: 'slide' | 'handle'
      skewer: string
      grabbedId: string
      slideT?: number
    } | null = null

    cy.on('grab', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      const sc = scratch(cy)
      const asHandle = n.hasClass('skewer-handle')
      const skewer = asHandle ? (n.data('skewer') as string) : sc.memberOf.get(n.id())
      if (!skewer || !sc.rigs[skewer]) {
        dragCtx = null
        return
      }
      dragCtx = { kind: asHandle ? 'handle' : 'slide', skewer, grabbedId: n.id() }
    })

    /** Impose the dragged rail's geometry on its ALIGNED bundle mates, live:
     * each takes the dragged segment offset only sideways (see alignGeom).
     * Pinned rails stay put. */
    const syncBundle = (skewer: string, refGeom: SkewerGeom) => {
      const sc = scratch(cy)
      for (const pid of sc.alignPeers.get(skewer) ?? []) {
        const peer = sc.rigs[pid]
        if (!peer || peer.geom.pinned) continue
        peer.geom = alignGeom(refGeom, peer.geom)
        cy.$id(handleId(pid, 'a')).position({ ...peer.geom.a })
        cy.$id(handleId(pid, 'b')).position({ ...peer.geom.b })
        for (const [id, p] of Object.entries(placeAlong(peer.geom, peer.visMembers, peer.ts)))
          cy.$id(id).position(p)
      }
    }

    cy.on('drag', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      if (!dragCtx || n.id() !== dragCtx.grabbedId) return
      const sc = scratch(cy)
      const rig = sc.rigs[dragCtx.skewer]
      if (!rig) return
      if (dragCtx.kind === 'slide') {
        // Project the pointer's node onto the rail and pin it there, clamped
        // between its rail neighbors (their current fractions) — sliding
        // hand-places the node without contradicting the stored order.
        const { a, b } = rig.geom
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len2 = dx * dx + dy * dy || 1
        const p = n.position()
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
        const i = rig.visMembers.indexOf(n.id())
        const ts = rig.ts ?? rig.visMembers.map((_, j) => (j + 0.5) / rig.visMembers.length)
        const ORDER_GAP = 0.015
        const lo = i > 0 ? ts[i - 1] + ORDER_GAP : 0.02
        const hi = i < ts.length - 1 ? ts[i + 1] - ORDER_GAP : 0.98
        t = lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, t))
        dragCtx.slideT = t
        n.position({ x: a.x + dx * t, y: a.y + dy * t })
      } else {
        // Rotate/stretch: the segment follows the handles; members re-place.
        const geom: SkewerGeom = {
          a: { ...cy.$id(handleId(dragCtx.skewer, 'a')).position() },
          b: { ...cy.$id(handleId(dragCtx.skewer, 'b')).position() },
          pinned: rig.geom.pinned,
        }
        rig.geom = geom
        const placed = placeAlong(geom, rig.visMembers, rig.ts)
        for (const [id, p] of Object.entries(placed)) cy.$id(id).position(p)
        syncBundle(dragCtx.skewer, geom)
      }
    })

    cy.on('dragfree', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      const st = useStore.getState()
      if (dragCtx && n.id() === dragCtx.grabbedId) {
        const ctx = dragCtx
        dragCtx = null
        const sc = scratch(cy)
        const rig = sc.rigs[ctx.skewer]
        if (ctx.kind === 'slide') {
          // Bake the hand-placed fraction (a no-op grab leaves everything be).
          if (ctx.slideT !== undefined && rig) {
            const i = rig.visMembers.indexOf(ctx.grabbedId)
            const ts = rig.ts ?? rig.visMembers.map((_, j) => (j + 0.5) / rig.visMembers.length)
            ts[i] = ctx.slideT
            rig.ts = ts
            st.setMemberFrac(ctx.skewer, ctx.grabbedId, ctx.slideT)
          }
          return
        }
        const geom: SkewerGeom = {
          a: { ...cy.$id(handleId(ctx.skewer, 'a')).position() },
          b: { ...cy.$id(handleId(ctx.skewer, 'b')).position() },
          pinned: rig?.geom.pinned ?? false,
        }
        if (rig) rig.geom = geom
        // The drag synced the aligned bundle mates along: commit their rails.
        for (const pid of sc.alignPeers.get(ctx.skewer) ?? []) {
          const peer = sc.rigs[pid]
          if (peer && !peer.geom.pinned) st.setSkewerGeom(pid, peer.geom)
        }
        // A group axis is derived from its rails at build time: rebuild so it
        // follows the moved rail (other drags keep skipping the rebuild).
        st.setSkewerGeom(ctx.skewer, geom, { rebuild: sc.axisSkewers.has(ctx.skewer) })
        return
      }
      const positions: Record<string, Position> = {}
      positions[n.id()] = { ...n.position() }
      cy.$('node:selected').forEach((sel) => {
        if (!sel.hasClass('skewer-handle')) positions[sel.id()] = { ...sel.position() }
      })
      st.setPositions(positions)
    })

    // Translating a skewer = dragging its RAIL. Rails are edges (not natively
    // grabbable), so this is a manual gesture: tapstart on a rail suspends
    // panning, tapdrags translate the rig — handles, owned members, and
    // (under align) the whole bundle — and tapend commits. A small threshold
    // keeps a plain click as selection without a stray nudge.
    let railDrag: { skewer: string; last: Position; moved: number; active: boolean } | null = null
    cy.on('tapstart', 'edge.rail', (evt) => {
      const skewer = (evt.target as cytoscape.EdgeSingular).data('skewer') as string
      if (!scratch(cy).rigs[skewer]) return
      railDrag = { skewer, last: { ...evt.position }, moved: 0, active: false }
      cy.userPanningEnabled(false)
      cy.boxSelectionEnabled(false) // else the drag also paints a selection box
    })
    cy.on('tapdrag', (evt) => {
      if (!railDrag) return
      const sc = scratch(cy)
      const rig = sc.rigs[railDrag.skewer]
      if (!rig) return
      const dx = evt.position.x - railDrag.last.x
      const dy = evt.position.y - railDrag.last.y
      railDrag.last = { ...evt.position }
      railDrag.moved += Math.hypot(dx, dy)
      if (!railDrag.active && railDrag.moved < 4) return
      railDrag.active = true
      rig.geom = {
        a: { x: rig.geom.a.x + dx, y: rig.geom.a.y + dy },
        b: { x: rig.geom.b.x + dx, y: rig.geom.b.y + dy },
        pinned: rig.geom.pinned,
      }
      cy.$id(handleId(railDrag.skewer, 'a')).position({ ...rig.geom.a })
      cy.$id(handleId(railDrag.skewer, 'b')).position({ ...rig.geom.b })
      for (const [id, p] of Object.entries(placeAlong(rig.geom, rig.visMembers, rig.ts)))
        cy.$id(id).position(p)
      // GROUPED bundle mates ride along rigidly: same delta, own geometry.
      // Aligned mates are skipped here — syncBundle below conforms them, and
      // applying both would move them twice.
      const aligned = new Set(sc.alignPeers.get(railDrag.skewer) ?? [])
      for (const pid of sc.groupPeers.get(railDrag.skewer) ?? []) {
        const peer = sc.rigs[pid]
        if (!peer || peer.geom.pinned || aligned.has(pid)) continue
        peer.geom = {
          a: { x: peer.geom.a.x + dx, y: peer.geom.a.y + dy },
          b: { x: peer.geom.b.x + dx, y: peer.geom.b.y + dy },
          pinned: peer.geom.pinned,
        }
        cy.$id(handleId(pid, 'a')).position({ ...peer.geom.a })
        cy.$id(handleId(pid, 'b')).position({ ...peer.geom.b })
        for (const [id, p] of Object.entries(placeAlong(peer.geom, peer.visMembers, peer.ts)))
          cy.$id(id).position(p)
      }
      syncBundle(railDrag.skewer, rig.geom)
    })
    cy.on('tapend', () => {
      if (!railDrag) return
      const { skewer, active } = railDrag
      railDrag = null
      cy.userPanningEnabled(true)
      cy.boxSelectionEnabled(true)
      if (!active) return
      const st = useStore.getState()
      const sc = scratch(cy)
      const rig = sc.rigs[skewer]
      if (!rig) return
      const peers = new Set([
        ...(sc.alignPeers.get(skewer) ?? []),
        ...(sc.groupPeers.get(skewer) ?? []),
      ])
      for (const pid of peers) {
        const peer = sc.rigs[pid]
        if (peer && !peer.geom.pinned) st.setSkewerGeom(pid, peer.geom)
      }
      st.setSkewerGeom(skewer, rig.geom, { rebuild: sc.axisSkewers.has(skewer) })
    })

    return () => {
      cyRef.current = null
      cy.destroy()
    }
  }, [])

  // Rebuild elements when the graph structure or the view changes.
  useEffect(() => {
    const cy = cyRef.current
    const st = useStore.getState()
    const g = st.graph
    const v = st.view()
    if (!cy || !g || !v) return

    const { nodes: visN, edges: visE } = visibleSets(g, v)
    const seed = v.layout.seedPositions
    const pinned = new Set(v.layout.pinned)

    // Periphery dimming: the frontier of what's shown, not fixed hop bands —
    // summoning a distant node moves the frontier out along its path.
    const dim = peripheryDim(g, v, visN, visE)
    const dimClass = (level: DimLevel | undefined): string =>
      level === 'outer' ? 'fringe-outer' : level === 'near' ? 'fringe-near' : ''

    // Interpret skewers: geometry (persisted or derived), member placement.
    // Shared members are placed by their owner (first skewer in priority
    // order); every other rail through them bends at their actual position.
    const memberOf = new Map<string, string>()
    const rigs: Record<string, Rig> = {}
    const derived: Record<string, Position> = {}
    const alignPeers = new Map<string, string[]>()
    const groupPeers = new Map<string, string[]>()
    const axisSkewers = new Set<string>()
    const alignIds = new Map<string, string[]>() // aligned bundle -> rig'd skewers
    const groupedIds = new Map<string, string[]>() // grouped bundle -> rig'd skewers
    const groupGeoms = new Map<string, SkewerGeom[]>() // bundle -> rig'd rail geoms (for the axis)
    for (const s of skewersOf(g)) {
      if (!skewerShown(v, s.id)) continue
      const visMembers = s.members.filter((m) => visN.has(m))
      if (!visMembers.length) continue
      for (const m of visMembers) {
        if (!memberOf.has(m)) memberOf.set(m, s.id)
      }
      const mine = visMembers.filter((m) => memberOf.get(m) === s.id)
      const geom = v.layout.skewers[s.id] ?? defaultGeom(s.members, seed)
      v.layout.skewers[s.id] = geom // derived defaults persist on next save
      const ts = railTs(v, s.id, mine)
      rigs[s.id] = { visMembers: mine, chain: visMembers, geom, ts }
      if (mine.length) Object.assign(derived, placeAlong(geom, mine, ts))
      if (s.group) {
        const opts = groupOpts(v, s.group)
        groupGeoms.set(s.group, [...(groupGeoms.get(s.group) ?? []), geom])
        if (opts.align) alignIds.set(s.group, [...(alignIds.get(s.group) ?? []), s.id])
        if (opts.grouped) groupedIds.set(s.group, [...(groupedIds.get(s.group) ?? []), s.id])
        if (opts.axis) axisSkewers.add(s.id)
      }
    }
    for (const ids of alignIds.values()) {
      for (const id of ids) alignPeers.set(id, ids.filter((x) => x !== id))
    }
    for (const ids of groupedIds.values()) {
      for (const id of ids) groupPeers.set(id, ids.filter((x) => x !== id))
    }

    // Unseeded free nodes appear near the centroid of everything placed.
    const known = [...visN]
      .map((id) => derived[id] ?? seed[id])
      .filter(Boolean)
    const centroid = known.length
      ? {
          x: known.reduce((s2, p) => s2 + p.x, 0) / known.length,
          y: known.reduce((s2, p) => s2 + p.y, 0) / known.length,
        }
      : { x: 0, y: 0 }
    let jitter = 0
    const jitterPos = (): Position => {
      jitter += 1
      const angle = jitter * 2.4 // golden-angle-ish spiral so they don't stack
      const r = 40 + 14 * jitter
      return { x: centroid.x + r * Math.cos(angle), y: centroid.y + r * Math.sin(angle) }
    }

    const elements: cytoscape.ElementDefinition[] = []
    for (const n of g.nodes) {
      if (!visN.has(n.id)) continue
      const classes = [
        pinned.has(n.id) ? 'pinned' : '',
        memberOf.has(n.id) ? 'skewer-member' : '',
        dimClass(dim.get(n.id)),
        fociOf(v).some((f) => f.node === n.id) ? 'focus-center' : '',
      ]
        .filter(Boolean)
        .join(' ')
      elements.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: n.label || n.id,
          color: nodeColor(g.schema, n, g.schema.nodeTypes[n.type]?.color || '#888'),
        },
        position: derived[n.id] ?? (seed[n.id] ? { ...seed[n.id] } : jitterPos()),
        classes: classes || undefined,
      })
    }
    // Position of each visible member along its rail, for arcing same-skewer edges.
    const memberPos = new Map<string, { skewer: string; idx: number }>()
    for (const [sid, rig] of Object.entries(rigs)) {
      rig.visMembers.forEach((m, i) => memberPos.set(m, { skewer: sid, idx: i }))
    }
    const parallel = new Map<string, number>() // same endpoint pair -> arc count

    for (const e of g.edges) {
      const key = `${e.type}|${e.from}|${e.to}`
      if (!visE.has(key)) continue
      const a = memberPos.get(e.from)
      const b = memberPos.get(e.to)
      let arc: { classes: string; arcDist: number } | null = null
      if (a && b && a.skewer === b.skewer) {
        const pairKey = e.from < e.to ? `${e.from}~${e.to}` : `${e.to}~${e.from}`
        const nth = parallel.get(pairKey) ?? 0
        parallel.set(pairKey, nth + 1)
        // Longer spans bow further (nested arcs stay apart); flipping the sign
        // for backward edges keeps every arc on the same side of the rail.
        const span = Math.abs(a.idx - b.idx)
        const sign = a.idx <= b.idx ? 1 : -1
        arc = { classes: 'arc', arcDist: sign * (26 + 18 * span + 16 * nth) }
      }
      // An edge fades with its more-dimmed endpoint.
      const order: Record<DimLevel, number> = { near: 1, outer: 2 }
      const lvl = (id: string) => (dim.get(id) ? order[dim.get(id)!] : 0)
      const edgeLevel = Math.max(lvl(e.from), lvl(e.to))
      const edgeClasses = [
        arc ? arc.classes : '',
        edgeLevel === 2 ? 'fringe-outer' : edgeLevel === 1 ? 'fringe-near' : '',
      ]
        .filter(Boolean)
        .join(' ')
      elements.push({
        group: 'edges',
        data: {
          id: key,
          source: e.from,
          target: e.to,
          etype: e.type,
          color: g.schema.edgeTypes[e.type]?.color || '#aaa',
          ...(arc ? { arcDist: arc.arcDist } : {}),
        },
        classes: edgeClasses || undefined,
      })
    }
    for (const [id, rig] of Object.entries(rigs)) {
      const skNode = g.nodes.find((n) => n.id === id)
      const label = skNode?.label || id
      // The schema's color binding reaches rails too: a skewer node carrying
      // the bound field (data[colorKey]) tints its whole rail — the tip,
      // handles, and bulb take the bound color exactly (matching the
      // legend), the base a whitened version. Pinned red still wins.
      const bound = skNode ? nodeColor(g.schema, skNode, '') : ''
      const ramp = rig.geom.pinned
        ? RAIL_PINNED_RAMP
        : bound
          ? [lerpHex('#ffffff', bound, 0.35), bound]
          : RAIL_RAMP
      const tint = ramp[1]
      for (const end of ['a', 'b'] as const) {
        elements.push({
          group: 'nodes',
          data: { id: handleId(id, end), skewer: id, end, tint, ...(end === 'a' ? { label } : {}) },
          position: { ...rig.geom[end] },
          // The a end is the labeled bulb at the base; b is the grip under the arrowhead.
          classes: end === 'a' ? 'skewer-handle skewer-bulb' : 'skewer-handle',
          selectable: false,
        })
      }
      // The rail: bulb → members in order → arrow grip, one segment per hop.
      const path = [handleId(id, 'a'), ...rig.chain, handleId(id, 'b')]
      const segs = path.length - 1
      for (let i = 0; i < segs; i++) {
        elements.push({
          group: 'edges',
          data: {
            // The id encodes the endpoints: cytoscape edges can't be rewired,
            // so when the chain changes (focus walk banishing members) a
            // segment with new endpoints must be a NEW element — a positional
            // id would be "kept" by the fade transition still wired to a
            // removed node, and vanish with it.
            id: `rail:${id}:${path[i]}>${path[i + 1]}`,
            source: path[i],
            target: path[i + 1],
            skewer: id,
            segColor: lerpHex(ramp[0], ramp[1], segs <= 1 ? 1 : i / (segs - 1)),
          },
          classes: [
            'rail',
            rig.geom.pinned ? 'rail-pinned' : '',
            i === segs - 1 ? 'rail-tip' : '',
          ]
            .filter(Boolean)
            .join(' '),
        })
      }
    }

    // Floating value axes: drawn while a proportional-order application is in
    // effect (its recorded range) — a light rule off to the side of the
    // bundle's rails, labeled min/max at the ends and round key values
    // (whole days/months for dates) in between.
    for (const [group, opts] of Object.entries(v.skewerGroups ?? {})) {
      const geoms = groupGeoms.get(group)
      if (!opts.axis || !geoms?.length) continue
      elements.push(...axisElements(group, opts.axis, geoms))
    }

    cy.scratch('kge', { memberOf, rigs, alignPeers, groupPeers, axisSkewers } satisfies KgeScratch)
    const animate = st.animateNext && !firstBuild.current && cy.elements().length > 0
    if (st.animateNext) useStore.setState({ animateNext: false })

    if (!animate) {
      cy.startBatch()
      cy.elements().remove()
      cy.add(elements)
      for (const id of st.multiNodes) cy.$id(id).select()
      applySel(cy, st.primary, st.secondary)
      cy.endBatch()
    } else {
      // Focus transition (selection-walk): banished elements fade out while
      // summoned ones fade in; kept nodes glide if they re-spaced (rail
      // members compact); then the viewport centers on the walked-to node.
      const FADE = 250
      const defById = new Map(elements.map((d) => [d.data!.id as string, d]))

      cy.elements().forEach((ele) => {
        const def = defById.get(ele.id())
        if (!def) {
          ele.animate({ style: { opacity: 0 } }, { duration: FADE, complete: () => ele.remove() })
          return
        }
        // Kept: crossfade if its fringe level changed, glide if it re-spaced.
        const before = Number(ele.style('opacity'))
        ele.classes((def.classes as string) ?? '')
        // Refresh data in place (rail ramp colors shift with the chain,
        // tints and labels change); id and endpoints are immutable — an
        // endpoint change produces a new element id instead.
        for (const [k, val] of Object.entries(def.data ?? {})) {
          if (k !== 'id' && k !== 'source' && k !== 'target') ele.data(k, val as never)
        }
        const after = targetOpacity(ele)
        if (Math.abs(after - before) > 0.01) {
          ele.style('opacity', before)
          ele.animate(
            { style: { opacity: after } },
            { duration: FADE, complete: () => ele.removeStyle('opacity') },
          )
        }
        if (ele.isNode() && def.position) {
          const p = ele.position()
          if (Math.hypot(p.x - def.position.x, p.y - def.position.y) > 0.5) {
            ele.animate({ position: { ...def.position } }, { duration: FADE })
          }
        }
      })

      const fresh = elements.filter((d) => cy.$id(d.data!.id as string).empty())
      cy.add(fresh).forEach((ele) => {
        const target = targetOpacity(ele)
        ele.style('opacity', 0)
        ele.animate(
          { style: { opacity: target } },
          { duration: FADE, complete: () => ele.removeStyle('opacity') },
        )
      })
      applySel(cy, st.primary, st.secondary)

      const walkedTo = st.primary?.kind === 'node' ? st.primary.id : null
      if (walkedTo) {
        window.setTimeout(() => {
          const inst = cyRef.current
          if (!inst) return
          const target = inst.$id(walkedTo)
          if (target.nonempty()) {
            inst.animate(
              { center: { eles: target } },
              { duration: 300, easing: 'ease-in-out-quad' },
            )
          }
        }, FADE + 20)
      }
    }

    if (fitAfterBuild.flag) {
      fitAfterBuild.flag = false
      cy.fit(undefined, 60) // a random restart can land anywhere in the plane
    }

    if (firstBuild.current && elements.length) {
      firstBuild.current = false
      cy.fit(undefined, 60)
      const anySeeded = [...visN].some((id) => seed[id])
      if (!anySeeded) void runLayout() // brand-new graph: give it a first arrangement
    }
  }, [version, viewId])

  // Selection classes follow the slots without an element rebuild.
  useEffect(() => {
    if (cyRef.current) applySel(cyRef.current, primary, secondary)
  }, [primary, secondary])

  return <div ref={divRef} className="canvas" />
}

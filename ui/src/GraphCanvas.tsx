// The cytoscape canvas. The store's payload is the source of truth; this
// component projects the visible subgraph into cy elements, interprets
// skewers (rail segment + end handles; members placed evenly along it),
// writes drag/layout results back into the view, and exposes imperative
// helpers (runLayout, skewerFromSelection) that need live positions.

import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import { useEffect, useRef } from 'react'
import {
  compactEdges,
  defaultGeom,
  peripheryDim,
  placeAlong,
  resolveCollisions,
  scoreArrangement,
  skewerShown,
  skewersOf,
  visibleSets,
  type DimLevel,
  type SkewerRig,
} from './graph'
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

/** The opacity an element's stylesheet resolves to (for animation targets). */
const targetOpacity = (ele: cytoscape.SingularElementReturnValue): number =>
  ele.hasClass('rail')
    ? 0.75
    : ele.hasClass('fringe-outer')
      ? FRINGE_OUTER_OPACITY
      : ele.hasClass('fringe-near')
        ? FRINGE_NEAR_OPACITY
        : 1

export const cyRef: { current: cytoscape.Core | null } = { current: null }

interface Rig {
  visMembers: string[]
  geom: SkewerGeom
}

interface KgeScratch {
  memberOf: Map<string, string>
  rigs: Record<string, Rig>
}

const scratch = (cy: cytoscape.Core): KgeScratch =>
  (cy.scratch('kge') as KgeScratch) ?? { memberOf: new Map(), rigs: {} }

const handleId = (skewer: string, end: 'a' | 'b') => `skh:${end}:${skewer}`
const railId = (skewer: string) => `rail:${skewer}`

/** Reflect the two-slot selection as element classes (skewers select via their rail). */
function applySel(cy: cytoscape.Core, primary: Sel | null, secondary: Sel | null): void {
  cy.elements('.sel-primary').removeClass('sel-primary')
  cy.elements('.sel-secondary').removeClass('sel-secondary')
  const elOf = (s: Sel) => cy.$id(s.kind === 'skewer' ? railId(s.id) : s.id)
  if (secondary) elOf(secondary).addClass('sel-secondary')
  if (primary) elOf(primary).addClass('sel-primary')
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
  const sel = cy.nodes(':selected')
  if (sel.length < 2) {
    st.setStatus('select at least 2 nodes to skewer')
    return
  }
  const pts = sel.map((n) => ({ id: n.id(), p: { ...n.position() } }))
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

/** Rigid-body layout with random restarts: collapse each skewer into one long
 * thin meta-node, run fcose on the quotient graph from THREE random starts,
 * de-collide each result, score them (residual collisions, then crossings),
 * and commit the best. Click again for a new roll of the dice. */
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

  const seed = v.layout.seedPositions
  const pinnedNodes = new Set(v.layout.pinned)
  const els: cytoscape.ElementDefinition[] = []
  const fixed: { nodeId: string; position: Position }[] = []

  for (const s of skewers) {
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
  for (const id of visN) {
    if (memberOf.has(id)) continue
    const pos = seed[id] ?? { x: 0, y: 0 }
    els.push({ group: 'nodes', data: { id, w: 40, h: 40 }, position: { ...pos } })
    if (pinnedNodes.has(id)) fixed.push({ nodeId: id, position: { ...pos } })
  }
  const seen = new Set<string>()
  for (const e of g.edges) {
    if (!visE.has(`${e.type}|${e.from}|${e.to}`)) continue
    const src = memberOf.get(e.from) ?? e.from
    const dst = memberOf.get(e.to) ?? e.to
    if (src === dst) continue
    const key = src < dst ? `${src}~${dst}` : `${dst}~${src}`
    if (seen.has(key)) continue
    seen.add(key)
    els.push({ group: 'edges', data: { id: `q:${key}`, source: src, target: dst } })
  }
  if (els.filter((e) => e.group === 'nodes').length < 2) {
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

    // Expand the quotient: translate each skewer by its meta-node's movement.
    const rigs: Record<string, SkewerRig> = {}
    for (const s of skewers) {
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
        visMembers: s.members.filter((m) => visN.has(m) && memberOf.get(m) === s.id),
      }
    }

    // De-collide the real geometry, greedily shorten over-long edges while
    // the score tolerates it, then score the settled result.
    const resolved = resolveCollisions(positions, pinnedNodes, rigs, visEdgeList)
    const resolvedRigs: Record<string, SkewerRig> = Object.fromEntries(
      Object.entries(rigs).map(([sid, r]) => [
        sid,
        { geom: resolved.geoms[sid], visMembers: r.visMembers },
      ]),
    )
    const compacted = compactEdges(resolved.free, pinnedNodes, resolvedRigs, visEdgeList)
    const compactedRigs: Record<string, SkewerRig> = Object.fromEntries(
      Object.entries(resolvedRigs).map(([sid, r]) => [
        sid,
        { geom: compacted.geoms[sid], visMembers: r.visMembers },
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
            'background-color': '#5f6368',
            label: '',
          },
        },
        {
          selector: 'node.skewer-bulb', // the a end: the bulb carries the name
          style: {
            width: 18,
            height: 18,
            shape: 'ellipse',
            'background-color': '#5f6368',
            label: 'data(label)',
            'font-size': 9,
            color: '#5f6368',
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
          selector: 'edge.rail',
          style: {
            width: RAIL_WIDTH,
            'curve-style': 'straight',
            'line-fill': 'linear-gradient',
            'line-gradient-stop-colors': '#e8eaed #5f6368', // light a → dark b: direction
            'target-arrow-shape': 'triangle', // arrowhead at b reinforces it
            'target-arrow-color': '#5f6368',
            'arrow-scale': 1.4,
            opacity: 0.75,
          } as never,
        },
        {
          selector: 'edge.rail.rail-pinned',
          style: {
            width: RAIL_WIDTH + 2,
            'line-gradient-stop-colors': '#f3c1c1 #b91c1c',
            'target-arrow-color': '#b91c1c',
          } as never,
        },
        { selector: 'edge.rail:selected', style: { width: RAIL_WIDTH + 3, opacity: 1 } },
        { selector: '.fringe-near', style: { opacity: FRINGE_NEAR_OPACITY } },
        { selector: '.fringe-outer', style: { opacity: FRINGE_OUTER_OPACITY } },
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
      if (n.hasClass('skewer-handle')) return
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

    // -- rigid skewer dragging ------------------------------------------------
    let dragCtx: {
      kind: 'member' | 'handle'
      skewer: string
      grabbedId: string
      start: Position
      starts: Map<string, Position>
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
      const starts = new Map<string, Position>()
      for (const m of sc.rigs[skewer].visMembers) starts.set(m, { ...cy.$id(m).position() })
      for (const end of ['a', 'b'] as const)
        starts.set(handleId(skewer, end), { ...cy.$id(handleId(skewer, end)).position() })
      dragCtx = {
        kind: asHandle ? 'handle' : 'member',
        skewer,
        grabbedId: n.id(),
        start: { ...n.position() },
        starts,
      }
    })

    cy.on('drag', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      if (!dragCtx || n.id() !== dragCtx.grabbedId) return
      const sc = scratch(cy)
      const rig = sc.rigs[dragCtx.skewer]
      if (!rig) return
      if (dragCtx.kind === 'member') {
        // Translate the whole rig by the member's displacement.
        const dx = n.position().x - dragCtx.start.x
        const dy = n.position().y - dragCtx.start.y
        for (const [id, p] of dragCtx.starts) {
          if (id === n.id()) continue
          cy.$id(id).position({ x: p.x + dx, y: p.y + dy })
        }
      } else {
        // Rotate/stretch: the segment follows the handles; members re-place.
        const geom: SkewerGeom = {
          a: { ...cy.$id(handleId(dragCtx.skewer, 'a')).position() },
          b: { ...cy.$id(handleId(dragCtx.skewer, 'b')).position() },
          pinned: rig.geom.pinned,
        }
        rig.geom = geom
        const placed = placeAlong(geom, rig.visMembers)
        for (const [id, p] of Object.entries(placed)) cy.$id(id).position(p)
      }
    })

    cy.on('dragfree', 'node', (evt) => {
      const n = evt.target as cytoscape.NodeSingular
      const st = useStore.getState()
      if (dragCtx && n.id() === dragCtx.grabbedId) {
        const { skewer } = dragCtx
        dragCtx = null
        const geom: SkewerGeom = {
          a: { ...cy.$id(handleId(skewer, 'a')).position() },
          b: { ...cy.$id(handleId(skewer, 'b')).position() },
          pinned: scratch(cy).rigs[skewer]?.geom.pinned ?? false,
        }
        const rig = scratch(cy).rigs[skewer]
        if (rig) rig.geom = geom
        st.setSkewerGeom(skewer, geom)
        return
      }
      const positions: Record<string, Position> = {}
      positions[n.id()] = { ...n.position() }
      cy.$('node:selected').forEach((sel) => {
        if (!sel.hasClass('skewer-handle')) positions[sel.id()] = { ...sel.position() }
      })
      st.setPositions(positions)
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
    const memberOf = new Map<string, string>()
    const rigs: Record<string, Rig> = {}
    const derived: Record<string, Position> = {}
    const conflicts: string[] = []
    for (const s of skewersOf(g)) {
      if (!skewerShown(v, s.id)) continue
      const visMembers = s.members.filter((m) => visN.has(m))
      if (!visMembers.length) continue
      for (const m of visMembers) {
        if (memberOf.has(m)) conflicts.push(m)
        else memberOf.set(m, s.id)
      }
      const mine = visMembers.filter((m) => memberOf.get(m) === s.id)
      if (!mine.length) continue
      const geom = v.layout.skewers[s.id] ?? defaultGeom(s.members, seed)
      v.layout.skewers[s.id] = geom // derived defaults persist on next save
      rigs[s.id] = { visMembers: mine, geom }
      Object.assign(derived, placeAlong(geom, mine))
    }
    if (conflicts.length) {
      st.setStatus(
        `warning: on multiple skewers (first wins): ${[...new Set(conflicts)].join(', ')}`,
      )
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
        n.id === v.focus?.node ? 'focus-center' : '',
      ]
        .filter(Boolean)
        .join(' ')
      elements.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: n.label || n.id,
          color: g.schema.nodeTypes[n.type]?.color || '#888',
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
      const label = g.nodes.find((n) => n.id === id)?.label || id
      for (const end of ['a', 'b'] as const) {
        elements.push({
          group: 'nodes',
          data: { id: handleId(id, end), skewer: id, end, ...(end === 'a' ? { label } : {}) },
          position: { ...rig.geom[end] },
          // The a end is the labeled bulb at the base; b is the grip under the arrowhead.
          classes: end === 'a' ? 'skewer-handle skewer-bulb' : 'skewer-handle',
          selectable: false,
        })
      }
      elements.push({
        group: 'edges',
        data: {
          id: railId(id),
          source: handleId(id, 'a'),
          target: handleId(id, 'b'),
          skewer: id,
        },
        classes: rig.geom.pinned ? 'rail rail-pinned' : 'rail',
      })
    }

    cy.scratch('kge', { memberOf, rigs } satisfies KgeScratch)
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

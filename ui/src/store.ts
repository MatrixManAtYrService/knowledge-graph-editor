// The browser's edit buffer: the whole graph payload, mutated locally,
// pushed on Save, clobbered on Refresh. `version` bumps when the canvas
// must rebuild its elements; position-only changes deliberately don't.
//
// Selection is two-slot, Excel-style: every click becomes primary and the
// old primary trails into secondary — so "the pair" is always the last two
// distinct clicks, with no modes. It's published to the server on every
// change so agents can ask what the human is looking at (kge selection).
// Native cytoscape multi-select (shift-click / box) still feeds bulk ops
// (Skewer, Pin, Delete) via `multiNodes`.

import { create } from 'zustand'
import { createGraph, deleteGraph, fetchGraph, fetchGraphs, postSelection, putGraph } from './api'
import { hydrateDetails, STATIC_MODE } from './static'
import {
  alignGeom,
  computeBundleFracs,
  fociOf,
  focusReach,
  groupOpts,
  LANE_GAP,
  padScale,
  SKEWER_EDGE,
  SKEWER_TYPE,
  skewerShown,
  skewersOf,
  snapLanes,
  visibleSets,
} from './graph'
import type { Focus, GraphInfo, GraphPayload, Position, Sel, SkewerGeom, View } from './types'
import { edgeKey } from './types'

export interface KgeState {
  graph: GraphPayload | null
  graphs: GraphInfo[] // what the server offers (the graph picker's entries)
  graphId: string // which one `graph` is
  viewId: string
  dirty: boolean
  version: number
  primary: Sel | null
  secondary: Sel | null
  multiNodes: string[]
  connectEdgeType: string
  status: string
  // What a node click does besides selecting: 'refocus' replaces the foci
  // with the clicked node's neighborhood, 'toggle' adds the clicked node as
  // a focus (or removes it if it already is one), 'view' just selects.
  clickMode: 'refocus' | 'toggle' | 'view'
  focusHops: number // the radius the NEXT refocus / add-focus click uses
  animateNext: boolean // the next canvas rebuild should fade/glide (set by focus changes)
  stashedFocus: { foci: Focus[]; show: string[]; hide: string[] } | null // for Restore focus

  refresh: () => Promise<void>
  save: () => Promise<void>
  /** Static site only: pull the detail shard behind a selected item so the
   * inspector can show its full data (graph.json carries only lite fields). */
  hydrateSel: (sel: Sel) => Promise<void>
  view: () => View | null
  bump: () => void
  setStatus: (s: string) => void
  tapSelect: (sel: Sel | null) => void
  setMultiNodes: (ids: string[]) => void
  setConnectEdgeType: (t: string) => void
  setGraphId: (id: string) => void
  addGraph: (id: string) => Promise<void>
  removeGraph: (id: string) => Promise<void>
  setViewId: (id: string) => void
  addView: (id: string, name: string) => void
  removeView: (id: string) => void

  addNode: (type: string, id: string, label: string, pos: Position) => void
  connect: () => void
  deleteSelection: () => void
  deleteItems: (nodeIds: string[], edgeKeys: string[]) => void
  setNodeProps: (id: string, props: { type?: string; label?: string; data?: Record<string, unknown> }) => void
  setEdgeData: (key: string, data: Record<string, unknown>) => void

  setTypesChecked: (kind: 'node' | 'edge', names: string[], checked: boolean) => void
  toggleOverride: (kind: 'node' | 'edge', id: string) => void
  setSkewersEnabled: (ids: string[], enabled: boolean) => void
  setBundleAlign: (group: string, on: boolean) => void
  setBundleGrouped: (group: string, on: boolean) => void
  applyBundleSpacing: (group: string, mode: 'even' | 'order' | 'proportional') => void
  equalizeBundle: (group: string) => void
  rotateBundle: (group: string) => void
  padBundle: (group: string) => void
  setMemberFrac: (skewerId: string, nodeId: string, frac: number) => void
  setClickMode: (mode: KgeState['clickMode']) => void
  setFocusHops: (k: number) => void
  clearFocus: () => void
  restoreFocus: () => void
  removeFocus: (node: string) => void
  adjustShown: (ids: string[], show: boolean) => void
  addToSkewer: (skewerId: string, nodeId: string) => void
  removeFromSkewer: (skewerId: string, nodeId: string) => void
  setPositions: (positions: Record<string, Position>, opts?: { markDirty?: boolean }) => void
  createSkewer: (id: string, members: string[], geom: SkewerGeom) => void
  setSkewerGeom: (id: string, geom: SkewerGeom, opts?: { rebuild?: boolean }) => void
  setSkewerPinned: (id: string, pinned: boolean) => void
  setPinned: (ids: string[], pinned: boolean) => void
}

const viewOf = (g: GraphPayload, id: string): View =>
  g.views.find((v) => v.id === id) ?? g.views[0]

export const useStore = create<KgeState>((set, get) => {
  /** Mutate the payload in place, then publish. rebuild=false skips the canvas rebuild. */
  const mut = (fn: (g: GraphPayload, v: View) => void, opts?: { rebuild?: boolean }) => {
    const { graph, viewId } = get()
    if (!graph) return
    fn(graph, viewOf(graph, viewId))
    set((s) => ({
      graph: { ...graph },
      dirty: true,
      version: opts?.rebuild === false ? s.version : s.version + 1,
    }))
  }

  const setSelection = (primary: Sel | null, secondary: Sel | null) => {
    set({ primary, secondary })
    postSelection(primary, secondary, get().graphId, get().viewId)
  }

  const ensureSkewerTypes = (g: GraphPayload) => {
    g.schema.nodeTypes[SKEWER_TYPE] ??= {
      color: '#9aa0a6',
      description: 'An ordered colinearity group (layout intent, interpreted by the view)',
    }
    g.schema.edgeTypes[SKEWER_EDGE] ??= {
      color: '#c9cdd2',
      description: 'Skewer membership; data.index gives the order along the skewer',
    }
  }

  return {
    graph: null,
    graphs: [],
    graphId: '',
    viewId: 'default',
    dirty: false,
    version: 0,
    primary: null,
    secondary: null,
    multiNodes: [],
    connectEdgeType: '',
    status: '',
    clickMode: 'view',
    focusHops: 2,
    animateNext: false,
    stashedFocus: null,

    refresh: async () => {
      try {
        const graphs = await fetchGraphs()
        // Keep the current graph if the server still offers it; else fall to
        // the server's default. (First load: graphId is '' and falls too.)
        const cur = get().graphId
        const graphId = graphs.some((x) => x.id === cur)
          ? cur
          : (graphs.find((x) => x.default) ?? graphs[0])?.id
        if (!graphId) throw new Error('the server offers no graphs')
        const g = await fetchGraph(graphId)
        set((s) => ({
          graph: g,
          graphs,
          graphId,
          dirty: false,
          version: s.version + 1,
          viewId: g.views.some((v) => v.id === s.viewId) ? s.viewId : (g.views[0]?.id ?? 'default'),
          multiNodes: [],
          connectEdgeType: s.connectEdgeType || Object.keys(g.schema.edgeTypes)[0] || '',
          status: `refreshed ${graphId}: ${g.nodes.length} nodes, ${g.edges.length} edges`,
        }))
        setSelection(null, null) // after set: publishes the (possibly changed) graph + view ids
      } catch (e) {
        set({ status: String(e) })
      }
    },

    save: async () => {
      const { graph: g, graphId } = get()
      if (!g || !graphId) return
      try {
        await putGraph(graphId, g)
        set({ dirty: false, status: `saved ${graphId}` })
      } catch (e) {
        set({ status: String(e) })
      }
    },

    hydrateSel: async (sel) => {
      if (!STATIC_MODE) return
      if (await hydrateDetails(sel)) {
        // Data-only change: re-render (inspector, tooltips) without a canvas rebuild.
        set((s) => (s.graph ? { graph: { ...s.graph } } : {}))
      }
    },

    view: () => {
      const { graph, viewId } = get()
      return graph ? viewOf(graph, viewId) : null
    },

    bump: () => set((s) => ({ version: s.version + 1 })),
    setStatus: (status) => set({ status }),

    tapSelect: (sel) => {
      const { primary, secondary, clickMode, focusHops } = get()
      if (!sel) {
        if (primary || secondary) setSelection(null, null)
        return
      }
      if (!(primary && primary.kind === sel.kind && primary.id === sel.id)) {
        setSelection(sel, primary)
      }
      if (sel.kind !== 'node') return
      if (clickMode === 'refocus') {
        // selection-walk: the clicked node becomes the ONLY focus, and the
        // adjustments recompute from scratch — eye tweaks don't survive.
        set({ animateNext: true })
        mut((_g, v) => {
          v.foci = [{ node: sel.id, kHops: focusHops }]
          v.focusShow = []
          v.focusHide = []
        })
      } else if (clickMode === 'toggle') {
        // One mode, both directions: a focus center clicked again is
        // removed; any other node joins as a new center, its neighborhood
        // unioning in. Unlike refocus this clobbers nothing — eye
        // adjustments stay (removal sweeps only the removed focus's reach).
        const v = get().view()
        if (v && fociOf(v).some((f) => f.node === sel.id)) {
          get().removeFocus(sel.id)
        } else {
          set({ animateNext: true })
          mut((_g, view) => {
            view.foci = [...fociOf(view), { node: sel.id, kHops: focusHops }]
          })
          set({ status: `focus added: ${sel.id} (${focusHops} hops)` })
        }
      }
    },

    setMultiNodes: (multiNodes) => set({ multiNodes }),
    setConnectEdgeType: (connectEdgeType) => set({ connectEdgeType }),

    /** Switch graphs: drop the edit buffer and load the picked graph fresh
     * (the caller confirms first when there are unsaved edits). The view
     * picker re-buckets to the new graph's views inside refresh(). */
    setGraphId: (graphId) => {
      set({ graphId, viewId: 'default', stashedFocus: null })
      void get().refresh()
    },

    addGraph: async (id) => {
      if (!id.trim()) return set({ status: 'graph id must not be empty' })
      try {
        await createGraph(id.trim())
        get().setGraphId(id.trim())
        set({ status: `created graph ${id.trim()}` })
      } catch (e) {
        set({ status: String(e) })
      }
    },

    removeGraph: async (id) => {
      try {
        await deleteGraph(id)
      } catch (e) {
        return set({ status: String(e) })
      }
      if (id === get().graphId) {
        // The current graph went away: refresh falls to the server default.
        await get().refresh()
      } else {
        // Just re-list; don't clobber the edit buffer over a bystander.
        try {
          set({ graphs: await fetchGraphs() })
        } catch {
          /* the next refresh will re-list */
        }
      }
      set({ status: `deleted graph ${id}` })
    },

    setViewId: (viewId) => {
      set((s) => ({ viewId, version: s.version + 1, multiNodes: [] }))
      setSelection(null, null) // after set: publishes the new view id
    },

    addView: (id, name) => {
      const { graph, viewId } = get()
      if (!graph) return
      if (!id.trim()) return set({ status: 'view id must not be empty' })
      if (graph.views.some((v) => v.id === id)) return set({ status: `view already exists: ${id}` })
      const clone = structuredClone(viewOf(graph, viewId))
      clone.id = id
      clone.name = name || id
      mut((g) => {
        g.views.push(clone)
      })
      get().setViewId(id)
      set({ status: `created view ${id} (a copy of ${viewId}) — in this tab only until you Save` })
    },

    removeView: (id) => {
      const { graph } = get()
      if (!graph) return
      if (graph.views.length <= 1) return set({ status: 'the last view cannot be deleted' })
      mut((g) => {
        g.views = g.views.filter((v) => v.id !== id)
      })
      if (get().viewId === id) get().setViewId(get().graph!.views[0].id)
      set({ status: `deleted view ${id}` })
    },

    addNode: (type, id, label, pos) => {
      const g = get().graph
      if (!g) return
      if (!id.trim()) return set({ status: 'node id must not be empty' })
      if (g.nodes.some((n) => n.id === id)) return set({ status: `node already exists: ${id}` })
      mut((graph, v) => {
        graph.nodes.push({ id, type, label, data: {} })
        v.layout.seedPositions[id] = pos
      })
      setSelection({ kind: 'node', id }, null)
    },

    /** Create an edge from the secondary node to the primary node (click
     * source, click target, Connect). The new edge becomes the primary
     * selection so its metadata can be filled in immediately. */
    connect: () => {
      const { graph, primary, secondary, connectEdgeType } = get()
      if (!graph) return
      if (primary?.kind !== 'node' || secondary?.kind !== 'node') {
        return set({ status: 'connect: click a source node, then a target node, then Connect' })
      }
      const from = secondary.id
      const to = primary.id
      const key = edgeKey({ type: connectEdgeType, from, to })
      if (graph.edges.some((e) => edgeKey(e) === key)) return set({ status: 'edge already exists' })
      mut((g) => {
        g.edges.push({ type: connectEdgeType, from, to, data: {} })
      })
      setSelection({ kind: 'edge', id: key }, null)
      set({ status: `added ${from} -[${connectEdgeType}]-> ${to}` })
    },

    deleteSelection: () => {
      const { primary, secondary, multiNodes } = get()
      const nodeIds: string[] = [...multiNodes]
      const edgeKeys: string[] = []
      for (const s of [primary, secondary]) {
        if (!s) continue
        if (s.kind === 'edge') edgeKeys.push(s.id)
        else nodeIds.push(s.id) // skewers are nodes too
      }
      get().deleteItems(nodeIds, edgeKeys)
    },

    deleteItems: (nodeIdList, edgeKeyList) => {
      const nodeIds = new Set(nodeIdList)
      const edgeKeys = new Set(edgeKeyList)
      if (!nodeIds.size && !edgeKeys.size) return
      mut((graph, v) => {
        if (nodeIds.size) {
          graph.nodes = graph.nodes.filter((n) => !nodeIds.has(n.id))
          graph.edges = graph.edges.filter((e) => !nodeIds.has(e.from) && !nodeIds.has(e.to))
          for (const id of nodeIds) {
            delete v.layout.seedPositions[id]
            delete v.layout.skewers[id]
          }
          v.layout.pinned = v.layout.pinned.filter((n) => !nodeIds.has(n))
          v.foci = fociOf(v).filter((f) => !nodeIds.has(f.node))
        }
        if (edgeKeys.size) {
          graph.edges = graph.edges.filter((e) => !edgeKeys.has(edgeKey(e)))
        }
        const gone = (id: string) => nodeIds.has(id) || edgeKeys.has(id)
        v.focusShow = (v.focusShow ?? []).filter((i) => !gone(i))
        v.focusHide = (v.focusHide ?? []).filter((i) => !gone(i))
      })
      // Only the deleted items leave the selection; the rest stays put.
      const { primary, secondary, multiNodes } = get()
      const gone = (s: Sel | null) => (s ? nodeIds.has(s.id) || edgeKeys.has(s.id) : false)
      if (gone(primary) || gone(secondary)) {
        setSelection(gone(primary) ? null : primary, gone(secondary) ? null : secondary)
      }
      if (multiNodes.some((id) => nodeIds.has(id))) {
        set({ multiNodes: multiNodes.filter((id) => !nodeIds.has(id)) })
      }
    },

    setNodeProps: (id, props) => {
      mut((graph) => {
        const n = graph.nodes.find((n) => n.id === id)
        if (!n) return
        if (props.type !== undefined) n.type = props.type
        if (props.label !== undefined) n.label = props.label
        if (props.data !== undefined) n.data = props.data
      })
    },

    setEdgeData: (key, data) => {
      mut((graph) => {
        const e = graph.edges.find((e) => edgeKey(e) === key)
        if (e) e.data = data
      })
    },

    setTypesChecked: (kind, names, checked) => {
      mut((graph, v) => {
        const all = Object.keys(
          kind === 'node' ? graph.schema.nodeTypes : graph.schema.edgeTypes,
        )
        const field = kind === 'node' ? 'visibleNodeTypes' : 'visibleEdgeTypes'
        const cur = new Set(v[field] ?? all)
        for (const n of names) (checked ? cur.add(n) : cur.delete(n))
        v[field] = cur.size === all.length ? null : [...cur]
        // Parent action clobbers children: drop the overrides beneath it.
        const named = new Set(names)
        if (kind === 'node') {
          const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]))
          v.nodeOverrides = (v.nodeOverrides ?? []).filter(
            (id) => !named.has(typeOf.get(id) ?? ''),
          )
        } else {
          v.edgeOverrides = (v.edgeOverrides ?? []).filter(
            (key) => !named.has(key.split('|')[0]),
          )
        }
      })
    },

    toggleOverride: (kind, id) => {
      mut((_g, v) => {
        const field = kind === 'node' ? 'nodeOverrides' : 'edgeOverrides'
        const cur = v[field] ?? []
        v[field] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      })
    },

    /** Enable/disable skewers (their rails) without touching their members:
     * flips each skewer's own inclusion checkbox to the requested state. */
    setSkewersEnabled: (ids, enabled) => {
      mut((_g, v) => {
        const overrides = new Set(v.nodeOverrides ?? [])
        for (const id of ids) {
          if (skewerShown(v, id) === enabled) continue
          if (overrides.has(id)) overrides.delete(id)
          else overrides.add(id)
        }
        v.nodeOverrides = [...overrides]
      })
    },

    setBundleAlign: (group, on) => {
      mut((g, v) => {
        const cur = v.skewerGroups?.[group] ?? { align: false, axis: null }
        // align and grouped are mutually exclusive drag policies: checking
        // one unchecks the other (align's conform already carries the
        // bundle, so stacking grouped on top double-moves rails).
        v.skewerGroups = {
          ...(v.skewerGroups ?? {}),
          [group]: { ...cur, align: on, grouped: on ? false : cur.grouped },
        }
        // Turning align on conforms the bundle now: every enabled rail takes
        // the reference's segment (a pinned rail if there is one, else the
        // highest-priority one), keeping only its own sideways offset.
        if (!on) return
        const rails = skewersOf(g).filter((s) => s.group === group && skewerShown(v, s.id))
        const geoms = rails
          .map((s) => ({ id: s.id, geom: v.layout.skewers[s.id] }))
          .filter((x): x is { id: string; geom: SkewerGeom } => Boolean(x.geom))
        const ref = geoms.find((x) => x.geom.pinned) ?? geoms[0]
        if (!ref) return
        for (const { id, geom } of geoms) {
          if (id === ref.id || geom.pinned) continue
          v.layout.skewers[id] = alignGeom(ref.geom, geom)
        }
      })
    },

    /** Grouped is pure drag behavior (rail drags translate the bundle
     * rigidly) — toggling it moves nothing now, so no conforming pass.
     * Mutually exclusive with align (see setBundleAlign). */
    setBundleGrouped: (group, on) => {
      mut((_g, v) => {
        const cur = v.skewerGroups?.[group] ?? { align: false, axis: null }
        v.skewerGroups = {
          ...(v.skewerGroups ?? {}),
          [group]: { ...cur, grouped: on, align: on ? false : cur.align },
        }
      })
    },

    /** Bake member spacing for a bundle: 'order' = merged-rank even spacing,
     * 'proportional' = value-true fractions (records the axis range),
     * 'even' = clear the baked fractions. One-shot — drag things afterwards. */
    applyBundleSpacing: (group, mode) => {
      let note = ''
      mut((g, v) => {
        const rails = skewersOf(g).filter((s) => s.group === group)
        const fracs = (v.layout.memberFracs ??= {})
        const cur = v.skewerGroups?.[group] ?? { align: false, axis: null }
        if (mode === 'even') {
          for (const s of rails) delete fracs[s.id]
          v.skewerGroups = { ...(v.skewerGroups ?? {}), [group]: { ...cur, axis: null } }
          note = `${group}: members spaced evenly per skewer`
          return
        }
        const res = computeBundleFracs(g, group, mode)
        if (!Object.keys(res.byRail).length) {
          note =
            mode === 'proportional'
              ? `${group}: no members have values that parse as numbers or dates`
              : `${group}: no members carry the ordering key`
          return
        }
        for (const s of rails) {
          if (res.byRail[s.id]) fracs[s.id] = res.byRail[s.id]
          else delete fracs[s.id]
        }
        v.skewerGroups = {
          ...(v.skewerGroups ?? {}),
          [group]: { ...cur, axis: mode === 'proportional' ? res.axis : null },
        }
        note =
          `${group}: applied ${mode === 'order' ? 'shared order' : 'proportional order'}` +
          (res.skipped.length ? ` (skipped, missing values: ${res.skipped.join(', ')})` : '')
      })
      if (note) set({ status: note })
    },

    /** One member's hand-placed rail fraction (dragging a node slides it
     * along its owning rail). Baked like the spacing actions' output. */
    setMemberFrac: (skewerId, nodeId, frac) => {
      mut(
        (_g, v) => {
          const fracs = (v.layout.memberFracs ??= {})
          fracs[skewerId] = { ...(fracs[skewerId] ?? {}), [nodeId]: frac }
        },
        { rebuild: false },
      )
    },

    /** Snap the bundle's enabled rails onto an equidistant perpendicular
     * grid, keeping their order (a pinned rail anchors the grid). */
    equalizeBundle: (group) => {
      mut((g, v) => {
        const entries = skewersOf(g)
          .filter((s) => s.group === group && skewerShown(v, s.id))
          .map((s) => ({ id: s.id, geom: v.layout.skewers[s.id] }))
          .filter((x): x is { id: string; geom: SkewerGeom } => Boolean(x.geom))
        Object.assign(v.layout.skewers, snapLanes(entries, LANE_GAP))
      })
      set({ status: `${group}: rails snapped to equidistant lanes` })
    },

    /** Stretch the bundle's rails (about their midpoints) until neighboring
     * dots and labels clear each other at the current member fractions.
     * Under align every rail takes the bundle's worst-case factor so the
     * ends stay colinear. Capped at 8× — near-coincident members can't be
     * fixed by stretching (slide them, or re-space). */
    padBundle: (group) => {
      let note = ''
      mut((g, v) => {
        const { nodes: visN } = visibleSets(g, v)
        const byId = new Map(g.nodes.map((n) => [n.id, n]))
        const memberOf = new Map<string, string>()
        for (const s of skewersOf(g)) {
          for (const m of s.members) if (!memberOf.has(m)) memberOf.set(m, s.id)
        }
        const entries: { id: string; geom: SkewerGeom; scale: number }[] = []
        for (const s of skewersOf(g)) {
          if (s.group !== group || !skewerShown(v, s.id)) continue
          const geom = v.layout.skewers[s.id]
          if (!geom) continue
          const mine = s.members.filter((m) => visN.has(m) && memberOf.get(m) === s.id)
          const fr = v.layout.memberFracs?.[s.id]
          const ts = mine.map((m, i) => fr?.[m] ?? (i + 0.5) / mine.length)
          const labels = mine.map((m) => byId.get(m)?.label || m)
          entries.push({ id: s.id, geom, scale: padScale(geom, labels, ts) })
        }
        if (!entries.length) return
        const aligned = groupOpts(v, group).align
        const shared = Math.max(...entries.map((e) => e.scale))
        let applied = 1
        for (const e of entries) {
          const k = Math.min(aligned ? shared : e.scale, 8)
          if (k <= 1.001) continue
          applied = Math.max(applied, k)
          const mid = { x: (e.geom.a.x + e.geom.b.x) / 2, y: (e.geom.a.y + e.geom.b.y) / 2 }
          v.layout.skewers[e.id] = {
            a: { x: mid.x + (e.geom.a.x - mid.x) * k, y: mid.y + (e.geom.a.y - mid.y) * k },
            b: { x: mid.x + (e.geom.b.x - mid.x) * k, y: mid.y + (e.geom.b.y - mid.y) * k },
            pinned: e.geom.pinned,
          }
        }
        note =
          applied > 1
            ? `${group}: rails stretched ${applied.toFixed(1)}× for label clearance`
            : `${group}: labels already clear`
      })
      if (note) set({ status: note })
    },

    /** Turn the whole bundle a quarter turn about its center — an explicit
     * action, so pinned rails turn too. */
    rotateBundle: (group) => {
      mut((g, v) => {
        const geoms = skewersOf(g)
          .filter((s) => s.group === group && skewerShown(v, s.id))
          .map((s) => ({ id: s.id, geom: v.layout.skewers[s.id] }))
          .filter((x): x is { id: string; geom: SkewerGeom } => Boolean(x.geom))
        if (!geoms.length) return
        const mids = geoms.map(({ geom }) => ({
          x: (geom.a.x + geom.b.x) / 2,
          y: (geom.a.y + geom.b.y) / 2,
        }))
        const cx = mids.reduce((s, m) => s + m.x, 0) / mids.length
        const cy = mids.reduce((s, m) => s + m.y, 0) / mids.length
        const turn = (p: Position): Position => ({ x: cx - (p.y - cy), y: cy + (p.x - cx) })
        for (const { id, geom } of geoms) {
          v.layout.skewers[id] = { a: turn(geom.a), b: turn(geom.b), pinned: geom.pinned }
        }
      })
      set({ status: `${group}: rotated 90°` })
    },

    addToSkewer: (skewerId, nodeId) => {
      const g = get().graph
      if (!g) return
      const already = g.edges.some(
        (e) => e.type === SKEWER_EDGE && e.from === skewerId && e.to === nodeId,
      )
      if (already) return set({ status: `${nodeId} is already on ${skewerId}` })
      const prev = g.edges
        .filter((e) => e.type === SKEWER_EDGE && e.to === nodeId)
        .map((e) => e.from)
      mut((graph) => {
        // One skewer per node: joining this rail leaves any other.
        graph.edges = graph.edges.filter((e) => !(e.type === SKEWER_EDGE && e.to === nodeId))
        const indexes = graph.edges
          .filter((e) => e.type === SKEWER_EDGE && e.from === skewerId)
          .map((e, i) => (typeof e.data.index === 'number' ? (e.data.index as number) : i))
        const next = indexes.length ? Math.max(...indexes) + 1 : 0
        graph.edges.push({ type: SKEWER_EDGE, from: skewerId, to: nodeId, data: { index: next } })
      })
      set({
        status: prev.length
          ? `moved ${nodeId} from ${prev.join(', ')} to ${skewerId}`
          : `added ${nodeId} to ${skewerId}`,
      })
    },

    removeFromSkewer: (skewerId, nodeId) => {
      mut((graph) => {
        graph.edges = graph.edges.filter(
          (e) => !(e.type === SKEWER_EDGE && e.from === skewerId && e.to === nodeId),
        )
      })
      set({ status: `removed ${nodeId} from ${skewerId}` })
    },

    // Mode is just a click policy — switching it never touches the foci.
    setClickMode: (mode) => set({ clickMode: mode }),

    // The slider sets the radius for the NEXT refocus / add-focus click;
    // existing foci keep theirs (re-click a center in add mode to re-read it).
    setFocusHops: (k) => set({ focusHops: Math.max(1, Math.min(10, k)) }),

    /** Drop one focus center. Its explicit eye-summons go with it — anything
     * the user summoned within the removed focus's reach — while summons in
     * other foci's territory survive. */
    removeFocus: (node) => {
      const { graph } = get()
      const v = get().view()
      if (!graph || !v) return
      const target = fociOf(v).find((f) => f.node === node)
      if (!target) {
        return set({ status: 'click a focus center (red crosshairs) to remove it' })
      }
      const reach = focusReach(graph, v, target.node, target.kHops)
      set({ animateNext: true })
      mut((_g, view) => {
        view.foci = fociOf(view).filter((f) => f.node !== node)
        view.focusShow = (view.focusShow ?? []).filter(
          (id) => !reach.nodes.has(id) && !reach.edges.has(id),
        )
      })
      set({ status: `focus removed: ${node}` })
    },

    clearFocus: () => {
      const v = get().view()
      if (!v || !fociOf(v).length) return
      set({
        stashedFocus: {
          foci: fociOf(v).map((f) => ({ ...f })),
          show: [...(v.focusShow ?? [])],
          hide: [...(v.focusHide ?? [])],
        },
        animateNext: true,
      })
      mut((_g, view) => {
        view.foci = []
        view.focusShow = []
        view.focusHide = []
      })
    },

    restoreFocus: () => {
      const stash = get().stashedFocus
      if (!stash) return
      set({ animateNext: true, stashedFocus: null })
      mut((_g, v) => {
        v.foci = stash.foci.map((f) => ({ ...f }))
        v.focusShow = [...stash.show]
        v.focusHide = [...stash.hide]
      })
    },

    adjustShown: (ids, show) => {
      if (!ids.length) return
      set({ animateNext: true }) // eye toggles fade like walk steps
      mut((_g, v) => {
        const showSet = new Set(v.focusShow ?? [])
        const hideSet = new Set(v.focusHide ?? [])
        for (const id of ids) {
          if (show) {
            hideSet.delete(id)
            showSet.add(id)
          } else {
            showSet.delete(id)
            hideSet.add(id)
          }
        }
        v.focusShow = [...showSet]
        v.focusHide = [...hideSet]
      })
    },

    setPositions: (positions, opts) => {
      const markDirty = opts?.markDirty ?? true
      const { graph, viewId } = get()
      if (!graph) return
      const v = viewOf(graph, viewId)
      Object.assign(v.layout.seedPositions, positions)
      if (markDirty) set({ graph: { ...graph }, dirty: true })
    },

    createSkewer: (id, members, geom) => {
      const g = get().graph
      if (!g) return
      if (!id.trim()) return set({ status: 'skewer id must not be empty' })
      if (g.nodes.some((n) => n.id === id)) return set({ status: `node already exists: ${id}` })
      if (members.length < 2) return set({ status: 'a skewer needs at least 2 members' })
      mut((graph, v) => {
        ensureSkewerTypes(graph)
        // One skewer per node: the new rail takes its members off any other.
        const memberSet = new Set(members)
        graph.edges = graph.edges.filter((e) => !(e.type === SKEWER_EDGE && memberSet.has(e.to)))
        graph.nodes.push({ id, type: SKEWER_TYPE, label: '', data: {} })
        members.forEach((m, i) => {
          graph.edges.push({ type: SKEWER_EDGE, from: id, to: m, data: { index: i } })
        })
        v.layout.skewers[id] = geom
      })
      set({ status: `skewered ${members.length} nodes onto ${id}` })
    },

    setSkewerGeom: (id, geom, opts) => {
      mut(
        (_g, v) => {
          v.layout.skewers[id] = geom
        },
        { rebuild: opts?.rebuild ?? false },
      )
    },

    setSkewerPinned: (id, pinned) => {
      mut((_g, v) => {
        const geom = v.layout.skewers[id]
        if (geom) geom.pinned = pinned
      })
    },

    setPinned: (ids, pinned) => {
      mut(
        (_g, v) => {
          const cur = new Set(v.layout.pinned)
          for (const id of ids) (pinned ? cur.add(id) : cur.delete(id))
          v.layout.pinned = [...cur].sort()
        },
        { rebuild: false },
      )
    },
  }
})

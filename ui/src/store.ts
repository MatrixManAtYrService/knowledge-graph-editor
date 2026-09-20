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
import { fetchGraph, postSelection, putGraph } from './api'
import {
  alignGeom,
  computeBundleFracs,
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
import type { Focus, GraphPayload, Position, Sel, SkewerGeom, View } from './types'
import { edgeKey } from './types'

export interface KgeState {
  graph: GraphPayload | null
  viewId: string
  dirty: boolean
  version: number
  primary: Sel | null
  secondary: Sel | null
  multiNodes: string[]
  connectEdgeType: string
  status: string
  walkMode: boolean // refocus click behavior: focus follows every node click
  focusHops: number // focus-hops used when (re)centering the focus
  animateNext: boolean // the next canvas rebuild should fade/glide (set by focus changes)
  stashedFocus: { focus: Focus; show: string[]; hide: string[] } | null // for Restore focus

  refresh: () => Promise<void>
  save: () => Promise<void>
  view: () => View | null
  bump: () => void
  setStatus: (s: string) => void
  tapSelect: (sel: Sel | null) => void
  setMultiNodes: (ids: string[]) => void
  setConnectEdgeType: (t: string) => void
  setViewId: (id: string) => void
  addView: (id: string, name: string) => void
  removeView: (id: string) => void

  addNode: (type: string, id: string, label: string, pos: Position) => void
  connect: () => void
  deleteSelection: () => void
  setNodeProps: (id: string, props: { type?: string; label?: string; data?: Record<string, unknown> }) => void
  setEdgeData: (key: string, data: Record<string, unknown>) => void

  setTypesChecked: (kind: 'node' | 'edge', names: string[], checked: boolean) => void
  toggleOverride: (kind: 'node' | 'edge', id: string) => void
  setSkewersEnabled: (ids: string[], enabled: boolean) => void
  setBundleAlign: (group: string, on: boolean) => void
  applyBundleSpacing: (group: string, mode: 'even' | 'order' | 'proportional') => void
  equalizeBundle: (group: string) => void
  rotateBundle: (group: string) => void
  padBundle: (group: string) => void
  setMemberFrac: (skewerId: string, nodeId: string, frac: number) => void
  setWalkMode: (on: boolean) => void
  setFocusHops: (k: number) => void
  clearFocus: () => void
  restoreFocus: () => void
  adjustShown: (ids: string[], show: boolean) => void
  addToSkewer: (skewerId: string, nodeId: string) => void
  removeFromSkewer: (skewerId: string, nodeId: string) => void
  setFocus: (node: string | null, kHops: number) => void
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
    postSelection(primary, secondary, get().viewId)
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
    viewId: 'default',
    dirty: false,
    version: 0,
    primary: null,
    secondary: null,
    multiNodes: [],
    connectEdgeType: '',
    status: '',
    walkMode: false,
    focusHops: 2,
    animateNext: false,
    stashedFocus: null,

    refresh: async () => {
      try {
        const g = await fetchGraph()
        set((s) => ({
          graph: g,
          dirty: false,
          version: s.version + 1,
          viewId: g.views.some((v) => v.id === s.viewId) ? s.viewId : (g.views[0]?.id ?? 'default'),
          multiNodes: [],
          connectEdgeType: s.connectEdgeType || Object.keys(g.schema.edgeTypes)[0] || '',
          status: `refreshed: ${g.nodes.length} nodes, ${g.edges.length} edges`,
        }))
        setSelection(null, null) // after set: publishes the (possibly changed) view id
      } catch (e) {
        set({ status: String(e) })
      }
    },

    save: async () => {
      const g = get().graph
      if (!g) return
      try {
        await putGraph(g)
        set({ dirty: false, status: 'saved' })
      } catch (e) {
        set({ status: String(e) })
      }
    },

    view: () => {
      const { graph, viewId } = get()
      return graph ? viewOf(graph, viewId) : null
    },

    bump: () => set((s) => ({ version: s.version + 1 })),
    setStatus: (status) => set({ status }),

    tapSelect: (sel) => {
      const { primary, secondary, walkMode, focusHops } = get()
      if (!sel) {
        if (primary || secondary) setSelection(null, null)
        return
      }
      if (!(primary && primary.kind === sel.kind && primary.id === sel.id)) {
        setSelection(sel, primary)
      }
      // selection-walk: the focus follows each node click, summoning its
      // neighborhood and banishing everything else.
      if (walkMode && sel.kind === 'node') get().setFocus(sel.id, focusHops)
    },

    setMultiNodes: (multiNodes) => set({ multiNodes }),
    setConnectEdgeType: (connectEdgeType) => set({ connectEdgeType }),

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
      set({ status: `created view ${id} (a copy of ${viewId})` })
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
      const nodeIds = new Set(multiNodes)
      const edgeKeys = new Set<string>()
      for (const s of [primary, secondary]) {
        if (!s) continue
        if (s.kind === 'edge') edgeKeys.add(s.id)
        else nodeIds.add(s.id) // skewers are nodes too
      }
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
          if (v.focus && nodeIds.has(v.focus.node)) v.focus = null
        }
        if (edgeKeys.size) {
          graph.edges = graph.edges.filter((e) => !edgeKeys.has(edgeKey(e)))
        }
        const gone = (id: string) => nodeIds.has(id) || edgeKeys.has(id)
        v.focusShow = (v.focusShow ?? []).filter((i) => !gone(i))
        v.focusHide = (v.focusHide ?? []).filter((i) => !gone(i))
      })
      setSelection(null, null)
      set({ multiNodes: [] })
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
        v.skewerGroups = { ...(v.skewerGroups ?? {}), [group]: { ...cur, align: on } }
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
      mut((graph) => {
        const indexes = graph.edges
          .filter((e) => e.type === SKEWER_EDGE && e.from === skewerId)
          .map((e, i) => (typeof e.data.index === 'number' ? (e.data.index as number) : i))
        const next = indexes.length ? Math.max(...indexes) + 1 : 0
        graph.edges.push({ type: SKEWER_EDGE, from: skewerId, to: nodeId, data: { index: next } })
      })
      set({ status: `added ${nodeId} to ${skewerId}` })
    },

    removeFromSkewer: (skewerId, nodeId) => {
      mut((graph) => {
        graph.edges = graph.edges.filter(
          (e) => !(e.type === SKEWER_EDGE && e.from === skewerId && e.to === nodeId),
        )
      })
      set({ status: `removed ${nodeId} from ${skewerId}` })
    },

    // Mode is just a click policy — switching it never touches the focus.
    setWalkMode: (on) => set({ walkMode: on }),

    setFocusHops: (k) => {
      const clamped = Math.max(1, Math.min(10, k))
      set({ focusHops: clamped })
      const focus = get().view()?.focus
      if (focus) get().setFocus(focus.node, clamped)
    },

    setFocus: (node, kHops) => {
      set({ animateNext: true }) // focus changes fade/glide instead of snapping
      mut((_g, v) => {
        v.focus = node ? { node, kHops } : null
        // A recenter recomputes from scratch: eye adjustments don't survive.
        v.focusShow = []
        v.focusHide = []
      })
    },

    clearFocus: () => {
      const v = get().view()
      if (!v?.focus) return
      set({
        stashedFocus: {
          focus: { ...v.focus },
          show: [...(v.focusShow ?? [])],
          hide: [...(v.focusHide ?? [])],
        },
      })
      get().setFocus(null, 0)
    },

    restoreFocus: () => {
      const stash = get().stashedFocus
      if (!stash) return
      set({ animateNext: true, stashedFocus: null })
      mut((_g, v) => {
        v.focus = { ...stash.focus }
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

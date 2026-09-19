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
import { SKEWER_EDGE, SKEWER_TYPE } from './graph'
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

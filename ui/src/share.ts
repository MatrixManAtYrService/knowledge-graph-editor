// Share-by-URL, in every mode: the location hash always mirrors where the
// visitor is — graph, view, selection, and any deviation
// from the saved view (foci, inclusion, eye adjustments) — so copying the
// address bar shares exactly what they see. Nodes and edges are referenced
// by their export integers (see static.ts), which are only stable until the
// graph is edited: links may dangle across data pushes, by design. In the
// editor the hash is rewritten after every reload, so the address bar is
// always good for the version on screen.
//
// Layout changes (drags, spacing actions, random layout) are deliberately
// not encoded — positions are far too heavy for a URL. A shared link plays
// the *saved* layout with the sender's visibility state on top.
//
// This module also runs the data resolver: after any change to what the
// view could show, ensureViewLoaded pulls the missing sliver, and applying a
// hash first point-loads whatever integers it names. And it notices when
// the graph changed on the server (window focus → version check).
//
// Vocabulary (all parts optional except g/v; lists are comma-joined):
//   g=<graphId>  v=<viewId>
//   p=n3 | e7    s=...          primary / secondary selection
//   f=3.2,9.1 | f=-             foci as <nodeInt>.<kHops>; '-' = cleared
//   nt=0,2 | nt=*               visible node types by schema index; * = all
//   et=...                      visible edge types
//   no=4,11  eo=2               per-item include overrides
//   sh=n3,e7  hd=...            eye adjustments (summon / banish)

import { fetchVersion, postOps } from './api'
import { applyOps, diffOps, type Op, opRefs, rebase } from './ops'
import {
  activate,
  drainLoaded,
  ensureIds,
  ensureInts,
  ensureViewLoaded,
  loadGraph,
  staticGraph,
  WINDOWED_LOAD_CAP,
} from './static'
import { useStore } from './store'
import type { EdgeT, Focus, GraphPayload, NodeT, Sel, View } from './types'
import { edgeKey } from './types'

const sameList = (a: string[] | null | undefined, b: string[] | null | undefined): boolean => {
  if (a == null || b == null) return (a == null) === (b == null)
  if (a.length !== b.length) return false
  const bs = new Set(b)
  return a.every((x) => bs.has(x))
}

const sameFoci = (a: Focus[], b: Focus[]): boolean =>
  a.length === b.length && a.every((f) => b.some((x) => x.node === f.node && x.kHops === f.kHops))

function encodeSel(sel: Sel | null): string | null {
  const sg = staticGraph()
  if (!sel || !sg) return null
  if (sel.kind === 'edge') {
    const i = sg.intOfEdge(sel.id)
    return i === undefined ? null : `e${i}`
  }
  const i = sg.intOfNode(sel.id)
  return i === undefined ? null : `n${i}`
}

function decodeSel(tok: string): Sel | null {
  const sg = staticGraph()
  if (!sg || tok.length < 2) return null
  const i = Number(tok.slice(1))
  if (!Number.isInteger(i) || i < 0) return null
  if (tok[0] === 'e') {
    const id = sg.edgeKeyOf(i)
    return id ? { kind: 'edge', id } : null
  }
  if (tok[0] === 'n') {
    const id = sg.nodeIdOf(i)
    if (!id) return null
    return { kind: sg.nodeTypeOf(i) === 'skewer' ? 'skewer' : 'node', id }
  }
  return null
}

const typeNames = (kind: 'node' | 'edge'): string[] => {
  const g = useStore.getState().graph
  if (!g) return []
  return Object.keys(kind === 'node' ? g.schema.nodeTypes : g.schema.edgeTypes)
}

const encodeTypes = (kind: 'node' | 'edge', list: string[] | null): string => {
  if (list === null) return '*'
  const names = typeNames(kind)
  return list
    .map((t) => names.indexOf(t))
    .filter((i) => i >= 0)
    .join(',')
}

const decodeTypes = (kind: 'node' | 'edge', raw: string): string[] | null => {
  if (raw === '*') return null
  if (raw === '') return []
  const names = typeNames(kind)
  return raw
    .split(',')
    .map((t) => names[Number(t)])
    .filter((n): n is string => Boolean(n))
}

const encodeIntList = (ids: string[], intOf: (id: string) => number | undefined): string =>
  ids
    .map(intOf)
    .filter((i): i is number => i !== undefined)
    .join(',')

const decodeIntList = (raw: string, idOf: (i: number) => string | undefined): string[] =>
  raw === ''
    ? []
    : raw
        .split(',')
        .map((t) => idOf(Number(t)))
        .filter((id): id is string => Boolean(id))

/** Mixed node-or-edge id lists (focusShow/focusHide) as prefixed tokens. */
const encodeMixed = (ids: string[]): string => {
  const sg = staticGraph()!
  return ids
    .map((id) => {
      const n = sg.intOfNode(id)
      if (n !== undefined) return `n${n}`
      const e = sg.intOfEdge(id)
      return e !== undefined ? `e${e}` : null
    })
    .filter((t): t is string => t !== null)
    .join(',')
}

const decodeMixed = (raw: string): string[] => {
  const sg = staticGraph()!
  return raw === ''
    ? []
    : raw
        .split(',')
        .map((tok) => {
          const i = Number(tok.slice(1))
          if (!Number.isInteger(i)) return null
          return tok[0] === 'n' ? sg.nodeIdOf(i) : tok[0] === 'e' ? sg.edgeKeyOf(i) : null
        })
        .filter((id): id is string => Boolean(id))
}

// -- hash <- state -------------------------------------------------------------

function currentHash(): string {
  const st = useStore.getState()
  const sg = staticGraph()
  const g = st.graph
  if (!sg || !g) return ''
  const view = g.views.find((x) => x.id === st.viewId) ?? g.views[0]
  if (!view) return ''
  const pv = sg.pristine.views.find((x) => x.id === view.id)
  const parts = [`g=${encodeURIComponent(sg.graphId)}`, `v=${encodeURIComponent(view.id)}`]
  const p = encodeSel(st.primary)
  if (p) parts.push(`p=${p}`)
  const s = encodeSel(st.secondary)
  if (s) parts.push(`s=${s}`)
  if (pv) {
    const foci = view.foci ?? []
    if (!sameFoci(foci, pv.foci ?? [])) {
      const toks = foci
        .map((f) => {
          const i = sg.intOfNode(f.node)
          return i === undefined ? null : `${i}.${f.kHops}`
        })
        .filter((t): t is string => t !== null)
      parts.push(`f=${toks.length ? toks.join(',') : '-'}`)
    }
    if (!sameList(view.visibleNodeTypes, pv.visibleNodeTypes))
      parts.push(`nt=${encodeTypes('node', view.visibleNodeTypes)}`)
    if (!sameList(view.visibleEdgeTypes, pv.visibleEdgeTypes))
      parts.push(`et=${encodeTypes('edge', view.visibleEdgeTypes)}`)
    if (!sameList(view.nodeOverrides ?? [], pv.nodeOverrides ?? []))
      parts.push(`no=${encodeIntList(view.nodeOverrides ?? [], sg.intOfNode)}`)
    if (!sameList(view.edgeOverrides ?? [], pv.edgeOverrides ?? []))
      parts.push(`eo=${encodeIntList(view.edgeOverrides ?? [], sg.intOfEdge)}`)
    if (!sameList(view.focusShow ?? [], pv.focusShow ?? []))
      parts.push(`sh=${encodeMixed(view.focusShow ?? [])}`)
    if (!sameList(view.focusHide ?? [], pv.focusHide ?? []))
      parts.push(`hd=${encodeMixed(view.focusHide ?? [])}`)
  }
  return '#' + parts.join('&')
}

let applying = false
let timer: ReturnType<typeof setTimeout> | undefined

function writeHashNow(): void {
  const h = currentHash()
  if (h && h !== window.location.hash) history.replaceState(null, '', h)
}

function scheduleWrite(): void {
  clearTimeout(timer)
  timer = setTimeout(writeHashNow, 250)
}

// -- state <- hash -------------------------------------------------------------

/** Every export integer a hash names (so windowed mode can point-load them
 * before decoding). */
function paramInts(params: URLSearchParams): { nodes: number[]; edges: number[] } {
  const nodes: number[] = []
  const edges: number[] = []
  const push = (tok: string) => {
    const i = Number(tok.slice(1))
    if (!Number.isInteger(i) || i < 0) return
    if (tok[0] === 'n') nodes.push(i)
    else if (tok[0] === 'e') edges.push(i)
  }
  for (const k of ['p', 's']) {
    const v = params.get(k)
    if (v) push(v)
  }
  for (const k of ['sh', 'hd']) {
    const v = params.get(k)
    if (v) v.split(',').forEach(push)
  }
  const f = params.get('f')
  if (f && f !== '-') {
    for (const tok of f.split(',')) {
      const i = Number(tok.split('.')[0])
      if (Number.isInteger(i) && i >= 0) nodes.push(i)
    }
  }
  const no = params.get('no')
  if (no) for (const t of no.split(',')) if (Number.isInteger(Number(t))) nodes.push(Number(t))
  const eo = params.get('eo')
  if (eo) for (const t of eo.split(',')) if (Number.isInteger(Number(t))) edges.push(Number(t))
  return { nodes, edges }
}

const byNode = (a: NodeT, b: NodeT) =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const byEdge = (a: EdgeT, b: EdgeT) => {
  const x = edgeKey(a)
  const y = edgeKey(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Republish the store's graph, merging in rows the data layer loaded since
 * last time. The store's graph is the editable copy: loads only add, never
 * replace, and an edge whose endpoint was deleted locally stays out. */
function publishGraph(): void {
  const fresh = drainLoaded()
  useStore.setState((s) => {
    if (!s.graph) return {}
    let { nodes, edges } = s.graph
    if (fresh.nodes.length) {
      const have = new Set(nodes.map((n) => n.id))
      nodes = [...nodes, ...fresh.nodes.filter((n) => !have.has(n.id))].sort(byNode)
    }
    if (fresh.edges.length) {
      const ids = new Set(nodes.map((n) => n.id))
      const have = new Set(edges.map(edgeKey))
      const add = fresh.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && !have.has(edgeKey(e)))
      edges = [...edges, ...add].sort(byEdge)
    }
    return { graph: { ...s.graph, nodes, edges }, version: s.version + 1 }
  })
}

/** Overlay the hash's params on the current view: encoded fields reset to
 * the pristine (saved) state first, so a hash with no `f` means "the view's
 * own foci", not "whatever was there before". */
function applyViewParams(params: URLSearchParams): void {
  const st = useStore.getState()
  const sg = staticGraph()
  const graph = st.graph
  if (!sg || !graph) return
  const view: View | undefined = graph.views.find((x) => x.id === st.viewId) ?? graph.views[0]
  if (!view) return
  const pv = sg.pristine.views.find((x) => x.id === view.id)
  if (pv) {
    view.foci = structuredClone(pv.foci ?? [])
    view.visibleNodeTypes = pv.visibleNodeTypes ? [...pv.visibleNodeTypes] : null
    view.visibleEdgeTypes = pv.visibleEdgeTypes ? [...pv.visibleEdgeTypes] : null
    view.nodeOverrides = [...(pv.nodeOverrides ?? [])]
    view.edgeOverrides = [...(pv.edgeOverrides ?? [])]
    view.focusShow = [...(pv.focusShow ?? [])]
    view.focusHide = [...(pv.focusHide ?? [])]
  }
  const f = params.get('f')
  if (f !== null) {
    view.foci =
      f === '-' || f === ''
        ? []
        : f
            .split(',')
            .map((tok): Focus | null => {
              const [i, k] = tok.split('.')
              const node = sg.nodeIdOf(Number(i))
              return node ? { node, kHops: Math.max(1, Number(k) || 1) } : null
            })
            .filter((x): x is Focus => x !== null)
  }
  const nt = params.get('nt')
  if (nt !== null) view.visibleNodeTypes = decodeTypes('node', nt)
  const et = params.get('et')
  if (et !== null) view.visibleEdgeTypes = decodeTypes('edge', et)
  const no = params.get('no')
  if (no !== null) view.nodeOverrides = decodeIntList(no, sg.nodeIdOf)
  const eo = params.get('eo')
  if (eo !== null) view.edgeOverrides = decodeIntList(eo, sg.edgeKeyOf)
  const sh = params.get('sh')
  if (sh !== null) view.focusShow = decodeMixed(sh)
  const hd = params.get('hd')
  if (hd !== null) view.focusHide = decodeMixed(hd)
  publishGraph()

  const p = params.get('p')
  const sec = params.get('s')
  useStore.setState({
    primary: p ? decodeSel(p) : null,
    secondary: sec ? decodeSel(sec) : null,
  })
}

async function applyFromLocation(): Promise<void> {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const st = useStore.getState()
  applying = true
  try {
    const g = params.get('g')
    const v = params.get('v')
    if (g && g !== st.graphId) {
      useStore.setState({ graphId: g, viewId: v ?? 'default' })
      await useStore.getState().refresh()
    } else if (v && v !== st.viewId) {
      st.setViewId(v)
    }
    const want = paramInts(params)
    await ensureInts(want.nodes, want.edges)
    applyViewParams(params)
  } finally {
    applying = false
  }
  await resolveViewData()
  writeHashNow() // normalize: dangling ints and unknown params drop out
}

// -- windowed-mode data resolver ----------------------------------------------

let lastFinger = ''
let resolving = false
let rerun = false

/** Keep the windowed invariant (loaded ⊇ shown) after anything that changes
 * what the view could show. Cheap when nothing relevant changed: a
 * fingerprint of the visibility-determining fields gates the real work. */
async function resolveViewData(): Promise<void> {
  if (resolving) {
    rerun = true
    return
  }
  resolving = true
  try {
    let go = true
    while (go) {
      rerun = false
      const sg = staticGraph()
      const st = useStore.getState()
      const g = st.graph
      if (!sg || !g) return
      const view = g.views.find((x) => x.id === st.viewId) ?? g.views[0]
      if (!view) return
      const finger = JSON.stringify([
        sg.generation, // a reload starts from nothing loaded
        st.graphId,
        view.id,
        view.foci,
        view.visibleNodeTypes,
        view.visibleEdgeTypes,
        view.nodeOverrides,
        view.edgeOverrides,
        view.focusShow,
        view.focusHide,
      ])
      if (finger !== lastFinger) {
        lastFinger = finger
        try {
          const res = await ensureViewLoaded(view)
          if (res.added) publishGraph()
          const t = sg.totals
          const n = sg.loaded()
          if (t && res.capped) {
            st.setStatus(
              `this view asks for more than ${WINDOWED_LOAD_CAP} nodes — showing the first ` +
                `${n.nodes} of ${t.nodes}; focus a node or uncheck types to browse a sliver`,
            )
          } else if (t && res.added && n.nodes < t.nodes) {
            st.setStatus(
              `windowed: ${n.nodes} of ${t.nodes} nodes loaded (${n.edges} of ${t.edges} edges)`,
            )
          }
        } catch (e) {
          lastFinger = '' // failed loads retry on the next change
          st.setStatus(`loading graph data failed: ${e}`)
        }
      }
      go = rerun
    }
  } finally {
    resolving = false
  }
}

// -- saving and reloading -----------------------------------------------------
//
// There is no Save button: every edit is applied locally at once (the store
// mutates) and sent as ops shortly after (debounced, so a drag is one save,
// not hundreds). A save rebases first — the sent ops become the saved state,
// so edits made while it's in flight diff cleanly into the next one — and
// then reloads, because integers renumber with every version.
//
// A reload never blanks the canvas: the new version loads in the
// background (what the view shows, plus whatever unsaved edits touch), the
// unsaved edits replay on top, and only then does it swap in. The same
// reload picks up outside changes (agents, syncs, git pull) when the version
// poll notices them.

const SAVE_DEBOUNCE_MS = 700
const VERSION_POLL_MS = 5000

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> | null = null
let reloading: Promise<void> | null = null

function scheduleSave(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS)
}

/** Send unsaved edits now (and wait for the reload after). */
async function saveNow(): Promise<void> {
  clearTimeout(saveTimer)
  while (saving) await saving
  const st = useStore.getState()
  const sg = staticGraph()
  if (!st.dirty || !st.caps.write || !st.graph || !sg) return
  const ops = diffOps(st.graph)
  if (!ops.length) {
    useStore.setState({ dirty: false })
    return
  }
  saving = (async () => {
    const graphId = st.graphId
    const undo = rebase(st.graph!)
    useStore.setState({ dirty: false, saving: true })
    try {
      const res = await postOps(graphId, ops, sg.version)
      await reloadInPlace()
      const n = `${ops.length} change${ops.length === 1 ? '' : 's'}`
      useStore
        .getState()
        .setStatus(`saved ${n}` + (res.moved ? ' (merged with changes made elsewhere)' : ''))
    } catch (e) {
      if (e instanceof TypeError) {
        // Never reached the server: keep the edits unsaved and retry later.
        undo()
        useStore.setState({ dirty: true })
        useStore.getState().setStatus(`couldn't reach the server to save (${e.message}); will retry`)
        saveTimer = setTimeout(() => void saveNow(), 5 * SAVE_DEBOUNCE_MS)
      } else {
        // Rejected: drop those edits (the reload shows the server's state).
        useStore.getState().setStatus(`${e} — those edits were undone`)
        await reloadInPlace().catch(() => {})
      }
    } finally {
      useStore.setState({ saving: false })
    }
  })()
  try {
    await saving
  } finally {
    saving = null
  }
  if (useStore.getState().dirty) scheduleSave()
}

/** Swap in the graph's current version without blanking the canvas,
 * replaying unsaved local edits on top. */
async function reloadInPlace(): Promise<void> {
  if (reloading) return reloading
  reloading = (async () => {
    const { graphId } = useStore.getState()
    const next = await loadGraph(graphId)
    // Load what the view shows (as edited locally) plus what pending edits
    // and the selection touch; repeat if edits landed meanwhile.
    let pending: Op[] = []
    let graph = useStore.getState().graph
    for (let i = 0; i < 3; i++) {
      graph = useStore.getState().graph
      const st = useStore.getState()
      if (!graph) return
      pending = diffOps(graph)
      const refs = opRefs(pending)
      for (const sel of [st.primary, st.secondary]) {
        if (sel?.kind === 'edge') refs.edges.push(sel.id)
        else if (sel) refs.nodes.push(sel.id)
      }
      await ensureIds(refs.nodes, refs.edges, next)
      const view = graph.views.find((v) => v.id === st.viewId) ?? graph.views[0]
      if (view) await ensureViewLoaded(view, next)
      if (useStore.getState().graph === graph) break
    }
    const rows = drainLoaded(next)
    const fresh: GraphPayload = structuredClone({ ...next.payload, nodes: [], edges: [] })
    fresh.nodes = [...next.payload.nodes, ...rows.nodes].sort(byNode)
    fresh.edges = [...next.payload.edges, ...rows.edges].sort(byEdge)
    const dropped = applyOps(fresh, pending)
    fresh.nodes.sort(byNode)
    fresh.edges.sort(byEdge)
    activate(next)
    useStore.setState((s) => ({
      graph: fresh,
      version: s.version + 1,
      // Still unsaved = edited since the last save went out (an automatic
      // layout's positions replay, but don't by themselves trigger a save).
      dirty: s.dirty,
      primary: s.primary && present(fresh, s.primary) ? s.primary : null,
      secondary: s.secondary && present(fresh, s.secondary) ? s.secondary : null,
    }))
    if (dropped) {
      useStore
        .getState()
        .setStatus(`${dropped} unsaved edit${dropped === 1 ? '' : 's'} no longer fit the graph and were dropped`)
    }
  })()
  try {
    await reloading
  } finally {
    reloading = null
  }
}

const present = (g: GraphPayload, sel: Sel): boolean =>
  sel.kind === 'edge' ? g.edges.some((e) => edgeKey(e) === sel.id) : g.nodes.some((n) => n.id === sel.id)

/** The graph changed on the server (an agent's edit, a sync, git pull)?
 * Reload in place; unsaved edits replay on top. */
async function checkVersion(): Promise<void> {
  const st = useStore.getState()
  const sg = staticGraph()
  if (!sg?.version || !st.caps.write || !st.graphId || saving || reloading) return
  let now: string
  try {
    now = await fetchVersion(st.graphId)
  } catch {
    return // server away: the next check tries again
  }
  if (now === staticGraph()?.version || saving || reloading) return
  await reloadInPlace()
  useStore.getState().setStatus('the graph changed on the server — reloaded')
}

/** Boot the app: honor the incoming URL, then keep it current. */
export async function initShare(): Promise<void> {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const g = params.get('g')
  const v = params.get('v')
  // Seed graph/view before the first fetch — refresh() keeps them if they exist.
  if (g) useStore.setState({ graphId: g, viewId: v ?? 'default' })
  else if (v) useStore.setState({ viewId: v })
  await useStore.getState().refresh()
  applying = true
  try {
    const want = paramInts(params)
    await ensureInts(want.nodes, want.edges)
    applyViewParams(params)
  } finally {
    applying = false
  }
  useStore.setState({ save: saveNow, reload: () => saveNow().then(reloadInPlace) })
  useStore.subscribe((s, prev) => {
    // Any edit while there are unsaved ones restarts the save countdown.
    if (s.dirty && s.graph !== prev.graph) scheduleSave()
    if (applying) return
    scheduleWrite()
    void resolveViewData()
  })
  window.addEventListener('hashchange', () => {
    if (!applying) void applyFromLocation()
  })
  window.addEventListener('focus', () => void checkVersion())
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkVersion()
  }, VERSION_POLL_MS)
  // Leaving with edits still in the debounce window: send them now.
  window.addEventListener('pagehide', () => void saveNow())
  await resolveViewData()
  writeHashNow()
}

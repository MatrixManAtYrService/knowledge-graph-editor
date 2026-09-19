import { useState } from 'react'
import { positionsOf, runLayout, skewerFromSelection, viewportCenter } from './GraphCanvas'
import { SKEWER_EDGE, SKEWER_TYPE } from './graph'
import { useStore } from './store'

export function Toolbar() {
  const dirty = useStore((s) => s.dirty)
  const graph = useStore((s) => s.graph)
  const viewId = useStore((s) => s.viewId)
  const connectEdgeType = useStore((s) => s.connectEdgeType)
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const multiNodes = useStore((s) => s.multiNodes)
  const view = useStore((s) => s.view())
  const {
    refresh,
    save,
    connect,
    setConnectEdgeType,
    deleteSelection,
    addNode,
    setPositions,
    setPinned,
    setSkewerPinned,
    setStatus,
    setViewId,
    addView,
    removeView,
    addToSkewer,
    removeFromSkewer,
  } = useStore()

  const [adding, setAdding] = useState(false)
  const [newType, setNewType] = useState('')
  const [newId, setNewId] = useState('')
  const [newLabel, setNewLabel] = useState('')

  if (!graph || !view) return <div className="toolbar">loading…</div>
  const nodeTypes = Object.keys(graph.schema.nodeTypes).filter((t) => t !== SKEWER_TYPE)
  const edgeTypes = Object.keys(graph.schema.edgeTypes).filter((t) => t !== SKEWER_EDGE)
  const hasSelection = primary !== null || secondary !== null || multiNodes.length > 0
  const canConnect = primary?.kind === 'node' && secondary?.kind === 'node'

  // Node + skewer in the two slots (either order): Skewer adds / Unskewer removes.
  const slotNode =
    primary?.kind === 'node' ? primary.id : secondary?.kind === 'node' ? secondary.id : null
  const slotSkewer =
    primary?.kind === 'skewer' ? primary.id : secondary?.kind === 'skewer' ? secondary.id : null
  const nodeSkewerPair = slotNode !== null && slotSkewer !== null
  const isMember =
    nodeSkewerPair &&
    graph.edges.some((e) => e.type === SKEWER_EDGE && e.from === slotSkewer && e.to === slotNode)

  // Pin/Unpin is one toggle: it shows the action that applies to the target.
  const pinTarget:
    | { kind: 'nodes'; ids: string[] }
    | { kind: 'skewer'; id: string }
    | null = multiNodes.length
    ? { kind: 'nodes', ids: multiNodes }
    : primary?.kind === 'node'
      ? { kind: 'nodes', ids: [primary.id] }
      : primary?.kind === 'skewer'
        ? { kind: 'skewer', id: primary.id }
        : null
  const isPinned =
    pinTarget === null
      ? false
      : pinTarget.kind === 'skewer'
        ? (view.layout.skewers[pinTarget.id]?.pinned ?? false)
        : pinTarget.ids.every((id) => view.layout.pinned.includes(id))

  const onRefresh = () => {
    if (dirty && !window.confirm('Discard local edits and refresh from the server?')) return
    void refresh()
  }

  const onAddNode = () => {
    const type = newType || nodeTypes[0]
    if (!type) {
      setStatus('add a node type to the schema first (kge add-type node <name>)')
      return
    }
    addNode(type, newId.trim(), newLabel.trim(), viewportCenter())
    setAdding(false)
    setNewId('')
    setNewLabel('')
  }

  const onSkewer = () => {
    if (nodeSkewerPair) {
      if (isMember) removeFromSkewer(slotSkewer!, slotNode!)
      else addToSkewer(slotSkewer!, slotNode!)
      return
    }
    skewerFromSelection()
  }

  const onPinToggle = () => {
    if (!pinTarget) return
    if (pinTarget.kind === 'skewer') {
      setSkewerPinned(pinTarget.id, !isPinned)
      setStatus(`${isPinned ? 'unpinned' : 'pinned'} ${pinTarget.id}`)
      return
    }
    if (!isPinned) setPositions(positionsOf(pinTarget.ids))
    setPinned(pinTarget.ids, !isPinned)
    setStatus(`${isPinned ? 'unpinned' : 'pinned'} ${pinTarget.ids.length} node(s)`)
  }

  const onNewView = () => {
    const id = window.prompt('new view id (a copy of the current view)')
    if (id) addView(id.trim(), id.trim())
  }

  const onDeleteView = () => {
    if (graph.views.length <= 1) return
    if (window.confirm(`Delete view "${view.name || viewId}"? The graph itself is untouched.`)) {
      removeView(viewId)
    }
  }

  return (
    <div className="toolbar">
      <span className="brand">kge</span>
      <select value={viewId} onChange={(e) => setViewId(e.target.value)} title="View">
        {graph.views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name || v.id}
          </option>
        ))}
      </select>
      <button onClick={onNewView} title="Create a new view as a copy of this one">
        New view
      </button>
      <button onClick={onDeleteView} disabled={graph.views.length <= 1} title="Delete this view (layout + filters only; the graph is untouched)">
        Delete view
      </button>
      <span className="sep" />
      <button className={dirty ? 'accent' : ''} onClick={() => void save()} disabled={!dirty}>
        Save{dirty ? ' *' : ''}
      </button>
      <button onClick={onRefresh}>Refresh</button>
      <span className="sep" />
      <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Add node'}</button>
      {adding && (
        <span className="add-form">
          <select value={newType || nodeTypes[0] || ''} onChange={(e) => setNewType(e.target.value)}>
            {nodeTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input placeholder="id" value={newId} onChange={(e) => setNewId(e.target.value)} />
          <input placeholder="label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button className="accent" onClick={onAddNode} disabled={!newId.trim()}>
            Add
          </button>
        </span>
      )}
      <select
        value={connectEdgeType}
        onChange={(e) => setConnectEdgeType(e.target.value)}
        title="Edge type used by Connect"
      >
        {edgeTypes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button
        onClick={connect}
        disabled={!canConnect}
        title="Create an edge from the secondary (dashed, first click) to the primary (solid, second click)"
      >
        Connect
      </button>
      <button onClick={deleteSelection} disabled={!hasSelection}>
        Delete
      </button>
      <span className="sep" />
      <button
        onClick={() => void runLayout()}
        title="Three random layout trials, de-collided and scored; the best wins. Click again to re-roll."
      >
        Random layout
      </button>
      <button
        onClick={onSkewer}
        disabled={!nodeSkewerPair && multiNodes.length < 2}
        title={
          nodeSkewerPair
            ? isMember
              ? 'Remove the selected node from the selected skewer'
              : 'Add the selected node to the selected skewer'
            : 'Put the shift/box-selected nodes on a skewer: an ordered line they stay on'
        }
      >
        {nodeSkewerPair && isMember ? 'Unskewer' : 'Skewer'}
      </button>
      <button onClick={onPinToggle} disabled={!pinTarget}>
        {isPinned ? 'Unpin' : 'Pin'}
      </button>
      {view.focus && <span className="focus-badge">focused: {view.focus.node}</span>}
    </div>
  )
}

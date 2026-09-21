// The toolbar carries only whole-state concerns: which graph and view
// you're on (with create/delete beside each picker), the Save/Refresh
// buffer transitions, and layout. Element creation and per-item actions
// (nodes, edges, skewers, pins) live in the sidebar's sections.

import { runLayout } from './GraphCanvas'
import { fociOf } from './graph'
import { useStore } from './store'

export function Toolbar() {
  const dirty = useStore((s) => s.dirty)
  const graph = useStore((s) => s.graph)
  const graphs = useStore((s) => s.graphs)
  const graphId = useStore((s) => s.graphId)
  const viewId = useStore((s) => s.viewId)
  const view = useStore((s) => s.view())
  const { refresh, save, setGraphId, addGraph, removeGraph, setViewId, addView, removeView } =
    useStore()

  if (!graph || !view) return <div className="toolbar">loading…</div>

  const onRefresh = () => {
    if (dirty && !window.confirm('Discard local edits and refresh from the server?')) return
    void refresh()
  }

  const onPickGraph = (id: string) => {
    if (id === graphId) return
    if (dirty && !window.confirm('Discard local edits and switch graphs?')) return
    setGraphId(id)
  }

  const onNewGraph = () => {
    const id = window.prompt('new graph id (seeds an empty graph on the server)')
    if (!id) return
    if (dirty && !window.confirm('Discard local edits and switch to the new graph?')) return
    void addGraph(id.trim())
  }

  const onDeleteGraph = () => {
    if (graphs.length <= 1) return
    if (
      window.confirm(
        `Delete graph "${graphId}" and its files from the server? Git history is the undo.`,
      )
    ) {
      void removeGraph(graphId)
    }
  }

  const onNewView = () => {
    const id = window.prompt('new view id (a copy of the current view; unsaved until you Save)')
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
      <div className="tb-section">
        <div className="tb-row">
          <span className="tb-label">graph</span>
          <select
            value={graphId}
            onChange={(e) => onPickGraph(e.target.value)}
            title="Graph (each has its own schema, nodes, edges, and views)"
          >
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id}
              </option>
            ))}
          </select>
          <button className="mini-icon" onClick={onNewGraph} title="Seed a new empty graph on the server">
            +
          </button>
          <button
            className="mini-icon"
            onClick={onDeleteGraph}
            disabled={graphs.length <= 1}
            title="Delete this graph — its files are removed from the server (git history is the undo)"
          >
            −
          </button>
        </div>
        <div className="tb-row">
          <span className="tb-label">view</span>
          <select
            value={viewId}
            onChange={(e) => setViewId(e.target.value)}
            title="View (a saved perspective on this graph)"
          >
            {graph.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name || v.id}
              </option>
            ))}
          </select>
          <button
            className="mini-icon"
            onClick={onNewView}
            title="Create a new view as a copy of this one — it lives in your edit buffer until you Save"
          >
            +
          </button>
          <button
            className="mini-icon"
            onClick={onDeleteView}
            disabled={graph.views.length <= 1}
            title="Delete this view (layout + filters only; the graph is untouched)"
          >
            −
          </button>
        </div>
      </div>
      <span className="sep" />
      <div className="tb-section">
        <button className={dirty ? 'accent' : ''} onClick={() => void save()} disabled={!dirty}>
          Save{dirty ? ' *' : ''}
        </button>
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <span className="sep" />
      <div className="tb-section">
        <button
          onClick={() => void runLayout()}
          title="Three random layout trials, de-collided and scored; the best wins. Click again to re-roll."
        >
          Random layout
        </button>
      </div>
      {fociOf(view).length > 0 && (
        <span className="focus-badge">
          {fociOf(view).length === 1
            ? `focused: ${fociOf(view)[0].node}`
            : `foci: ${fociOf(view).length}`}
        </span>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { skewersOf } from './graph'
import { STATIC_MODE } from './static'
import { useStore } from './store'
import type { Sel } from './types'
import { edgeKey } from './types'

function SkewerInspector({ skewerId }: { skewerId: string }) {
  const graph = useStore((s) => s.graph)!
  const skewer = skewersOf(graph).find((s) => s.id === skewerId)
  if (!skewer) return null

  return (
    <>
      <div className="field-id">{skewer.id}</div>
      <h3>members (in order)</h3>
      <ol className="member-list">
        {skewer.members.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ol>
      {!STATIC_MODE && (
        <div className="hint">
          Drag a member to move the skewer; drag an end handle to rotate or stretch it. Delete
          removes the skewer, not its members. Order lives in the graph (skewer-order edges) —
          edit it via the CLI: kge skewer {skewer.id} &lt;members in new order&gt;
        </div>
      )}
    </>
  )
}

/** Static site: show, don't edit. The full data payload arrives lazily —
 * hydrateSel pulls the item's detail shard, and the re-render fills this in. */
function StaticNodeInspector({ nodeId }: { nodeId: string }) {
  const graph = useStore((s) => s.graph)!
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return null
  return (
    <>
      <div className="field-id">{node.id}</div>
      <div className="ro-field">
        <span className="ro-key">type</span> {node.type}
      </div>
      {node.label && (
        <div className="ro-field">
          <span className="ro-key">label</span> {node.label}
        </div>
      )}
      {Object.keys(node.data).length > 0 && (
        <pre className="ro-data">{JSON.stringify(node.data, null, 2)}</pre>
      )}
    </>
  )
}

function StaticEdgeInspector({ eKey }: { eKey: string }) {
  const graph = useStore((s) => s.graph)!
  const edge = graph.edges.find((e) => edgeKey(e) === eKey)
  if (!edge) return null
  return (
    <>
      <div className="field-id">
        {edge.from}
        <br />
        -[{edge.type}]-&gt;
        <br />
        {edge.to}
      </div>
      {Object.keys(edge.data).length > 0 && (
        <pre className="ro-data">{JSON.stringify(edge.data, null, 2)}</pre>
      )}
    </>
  )
}

function NodeInspector({ nodeId }: { nodeId: string }) {
  const graph = useStore((s) => s.graph)!
  const { setNodeProps, setStatus } = useStore()
  const node = graph.nodes.find((n) => n.id === nodeId)
  const [label, setLabel] = useState(node?.label ?? '')
  const [dataText, setDataText] = useState(JSON.stringify(node?.data ?? {}, null, 2))
  if (!node) return null

  const applyData = () => {
    try {
      const parsed = JSON.parse(dataText)
      setNodeProps(nodeId, { data: parsed })
      setStatus('node data updated')
    } catch (e) {
      setStatus(`data is not valid JSON: ${e}`)
    }
  }

  return (
    <>
      <div className="field-id">{node.id}</div>
      <label>
        type
        <select value={node.type} onChange={(e) => setNodeProps(nodeId, { type: e.target.value })}>
          {Object.keys(graph.schema.nodeTypes).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => setNodeProps(nodeId, { label })}
        />
      </label>
      <label>
        data
        <textarea rows={8} value={dataText} onChange={(e) => setDataText(e.target.value)} />
      </label>
      <button onClick={applyData}>Apply data</button>
    </>
  )
}

function EdgeInspector({ eKey }: { eKey: string }) {
  const graph = useStore((s) => s.graph)!
  const { setEdgeData, setStatus } = useStore()
  const edge = graph.edges.find((e) => edgeKey(e) === eKey)
  const [dataText, setDataText] = useState(JSON.stringify(edge?.data ?? {}, null, 2))
  if (!edge) return null

  const applyData = () => {
    try {
      const parsed = JSON.parse(dataText)
      setEdgeData(eKey, parsed)
      setStatus('edge data updated')
    } catch (e) {
      setStatus(`data is not valid JSON: ${e}`)
    }
  }

  return (
    <>
      <div className="field-id">
        {edge.from}
        <br />
        -[{edge.type}]-&gt;
        <br />
        {edge.to}
      </div>
      <label>
        data
        <textarea rows={8} value={dataText} onChange={(e) => setDataText(e.target.value)} />
      </label>
      <button onClick={applyData}>Apply data</button>
    </>
  )
}

/** One selection slot — in the editor fully editable, on the static site a
 * read-only rendering of the same facts. */
function SlotSection({ slot, sel }: { slot: 'primary' | 'secondary'; sel: Sel }) {
  const hydrateSel = useStore((s) => s.hydrateSel)
  useEffect(() => {
    if (STATIC_MODE) void hydrateSel(sel)
  }, [hydrateSel, sel, sel.kind, sel.id])

  return (
    <div className={`slot slot-${slot}`}>
      <h3>
        {slot} · {sel.kind}
      </h3>
      {sel.kind === 'node' &&
        (STATIC_MODE ? (
          <StaticNodeInspector key={sel.id} nodeId={sel.id} />
        ) : (
          <NodeInspector key={sel.id} nodeId={sel.id} />
        ))}
      {sel.kind === 'edge' &&
        (STATIC_MODE ? (
          <StaticEdgeInspector key={sel.id} eKey={sel.id} />
        ) : (
          <EdgeInspector key={sel.id} eKey={sel.id} />
        ))}
      {sel.kind === 'skewer' && <SkewerInspector key={sel.id} skewerId={sel.id} />}
    </div>
  )
}

export function Inspector() {
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const multiNodes = useStore((s) => s.multiNodes)

  if (multiNodes.length > 1 && !STATIC_MODE) {
    return (
      <div className="inspector">
        <h3>{multiNodes.length} nodes selected</h3>
        <div className="hint">
          Use the sidebar's "new skewer from selected nodes" to put them on an ordered line.
        </div>
      </div>
    )
  }
  if (!primary && !secondary) return null
  return (
    <div className="inspector">
      {primary && <SlotSection slot="primary" sel={primary} />}
      {secondary && <SlotSection slot="secondary" sel={secondary} />}
    </div>
  )
}

import { useState } from 'react'
import { skewersOf } from './graph'
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
      <div className="hint">
        Drag a member to move the skewer; drag an end handle to rotate or stretch it. Delete
        removes the skewer, not its members. Order lives in the graph (skewer-order edges) —
        edit it via the CLI: kge skewer {skewer.id} &lt;members in new order&gt;
      </div>
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

/** One selection slot, fully editable — primary and secondary get the same
 * treatment, each with its own independent editors. */
function SlotSection({ slot, sel }: { slot: 'primary' | 'secondary'; sel: Sel }) {
  return (
    <div className={`slot slot-${slot}`}>
      <h3>
        {slot} · {sel.kind}
      </h3>
      {sel.kind === 'node' && <NodeInspector key={sel.id} nodeId={sel.id} />}
      {sel.kind === 'edge' && <EdgeInspector key={sel.id} eKey={sel.id} />}
      {sel.kind === 'skewer' && <SkewerInspector key={sel.id} skewerId={sel.id} />}
    </div>
  )
}

export function Inspector() {
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const multiNodes = useStore((s) => s.multiNodes)

  if (multiNodes.length > 1) {
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

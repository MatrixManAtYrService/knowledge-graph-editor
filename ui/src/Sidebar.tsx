// The visibility tree: family -> type -> individual node/edge. Checkboxes at
// every level; checking/unchecking a parent clobbers everything beneath it
// (per-item overrides are cleared). Clicking an item's label selects it on
// the canvas (two-slot selection), same as tapping it.

import { useState } from 'react'
import {
  includedNodeIds,
  peripheryDim,
  SKEWER_EDGE,
  SKEWER_TYPE,
  skewerShown,
  skewersOf,
  visibleSets,
} from './graph'
import { useStore } from './store'
import type { Sel, TypeDef, View } from './types'
import { edgeKey } from './types'

// Legend markers, mirroring the canvas: solid blue circle (primary), dotted
// grey circle (secondary), red crosshairs (focus center).
const MarkPrimary = () => (
  <svg width="14" height="14" viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="#2563eb" strokeWidth="2.5" />
  </svg>
)
const MarkSecondary = () => (
  <svg width="14" height="14" viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeDasharray="1.5 2" />
  </svg>
)
const MarkFocus = () => (
  <svg width="14" height="14" viewBox="0 0 14 14">
    <g stroke="#dc2626" strokeWidth="1.6" fill="none">
      <circle cx="7" cy="7" r="4" />
      <line x1="7" y1="0" x2="7" y2="2.5" />
      <line x1="7" y1="11.5" x2="7" y2="14" />
      <line x1="0" y1="7" x2="2.5" y2="7" />
      <line x1="11.5" y1="7" x2="14" y2="7" />
    </g>
  </svg>
)

interface Item {
  id: string
  label: string
  sel: Sel
}

interface TypeRow {
  name: string
  td: TypeDef
  items: Item[]
}

function TriBox({
  checked,
  mixed,
  onChange,
  disabled,
  title,
}: {
  checked: boolean
  mixed: boolean
  onChange?: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      title={title}
      ref={(el) => {
        if (el) el.indeterminate = mixed
      }}
      onChange={onChange ?? (() => {})}
    />
  )
}

function Caret({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button className="caret" onClick={onClick}>
      {open ? '▾' : '▸'}
    </button>
  )
}

/** "Shown on canvas" indicator and control: open eye, closed eye, or a faint
 * open eye when only some of the rollup is shown. Clicking toggles an eye
 * adjustment (summon/banish on top of the focus) — the next walk step
 * recomputes the focus and drops these. */
function Eye({ state, onClick }: { state: 'on' | 'off' | 'mixed'; onClick?: () => void }) {
  const title =
    state === 'on'
      ? 'shown on the canvas — click to banish from display'
      : state === 'off'
        ? 'not currently shown — click to summon into display'
        : 'partially shown — click to banish all from display'
  return (
    <span className={`eye eye-${state}`} title={title} onClick={onClick}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'off' ? (
          <>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </>
        ) : (
          <>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </>
        )}
      </svg>
    </span>
  )
}

function Tree({
  kind,
  view,
  families,
  shownIds,
}: {
  kind: 'node' | 'edge'
  view: View
  families: Map<string, TypeRow[]>
  shownIds: Set<string>
}) {
  const { setTypesChecked, toggleOverride, tapSelect, adjustShown, setStatus } = useStore()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggleOpen = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const checkedTypes = kind === 'node' ? view.visibleNodeTypes : view.visibleEdgeTypes
  const overrides = new Set(kind === 'node' ? (view.nodeOverrides ?? []) : (view.edgeOverrides ?? []))
  const typeChecked = (t: string) => checkedTypes === null || checkedTypes.includes(t)
  const itemChecked = (t: string, id: string) => typeChecked(t) !== overrides.has(id)

  /** Rollup of the "shown" state over a set of items. */
  const shownState = (items: Item[]): 'on' | 'off' | 'mixed' => {
    const count = items.filter((i) => shownIds.has(i.id)).length
    return count === 0 ? 'off' : count === items.length ? 'on' : 'mixed'
  }

  /** Bulk eye click: banish everything shown, or summon all included items.
   * Only included items participate — the eye never overrides inclusion. */
  const bulkEye = (rows: TypeRow[], state: 'on' | 'off' | 'mixed') => {
    const ids = rows.flatMap((t) =>
      t.items.filter((i) => itemChecked(t.name, i.id)).map((i) => i.id),
    )
    if (!ids.length) {
      setStatus('nothing included here — tick included boxes first')
      return
    }
    adjustShown(ids, state === 'off')
  }

  const allKeys = [...families.entries()].flatMap(([family, types]) => [
    `${kind}:${family}`,
    ...types.map((t) => `${kind}:${family}:${t.name}`),
  ])

  return (
    <>
      <div className="tree-tools">
        <button className="mini" onClick={() => setOpen(new Set(allKeys))}>
          expand all
        </button>
        <button className="mini" onClick={() => setOpen(new Set())}>
          collapse all
        </button>
      </div>
      {[...families.entries()].map(([family, types]) => {
        const famKey = `${kind}:${family}`
        const famOpen = open.has(famKey)
        const states = types.map((t) => typeChecked(t.name))
        const anyOverride = types.some((t) => t.items.some((i) => overrides.has(i.id)))
        const allOn = states.every(Boolean) && !anyOverride
        const allOff = states.every((s) => !s) && !anyOverride
        const famShown = shownState(types.flatMap((t) => t.items))
        return (
          <div key={famKey} className="tree-family">
            <div className="tree-row">
              <Caret open={famOpen} onClick={() => toggleOpen(famKey)} />
              <TriBox
                checked={states.every(Boolean)}
                mixed={!allOn && !allOff}
                title="included in this view"
                onChange={() =>
                  setTypesChecked(kind, types.map((t) => t.name), !states.every(Boolean))
                }
              />
              <Eye state={famShown} onClick={() => bulkEye(types, famShown)} />
              <span className="tree-label family-label">{family}</span>
            </div>
            {famOpen &&
              types.map((t) => {
                const typeKey = `${kind}:${family}:${t.name}`
                const tOpen = open.has(typeKey)
                const hasOverride = t.items.some((i) => overrides.has(i.id))
                const typeShown = shownState(t.items)
                return (
                  <div key={typeKey} className="tree-type">
                    <div className="tree-row">
                      <Caret open={tOpen} onClick={() => toggleOpen(typeKey)} />
                      <TriBox
                        checked={typeChecked(t.name)}
                        mixed={hasOverride}
                        title="included in this view"
                        onChange={() => setTypesChecked(kind, [t.name], !typeChecked(t.name))}
                      />
                      <Eye state={typeShown} onClick={() => bulkEye([t], typeShown)} />
                      {kind === 'node' ? (
                        <span className="dot" style={{ background: t.td.color || '#888' }} />
                      ) : (
                        <span className="dash" style={{ background: t.td.color || '#aaa' }} />
                      )}
                      <span className="tree-label" title={t.td.description}>
                        {t.name} <span className="count">({t.items.length})</span>
                      </span>
                    </div>
                    {tOpen &&
                      t.items.map((item) => (
                        <div key={item.id} className="tree-row tree-item">
                          <input
                            type="checkbox"
                            checked={itemChecked(t.name, item.id)}
                            title="included in this view"
                            onChange={() => toggleOverride(kind, item.id)}
                          />
                          <Eye
                            state={shownIds.has(item.id) ? 'on' : 'off'}
                            onClick={() => {
                              if (!itemChecked(t.name, item.id)) {
                                setStatus('not included in this view — tick its included box first')
                                return
                              }
                              adjustShown([item.id], !shownIds.has(item.id))
                            }}
                          />
                          <span
                            className="tree-label item-label"
                            title={item.id}
                            onClick={() => tapSelect(item.sel)}
                          >
                            {item.label}
                          </span>
                        </div>
                      ))}
                  </div>
                )
              })}
          </div>
        )
      })}
    </>
  )
}

export function Sidebar() {
  const graph = useStore((s) => s.graph)
  const walkMode = useStore((s) => s.walkMode)
  const focusHops = useStore((s) => s.focusHops)
  const stashedFocus = useStore((s) => s.stashedFocus)
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const { setWalkMode, setFocusHops, clearFocus, restoreFocus } = useStore()
  const view = useStore((s) => s.view())

  if (!graph || !view) return <div className="sidebar" />

  const familiesOf = (
    schema: Record<string, TypeDef>,
    itemsFor: (type: string) => Item[],
  ): Map<string, TypeRow[]> => {
    const out = new Map<string, TypeRow[]>()
    for (const [name, td] of Object.entries(schema)) {
      const family = td.family || 'other'
      out.set(family, [...(out.get(family) ?? []), { name, td, items: itemsFor(name) }])
    }
    return new Map([...out.entries()].sort())
  }

  const nodeFamilies = familiesOf(graph.schema.nodeTypes, (type) =>
    graph.nodes
      .filter((n) => n.type === type)
      .map((n) => ({
        id: n.id,
        label: n.label || n.id,
        sel: { kind: type === SKEWER_TYPE ? 'skewer' : 'node', id: n.id } as Sel,
      })),
  )
  const edgeFamilies = familiesOf(
    Object.fromEntries(
      Object.entries(graph.schema.edgeTypes).filter(([name]) => name !== SKEWER_EDGE),
    ),
    (type) =>
      graph.edges
        .filter((e) => e.type === type)
        .map((e) => ({
          id: edgeKey(e),
          label: `${e.from} → ${e.to}`,
          sel: { kind: 'edge', id: edgeKey(e) } as Sel,
        })),
  )

  // What the canvas is actually rendering right now: included minus whatever
  // the focus banished. This is what the "shown" eye column reflects, live,
  // as a refocus walk moves around.
  const { nodes: shownNodes, edges: shownEdges } = visibleSets(graph, view)
  const shownIds = new Set<string>([...shownNodes, ...shownEdges])
  for (const s of skewersOf(graph)) {
    if (skewerShown(view, s.id) && s.members.some((m) => shownNodes.has(m))) shownIds.add(s.id)
  }

  // Legend visibility: selection rows need a pair; focus rows only matter
  // when the focus actually hides or dims something.
  const dim = peripheryDim(graph, view, shownNodes, shownEdges)
  const included = includedNodeIds(graph, view)
  const focusEffective =
    view.focus !== null && ([...included].some((n) => !shownNodes.has(n)) || dim.size > 0)
  const selLabel = (sel: Sel): string => {
    if (sel.kind === 'edge') return sel.id
    const n = graph.nodes.find((x) => x.id === sel.id)
    return n?.label || sel.id
  }

  return (
    <div className="sidebar">
      <div className="section">
        <h3>nodes</h3>
        <Tree kind="node" view={view} families={nodeFamilies} shownIds={shownIds} />
      </div>

      <div className="section">
        <h3>edges</h3>
        <Tree kind="edge" view={view} families={edgeFamilies} shownIds={shownIds} />
      </div>

      <div className="section">
        <h3>click behavior</h3>
        <label
          className="type-row"
          title="Each node click refocuses the view on that node's neighborhood — walk the graph click by click."
        >
          <input
            type="radio"
            name="click-behavior"
            checked={walkMode}
            onChange={() => setWalkMode(true)}
          />
          refocus
        </label>
        <label className="type-row" title="Clicks select for viewing and editing; the view stays put.">
          <input
            type="radio"
            name="click-behavior"
            checked={!walkMode}
            onChange={() => setWalkMode(false)}
          />
          view/edit
        </label>
        {walkMode && (
          <label className="khops">
            focus-hops:{' '}
            <input
              type="number"
              min={1}
              max={10}
              value={view.focus?.kHops ?? focusHops}
              onChange={(e) => setFocusHops(Number(e.target.value) || 1)}
            />
          </label>
        )}
        {(view.focus || stashedFocus) && (
          <button
            onClick={() => (view.focus ? clearFocus() : restoreFocus())}
            title={
              view.focus
                ? 'Show everything included (the focus is remembered)'
                : 'Bring back the cleared focus, including its eye adjustments'
            }
          >
            {view.focus ? 'Clear focus' : 'Restore focus'}
          </button>
        )}
      </div>

      {(primary || focusEffective) && (
        <div className="section legend">
          {primary && (
            <div className="legend-row">
              <MarkPrimary />
              <span className="legend-key">primary selection</span>
              <span className="legend-val">{selLabel(primary)}</span>
            </div>
          )}
          {secondary && (
            <div className="legend-row">
              <MarkSecondary />
              <span className="legend-key">secondary selection</span>
              <span className="legend-val">{selLabel(secondary)}</span>
            </div>
          )}
          {focusEffective && view.focus && (
            <>
              <div className="legend-row">
                <MarkFocus />
                <span className="legend-key">focus center</span>
                <span className="legend-val">
                  {graph.nodes.find((n) => n.id === view.focus!.node)?.label || view.focus.node}
                </span>
              </div>
              <div className="legend-row">
                <span className="legend-mark-pad" />
                <span className="legend-key">focus hops</span>
                <span className="legend-val">{view.focus.kHops}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

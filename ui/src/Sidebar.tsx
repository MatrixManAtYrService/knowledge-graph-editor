// The visibility tree: family -> type -> individual node/edge. Checkboxes at
// every level; checking/unchecking a parent clobbers everything beneath it
// (per-item overrides are cleared). Clicking an item's label selects it on
// the canvas (two-slot selection), same as tapping it.

import { useState } from 'react'
import { positionsOf } from './GraphCanvas'
import {
  boundValue,
  groupOpts,
  includedNodeIds,
  nodeColor,
  peripheryDim,
  SKEWER_EDGE,
  SKEWER_TYPE,
  skewerShown,
  skewersOf,
  visibleSets,
  type Skewer,
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

/** The skewers tree: one bundle per data.group (default: the ordering key),
 * with enable checkboxes — a disabled skewer keeps its members on canvas,
 * just not on a rail — and per-bundle presentation options. */
function SkewerTree({ view, shownIds }: { view: View; shownIds: Set<string> }) {
  const graph = useStore((s) => s.graph)!
  const {
    setSkewersEnabled,
    setBundleAlign,
    applyBundleSpacing,
    equalizeBundle,
    rotateBundle,
    padBundle,
    setPositions,
    tapSelect,
  } = useStore()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggleOpen = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const bundles = new Map<string, Skewer[]>()
  for (const s of skewersOf(graph)) {
    const key = s.group ?? '(ungrouped)'
    bundles.set(key, [...(bundles.get(key) ?? []), s])
  }
  if (!bundles.size) return <div className="tree-empty">no skewers yet</div>

  /** Disabling rails frees their members: capture the rail-derived positions
   * first so the nodes stay where they are instead of scattering. */
  const setEnabled = (skewers: Skewer[], enabled: boolean) => {
    if (!enabled) setPositions(positionsOf(skewers.flatMap((s) => s.members)))
    setSkewersEnabled(skewers.map((s) => s.id), enabled)
  }

  return (
    <>
      {[...bundles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, skewers]) => {
        const real = skewers.some((s) => s.group !== null) // ungrouped bundles get no options
        const opts = groupOpts(view, key)
        const enabled = skewers.filter((s) => skewerShown(view, s.id))
        const allOn = enabled.length === skewers.length
        const isOpen = open.has(key)
        return (
          <div key={key} className="tree-family">
            <div className="tree-row">
              <Caret open={isOpen} onClick={() => toggleOpen(key)} />
              <TriBox
                checked={enabled.length > 0}
                mixed={enabled.length > 0 && !allOn}
                title="skewers enabled (members stay on canvas either way)"
                onChange={() => setEnabled(skewers, !allOn)}
              />
              <span className="tree-label family-label">
                {key} <span className="count">({skewers.length})</span>
              </span>
            </div>
            {isOpen && (
              <>
                {skewers.map((s) => (
                  <div key={s.id} className="tree-row tree-item">
                    <input
                      type="checkbox"
                      checked={skewerShown(view, s.id)}
                      title="enabled: members ride this rail — off: they float free"
                      onChange={() => setEnabled([s], !skewerShown(view, s.id))}
                    />
                    <Eye state={shownIds.has(s.id) ? 'on' : 'off'} />
                    <span
                      className="tree-label item-label"
                      title={s.id}
                      onClick={() => tapSelect({ kind: 'skewer', id: s.id })}
                    >
                      {s.label}
                    </span>
                  </div>
                ))}
                {real && (
                  <div className="skewer-opts">
                    <label title="The bundle's rails share a direction and their starts/ends stay colinear — dragging or stretching one moves them all; each rail keeps only its sideways offset.">
                      <input
                        type="checkbox"
                        checked={opts.align}
                        onChange={() => setBundleAlign(key, !opts.align)}
                      />
                      align
                    </label>
                    <div className="skewer-actions">
                      <button
                        className="mini"
                        title="Snap the rails onto evenly spaced lanes, keeping their order (a pinned rail anchors the grid)."
                        onClick={() => equalizeBundle(key)}
                      >
                        make equidistant
                      </button>
                      <button
                        className="mini"
                        title="Turn the whole bundle a quarter turn about its center."
                        onClick={() => rotateBundle(key)}
                      >
                        rotate 90°
                      </button>
                      <button
                        className="mini"
                        title="Stretch the rails just enough that neighboring dots and labels stay clear of each other."
                        onClick={() => padBundle(key)}
                      >
                        add padding
                      </button>
                      <button
                        className="mini"
                        title="Each rail spaces its own members evenly along itself (the default)."
                        onClick={() => applyBundleSpacing(key, 'even')}
                      >
                        space evenly per skewer
                      </button>
                      <button
                        className="mini"
                        title="Interleave members across the bundle in one merged order, evenly spaced — order carries across rails, durations carry no weight. Works with any sortable value."
                        onClick={() => applyBundleSpacing(key, 'order')}
                      >
                        apply shared order
                      </button>
                      <button
                        className="mini"
                        title="Place members at their ordering-key value on one scale shared by the bundle — durations are literal, lulls are gaps, and a value axis is drawn. Needs numeric or date values."
                        onClick={() => applyBundleSpacing(key, 'proportional')}
                      >
                        apply proportional order
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Passive legend for the schema's color binding (declared by whoever seeds
 * the data, not toggled here): which data[colorKey] value wears which color. */
function ColorLegend() {
  const graph = useStore((s) => s.graph)!
  const values = new Map<string, { color: string; count: number }>()
  for (const n of graph.nodes) {
    if (n.type === SKEWER_TYPE) continue
    const value = boundValue(graph.schema, n)
    if (value === null) continue
    const cur = values.get(value)
    if (cur) cur.count++
    else values.set(value, { color: nodeColor(graph.schema, n, '#888'), count: 1 })
  }
  if (!values.size) return null
  return (
    <div className="section">
      <h3>color: {graph.schema.colorKey}</h3>
      {[...values.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([value, { color, count }]) => (
          <div key={value} className="tree-row">
            <span className="dot" style={{ background: color }} />
            <span className="tree-label">
              {value} <span className="count">({count})</span>
            </span>
          </div>
        ))}
    </div>
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
        <h3>skewers</h3>
        <SkewerTree view={view} shownIds={shownIds} />
      </div>

      <ColorLegend />

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

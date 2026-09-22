// The visibility tree: family -> type -> individual node/edge. Checkboxes at
// every level; checking/unchecking a parent clobbers everything beneath it
// (per-item overrides are cleared). Clicking an item's label selects it on
// the canvas (two-slot selection), same as tapping it.

import { useEffect, useState } from 'react'
import { positionsOf, skewerFromSelection, viewportCenter } from './GraphCanvas'
import {
  boundValue,
  fociOf,
  groupOpts,
  includedNodeIds,
  nodeColor,
  peripheryDim,
  SKEWER_EDGE,
  SKEWER_TYPE,
  skewerShown,
  skewersOf,
  valueColor,
  visibleSets,
  type Skewer,
} from './graph'
import { STATIC_MODE, staticGraph } from './static'
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
  skewers?: string[] // skewers this node rides (drives the unskewer button)
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

/** Pushpin toggle: pinned items hold their place through layout runs.
 * Filled red = pinned; faint outline = free. */
function Pin({ pinned, onClick, title }: { pinned: boolean; onClick: () => void; title?: string }) {
  return (
    <span
      className={`pin ${pinned ? 'pin-on' : ''}`}
      title={title ?? (pinned ? 'pinned — layout won’t move it; click to release' : 'click to pin in place (layout won’t move it)')}
      onClick={onClick}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
      </svg>
    </span>
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
  totals,
}: {
  kind: 'node' | 'edge'
  view: View
  families: Map<string, TypeRow[]>
  shownIds: Set<string>
  /** Windowed static mode: how many items of each type exist in the data
   * (the rows below list only the loaded sliver). */
  totals?: Record<string, number>
}) {
  const {
    setTypesChecked,
    toggleOverride,
    tapSelect,
    adjustShown,
    setStatus,
    deleteItems,
    removeFromSkewer,
    setPinned,
    setSkewerPinned,
    setPositions,
  } = useStore()
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [follow, setFollow] = useState(true)
  const toggleOpen = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  // follow-focus: reveal exactly the selected things themselves — the
  // primary/secondary node, skewer, or edge — and nothing adjacent.
  const selIds = new Set([primary, secondary].filter((s): s is Sel => !!s).map((s) => s.id))
  const isTarget = (item: Item): boolean => selIds.has(item.id)

  /** The exact open set that reveals the selection — sections opened only
   * incidentally close again as soon as the selection moves elsewhere. */
  const followKeys = (): Set<string> => {
    const keys = new Set<string>()
    for (const [family, types] of families) {
      for (const t of types) {
        if (t.items.some(isTarget)) {
          keys.add(`${kind}:${family}`)
          keys.add(`${kind}:${family}:${t.name}`)
        }
      }
    }
    return keys
  }

  useEffect(() => {
    if (follow) setOpen(followKeys())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on selection moves only
  }, [follow, primary?.id, secondary?.id])

  const checkedTypes = kind === 'node' ? view.visibleNodeTypes : view.visibleEdgeTypes
  const overrides = new Set(kind === 'node' ? (view.nodeOverrides ?? []) : (view.edgeOverrides ?? []))
  const pinnedNodes = new Set(view.layout.pinned)
  const itemPinned = (item: Item) =>
    item.sel.kind === 'skewer'
      ? (view.layout.skewers[item.id]?.pinned ?? false)
      : pinnedNodes.has(item.id)
  const togglePin = (item: Item) => {
    if (item.sel.kind === 'skewer') {
      setSkewerPinned(item.id, !itemPinned(item))
      return
    }
    const on = !pinnedNodes.has(item.id)
    if (on) setPositions(positionsOf([item.id])) // pin where it stands right now
    setPinned([item.id], on)
  }
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
        <button
          className="mini"
          title="Open every section (turns follow-focus off)"
          onClick={() => {
            setFollow(false)
            setOpen(new Set(allKeys))
          }}
        >
          expand all
        </button>
        <button
          className="mini"
          title="Close every section (turns follow-focus off)"
          onClick={() => {
            setFollow(false)
            setOpen(new Set())
          }}
        >
          collapse all
        </button>
        <button
          className={`mini${follow ? ' toggled-on' : ''}`}
          title="Keep just enough sections open to reveal the primary/secondary selection; incidental sections close when the selection moves on."
          onClick={() => {
            const next = !follow
            setFollow(next)
            if (next) setOpen(followKeys())
          }}
        >
          follow-focus
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
                        {t.name}{' '}
                        <span
                          className="count"
                          title={
                            totals && (totals[t.name] ?? 0) > t.items.length
                              ? `${t.items.length} of ${totals[t.name]} loaded — the rest stays on the server until a focus or filter reaches it`
                              : undefined
                          }
                        >
                          (
                          {totals && (totals[t.name] ?? 0) > t.items.length
                            ? `${t.items.length}/${totals[t.name]}`
                            : t.items.length}
                          )
                        </span>
                      </span>
                    </div>
                    {tOpen &&
                      t.items.map((item) => (
                        <div
                          key={item.id}
                          className={`tree-row tree-item${
                            primary?.id === item.id
                              ? ' row-sel-primary'
                              : secondary?.id === item.id
                                ? ' row-sel-secondary'
                                : ''
                          }`}
                        >
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
                          {kind === 'node' && (
                            <Pin pinned={itemPinned(item)} onClick={() => togglePin(item)} />
                          )}
                          <span
                            className="tree-label item-label"
                            title={item.id}
                            onClick={() => tapSelect(item.sel)}
                          >
                            {item.label}
                          </span>
                          {!STATIC_MODE && item.skewers && item.skewers.length > 0 && (
                            <button
                              className="row-btn"
                              title={`unskewer: remove from ${item.skewers.join(', ')} (the node stays)`}
                              onClick={() =>
                                item.skewers!.forEach((sid) => removeFromSkewer(sid, item.id))
                              }
                            >
                              ⊘
                            </button>
                          )}
                          {!STATIC_MODE && (
                            <button
                              className="row-btn"
                              title={
                                kind === 'node'
                                  ? item.sel.kind === 'skewer'
                                    ? 'delete this skewer from the graph (its members stay)'
                                    : 'delete this node and its edges from the graph'
                                  : 'delete this edge from the graph'
                              }
                              onClick={() =>
                                deleteItems(
                                  kind === 'node' ? [item.id] : [],
                                  kind === 'edge' ? [item.id] : [],
                                )
                              }
                            >
                              ⊖
                            </button>
                          )}
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
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const multiNodes = useStore((s) => s.multiNodes)
  const {
    setSkewersEnabled,
    setBundleAlign,
    setBundleGrouped,
    applyBundleSpacing,
    equalizeBundle,
    rotateBundle,
    padBundle,
    setPositions,
    tapSelect,
    addToSkewer,
    setSkewerPinned,
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

  const canNewSkewer =
    multiNodes.length >= 2 ||
    (primary?.kind === 'node' && secondary?.kind === 'node' && primary.id !== secondary.id)
  const newSkewer = STATIC_MODE ? null : (
    <div className="tree-tools">
      <button
        className="mini"
        disabled={!canNewSkewer}
        title="Put the selected nodes on a new skewer: an ordered line they stay on. Click two nodes, or shift/box-select more."
        onClick={() => skewerFromSelection()}
      >
        new skewer from selected nodes
      </button>
    </div>
  )
  if (!bundles.size)
    return (
      <>
        {newSkewer}
        <div className="tree-empty">no skewers yet</div>
      </>
    )

  /** Disabling rails frees their members: capture the rail-derived positions
   * first so the nodes stay where they are instead of scattering. */
  const setEnabled = (skewers: Skewer[], enabled: boolean) => {
    if (!enabled) setPositions(positionsOf(skewers.flatMap((s) => s.members)))
    setSkewersEnabled(skewers.map((s) => s.id), enabled)
  }

  return (
    <>
      {newSkewer}
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
                {skewers.map((s) => {
                  const canAdd = primary?.kind === 'node' && !s.members.includes(primary.id)
                  const primaryRails =
                    primary?.kind === 'node'
                      ? skewersOf(graph)
                          .filter((x) => x.members.includes(primary.id))
                          .map((x) => x.id)
                      : []
                  const addTitle =
                    primary?.kind !== 'node'
                      ? 'select a node first (click it), then add it to this skewer'
                      : s.members.includes(primary.id)
                        ? `${primary.id} is already on this skewer`
                        : primaryRails.length
                          ? `move the selected node (${primary.id}) here — a node rides one skewer, so it leaves ${primaryRails.join(', ')}`
                          : `add the selected node (${primary.id}) to the end of this skewer`
                  return (
                    <div
                      key={s.id}
                      className={`tree-row tree-item${
                        primary?.id === s.id
                          ? ' row-sel-primary'
                          : secondary?.id === s.id
                            ? ' row-sel-secondary'
                            : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={skewerShown(view, s.id)}
                        title="enabled: members ride this rail — off: they float free"
                        onChange={() => setEnabled([s], !skewerShown(view, s.id))}
                      />
                      <Eye state={shownIds.has(s.id) ? 'on' : 'off'} />
                      {!STATIC_MODE && (
                        <button
                          className="row-btn row-btn-add"
                          disabled={!canAdd}
                          title={addTitle}
                          onClick={() => addToSkewer(s.id, primary!.id)}
                        >
                          ⊕
                        </button>
                      )}
                      <Pin
                        pinned={view.layout.skewers[s.id]?.pinned ?? false}
                        onClick={() =>
                          setSkewerPinned(s.id, !(view.layout.skewers[s.id]?.pinned ?? false))
                        }
                      />
                      <span
                        className="tree-label item-label"
                        title={s.id}
                        onClick={() => tapSelect({ kind: 'skewer', id: s.id })}
                      >
                        {s.label}
                      </span>
                    </div>
                  )
                })}
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
                    <label title="Dragging any rail moves the whole bundle rigidly — each rail keeps its own position, angle, and length. Reposition the bundle without imposing alignment.">
                      <input
                        type="checkbox"
                        checked={opts.grouped ?? false}
                        onChange={() => setBundleGrouped(key, !opts.grouped)}
                      />
                      group
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
  const colorTotals = staticGraph()?.totals?.colors
  if (colorTotals && Object.keys(colorTotals).length) {
    // Windowed static mode: the legend covers the whole dataset, not just
    // the loaded sliver — counts come from the export's aggregates.
    for (const [value, count] of Object.entries(colorTotals)) {
      values.set(value, { color: valueColor(graph.schema, value), count })
    }
  } else {
    for (const n of graph.nodes) {
      if (n.type === SKEWER_TYPE) continue
      const value = boundValue(graph.schema, n)
      if (value === null) continue
      const cur = values.get(value)
      if (cur) cur.count++
      else values.set(value, { color: nodeColor(graph.schema, n, '#888'), count: 1 })
    }
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

/** Node creation, in the nodes section: a toggle revealing type/id/label.
 * The node lands at the viewport center, selected, in the edit buffer. */
function NewNodeForm() {
  const graph = useStore((s) => s.graph)!
  const { addNode, setStatus } = useStore()
  const [openForm, setOpenForm] = useState(false)
  const [type, setType] = useState('')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const nodeTypes = Object.keys(graph.schema.nodeTypes).filter((t) => t !== SKEWER_TYPE)

  const onAdd = () => {
    const t = type || nodeTypes[0]
    if (!t) {
      setStatus('add a node type to the schema first (kge add-type node <name>)')
      return
    }
    addNode(t, id.trim(), label.trim(), viewportCenter())
    setOpenForm(false)
    setId('')
    setLabel('')
  }

  return (
    <div className="tree-tools new-node">
      <button className="mini" onClick={() => setOpenForm(!openForm)}>
        {openForm ? 'cancel' : 'new node'}
      </button>
      {openForm && (
        <span className="add-form">
          <select value={type || nodeTypes[0] || ''} onChange={(e) => setType(e.target.value)}>
            {nodeTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input placeholder="id" value={id} onChange={(e) => setId(e.target.value)} />
          <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="mini accent" onClick={onAdd} disabled={!id.trim()}>
            add
          </button>
        </span>
      )}
    </div>
  )
}

/** Edge creation, in the edges section: connect the secondary-selected node
 * to the primary-selected one with the chosen type. */
function ConnectRow() {
  const graph = useStore((s) => s.graph)!
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const connectEdgeType = useStore((s) => s.connectEdgeType)
  const { connect, setConnectEdgeType } = useStore()
  const edgeTypes = Object.keys(graph.schema.edgeTypes).filter((t) => t !== SKEWER_EDGE)
  const canConnect = primary?.kind === 'node' && secondary?.kind === 'node'
  return (
    <div className="tree-tools connect-row">
      <select
        value={connectEdgeType}
        onChange={(e) => setConnectEdgeType(e.target.value)}
        title="Edge type used by connect"
      >
        {edgeTypes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button
        className="mini"
        onClick={connect}
        disabled={!canConnect}
        title={
          canConnect
            ? `create ${secondary!.id} -[${connectEdgeType}]-> ${primary!.id}`
            : 'click a source node, then a target node, then connect (secondary → primary)'
        }
      >
        connect
      </button>
    </div>
  )
}

export function Sidebar() {
  const graph = useStore((s) => s.graph)
  const clickMode = useStore((s) => s.clickMode)
  const focusHops = useStore((s) => s.focusHops)
  const stashedFocus = useStore((s) => s.stashedFocus)
  const primary = useStore((s) => s.primary)
  const secondary = useStore((s) => s.secondary)
  const { setClickMode, setFocusHops, clearFocus, restoreFocus } = useStore()
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

  // Which skewers each node rides (drives the tree's unskewer buttons).
  const memberOf = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (e.type === SKEWER_EDGE) memberOf.set(e.to, [...(memberOf.get(e.to) ?? []), e.from])
  }

  const nodeFamilies = familiesOf(graph.schema.nodeTypes, (type) =>
    graph.nodes
      .filter((n) => n.type === type)
      .map((n) => ({
        id: n.id,
        label: n.label || n.id,
        sel: { kind: type === SKEWER_TYPE ? 'skewer' : 'node', id: n.id } as Sel,
        skewers: memberOf.get(n.id),
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
  const foci = fociOf(view)
  const focusEffective =
    foci.length > 0 && ([...included].some((n) => !shownNodes.has(n)) || dim.size > 0)
  const selLabel = (sel: Sel): string => {
    if (sel.kind === 'edge') return sel.id
    const n = graph.nodes.find((x) => x.id === sel.id)
    return n?.label || sel.id
  }

  return (
    <div className="sidebar">
      <div className="section">
        <h3>nodes</h3>
        {!STATIC_MODE && <NewNodeForm />}
        <Tree
          kind="node"
          view={view}
          families={nodeFamilies}
          shownIds={shownIds}
          totals={staticGraph()?.totals?.nodeTypes}
        />
      </div>

      <div className="section">
        <h3>edges</h3>
        {!STATIC_MODE && <ConnectRow />}
        <Tree
          kind="edge"
          view={view}
          families={edgeFamilies}
          shownIds={shownIds}
          totals={staticGraph()?.totals?.edgeTypes}
        />
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
          title="Each node click makes the clicked node the ONLY focus — walk the graph click by click. Clobbers the other foci and any eye adjustments."
        >
          <input
            type="radio"
            name="click-behavior"
            checked={clickMode === 'refocus'}
            onChange={() => setClickMode('refocus')}
          />
          refocus
        </label>
        <label
          className="type-row"
          title="Clicking a node adds it as another focus center (its focus-hops neighborhood joins what's shown); clicking a focus center (red crosshairs) removes that focus, along with any eye-summons within its reach. Clobbers nothing else — eye adjustments stay."
        >
          <input
            type="radio"
            name="click-behavior"
            checked={clickMode === 'toggle'}
            onChange={() => setClickMode('toggle')}
          />
          add/remove focus
        </label>
        <label className="type-row" title="Clicks select for viewing and editing; the view stays put.">
          <input
            type="radio"
            name="click-behavior"
            checked={clickMode === 'view'}
            onChange={() => setClickMode('view')}
          />
          view/edit
        </label>
        {(clickMode === 'refocus' || clickMode === 'toggle') && (
          <label
            className="khops"
            title="The radius the next refocus / added focus uses; existing foci keep theirs (remove and re-add a center to change it)."
          >
            focus-hops:{' '}
            <input
              type="number"
              min={1}
              max={10}
              value={focusHops}
              onChange={(e) => setFocusHops(Number(e.target.value) || 1)}
            />
          </label>
        )}
        {(foci.length > 0 || stashedFocus) && (
          <button
            onClick={() => (foci.length ? clearFocus() : restoreFocus())}
            title={
              foci.length
                ? 'Show everything included (the foci are remembered)'
                : 'Bring back the cleared foci, including their eye adjustments'
            }
          >
            {foci.length ? (foci.length > 1 ? 'Clear foci' : 'Clear focus') : 'Restore focus'}
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
          {focusEffective &&
            foci.map((f) => (
              <div className="legend-row" key={f.node}>
                <MarkFocus />
                <span className="legend-key">focus ({f.kHops} hops)</span>
                <span className="legend-val">
                  {graph.nodes.find((n) => n.id === f.node)?.label || f.node}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

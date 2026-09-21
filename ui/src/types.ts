// Mirrors src/kge/models.py — the payload GET/PUT /api/graph carries.

export interface TypeDef {
  color: string
  description: string
  family?: string // grouping level above type in the visibility tree
}

export interface GraphSchema {
  nodeTypes: Record<string, TypeDef>
  edgeTypes: Record<string, TypeDef>
  /** Bind node color to a node-data field, dataset-wide: nodes sharing a
   * value of data[colorKey] share a color, overriding their type color
   * (nodes without the field keep it). colorValues pins specific values;
   * others get stable palette picks. Declared by whoever seeds the data —
   * an author, a component, a status: the semantics are the caller's. */
  colorKey?: string
  colorValues?: Record<string, string>
}

export interface NodeT {
  id: string
  type: string
  label: string
  data: Record<string, unknown>
}

export interface EdgeT {
  type: string
  from: string
  to: string
  data: Record<string, unknown>
}

export const edgeKey = (e: Pick<EdgeT, 'type' | 'from' | 'to'>): string =>
  `${e.type}|${e.from}|${e.to}`

export interface Position {
  x: number
  y: number
}

/** Per-view geometry of one skewer: the segment its members lie on.
 * Membership + order are graph knowledge (skewer node + skewer-order edges);
 * the segment (position, angle, length via its endpoints) is presentation. */
export interface SkewerGeom {
  a: Position
  b: Position
  pinned: boolean
}

export interface LayoutHints {
  engine: string
  seedPositions: Record<string, Position>
  pinned: string[]
  skewers: Record<string, SkewerGeom>
  /** Baked member placement: skewer id -> member id -> fraction along the
   * rail. Written by the bundle spacing actions (shared order / proportional
   * order); absent members and absent rails space evenly. Optional so old
   * payloads still parse. */
  memberFracs?: Record<string, Record<string, number>>
  rules: unknown[]
}

/** One focus center: its k-hop neighborhood is part of what the view shows.
 * A view may hold several; their neighborhoods union. */
export interface Focus {
  node: string
  kHops: number
}

/** The value range a proportional-order application mapped onto the rails —
 * what the floating axis labels. */
export interface AxisInfo {
  min: number
  max: number
  isDate: boolean
}

/** Per-view options for one bundle of skewers (skewers sharing a data.group
 * name, which defaults to their data.orderKey — the member-data field the
 * order reflects, e.g. "date"). Spacing itself is not an option here: the
 * spacing ACTIONS bake fractions into layout.memberFracs, which the user is
 * then free to drag around. */
export interface SkewerGroupOpts {
  /** Live constraint: rails share a direction and their starts/ends stay
   * colinear (aligned lanes) — dragging or stretching one rail moves them
   * all, each keeping only its sideways offset. */
  align: boolean
  /** Live constraint: dragging any rail translates the whole bundle rigidly
   * — each rail keeps its own position, angle, and length. The handle for
   * moving a bundle around without imposing alignment. */
  grouped?: boolean
  /** Set while proportional order is applied; drawn as the floating axis. */
  axis?: AxisInfo | null
}

export interface View {
  id: string
  name: string
  visibleNodeTypes: string[] | null // null = all types checked
  visibleEdgeTypes: string[] | null
  /** Per-item exceptions: shown iff type checked XOR listed here. Checking a
   * type or family clobbers (clears) the overrides beneath it. */
  nodeOverrides: string[]
  edgeOverrides: string[] // edge keys 'type|from|to'
  /** Focus centers; empty = no focus. The server migrates pre-multifocus
   * payloads (single `focus` field) into this on read. */
  foci: Focus[]
  /** Eye adjustments layered on the focus: summon (focusShow) or banish
   * (focusHide) individual items without changing inclusion. Cleared by any
   * focus recenter — the hop algorithm recomputes from scratch. */
  focusShow: string[] // node ids or edge keys
  focusHide: string[]
  /** Bundle options, keyed by the skewers' data.group (default: their
   * data.orderKey). Optional so payloads saved before this field existed
   * still parse. */
  skewerGroups?: Record<string, SkewerGroupOpts>
  layout: LayoutHints
}

export interface GraphPayload {
  schema: GraphSchema
  nodes: NodeT[]
  edges: EdgeT[]
  views: View[]
}

/** One entry of GET /api/graphs — a graph the server offers. */
export interface GraphInfo {
  id: string
  nodes: number
  edges: number
  views: number
  default: boolean
}

/** One selection slot. Edge ids use the edge key form 'type|from|to'. */
export interface Sel {
  kind: 'node' | 'edge' | 'skewer'
  id: string
}

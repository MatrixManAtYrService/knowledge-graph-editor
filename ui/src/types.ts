// Mirrors src/kge/models.py — the payload GET/PUT /api/graph carries.

export interface TypeDef {
  color: string
  description: string
  family?: string // grouping level above type in the visibility tree
}

export interface GraphSchema {
  nodeTypes: Record<string, TypeDef>
  edgeTypes: Record<string, TypeDef>
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
  rules: unknown[]
}

export interface Focus {
  node: string
  kHops: number
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
  focus: Focus | null
  /** Eye adjustments layered on the focus: summon (focusShow) or banish
   * (focusHide) individual items without changing inclusion. Cleared by any
   * focus recenter — the hop algorithm recomputes from scratch. */
  focusShow: string[] // node ids or edge keys
  focusHide: string[]
  layout: LayoutHints
}

export interface GraphPayload {
  schema: GraphSchema
  nodes: NodeT[]
  edges: EdgeT[]
  views: View[]
}

/** One selection slot. Edge ids use the edge key form 'type|from|to'. */
export interface Sel {
  kind: 'node' | 'edge' | 'skewer'
  id: string
}

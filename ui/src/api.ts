import { STATIC_MODE, staticFetchGraph, staticFetchGraphs } from './static'
import type { GraphInfo, GraphPayload, Sel } from './types'

/** Publish the two-slot selection and current graph + view so agents can read
 * them (kge selection, kge find-collisions). Fire-and-forget: transient
 * state, last writer wins. On the static site there is nobody to tell — the
 * URL hash (share.ts) carries the selection instead. */
export function postSelection(
  primary: Sel | null,
  secondary: Sel | null,
  graph: string,
  view: string,
): void {
  if (STATIC_MODE) return
  void fetch('/api/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, secondary, graph, view }),
  }).catch(() => {})
}

async function fail(resp: Response, what: string): Promise<Error> {
  let detail = `${resp.status}`
  try {
    const body = await resp.json()
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch {
    /* keep status */
  }
  return new Error(`${what}: ${detail}`)
}

const readOnly = (): Error => new Error('this is a read-only site — edits cannot be saved here')

export async function fetchGraphs(): Promise<GraphInfo[]> {
  if (STATIC_MODE) return staticFetchGraphs()
  const resp = await fetch('/api/graphs')
  if (!resp.ok) throw await fail(resp, 'GET /api/graphs failed')
  return (await resp.json()).graphs
}

export async function fetchGraph(graphId: string): Promise<GraphPayload> {
  if (STATIC_MODE) return staticFetchGraph(graphId)
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`)
  if (!resp.ok) throw await fail(resp, `GET graph ${graphId} failed`)
  return resp.json()
}

export async function putGraph(graphId: string, graph: GraphPayload): Promise<void> {
  if (STATIC_MODE) throw readOnly()
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })
  if (!resp.ok) throw await fail(resp, 'save rejected')
}

export async function deleteGraph(graphId: string): Promise<void> {
  if (STATIC_MODE) throw readOnly()
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, { method: 'DELETE' })
  if (!resp.ok) throw await fail(resp, 'delete graph rejected')
}

export async function createGraph(graphId: string): Promise<void> {
  if (STATIC_MODE) throw readOnly()
  const resp = await fetch('/api/graphs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: graphId }),
  })
  if (!resp.ok) throw await fail(resp, 'new graph rejected')
}

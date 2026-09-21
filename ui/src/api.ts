import type { GraphInfo, GraphPayload, Sel } from './types'

/** Publish the two-slot selection and current graph + view so agents can read
 * them (kge selection, kge find-collisions). Fire-and-forget: transient
 * state, last writer wins. */
export function postSelection(
  primary: Sel | null,
  secondary: Sel | null,
  graph: string,
  view: string,
): void {
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

export async function fetchGraphs(): Promise<GraphInfo[]> {
  const resp = await fetch('/api/graphs')
  if (!resp.ok) throw await fail(resp, 'GET /api/graphs failed')
  return (await resp.json()).graphs
}

export async function fetchGraph(graphId: string): Promise<GraphPayload> {
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`)
  if (!resp.ok) throw await fail(resp, `GET graph ${graphId} failed`)
  return resp.json()
}

export async function putGraph(graphId: string, graph: GraphPayload): Promise<void> {
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })
  if (!resp.ok) throw await fail(resp, 'save rejected')
}

export async function deleteGraph(graphId: string): Promise<void> {
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, { method: 'DELETE' })
  if (!resp.ok) throw await fail(resp, 'delete graph rejected')
}

export async function createGraph(graphId: string): Promise<void> {
  const resp = await fetch('/api/graphs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: graphId }),
  })
  if (!resp.ok) throw await fail(resp, 'new graph rejected')
}

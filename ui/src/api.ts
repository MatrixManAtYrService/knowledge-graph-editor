import type { GraphPayload, Sel } from './types'

/** Publish the two-slot selection and current view so agents can read them
 * (kge selection, kge find-collisions). Fire-and-forget: transient state,
 * last writer wins. */
export function postSelection(primary: Sel | null, secondary: Sel | null, view: string): void {
  void fetch('/api/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary, secondary, view }),
  }).catch(() => {})
}

export async function fetchGraph(): Promise<GraphPayload> {
  const resp = await fetch('/api/graph')
  if (!resp.ok) throw new Error(`GET /api/graph failed: ${resp.status}`)
  return resp.json()
}

export async function putGraph(graph: GraphPayload): Promise<void> {
  const resp = await fetch('/api/graph', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })
  if (!resp.ok) {
    let detail = `${resp.status}`
    try {
      const body = await resp.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* keep status */
    }
    throw new Error(`save rejected: ${detail}`)
  }
}

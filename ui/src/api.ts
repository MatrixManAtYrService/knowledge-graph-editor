import type { Op } from './ops'
import { capabilities, staticFetchGraph, staticFetchGraphs } from './static'
import type { GraphInfo, GraphPayload, Sel } from './types'

/** Publish the two-slot selection and current graph + view so agents can read
 * them (kge selection, kge find-collisions). Fire-and-forget: transient
 * state, last writer wins. Without the capability (a static export) there is
 * nobody to tell — the URL hash (share.ts) carries the selection instead. */
export function postSelection(
  primary: Sel | null,
  secondary: Sel | null,
  graph: string,
  view: string,
): void {
  if (!capabilities().selection) return
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

// Reads go through the data layer (static.ts) in every mode: the live
// server serves the same data/ URLs a static export has.
export const fetchGraphs = (): Promise<GraphInfo[]> => staticFetchGraphs()
export const fetchGraph = (graphId: string): Promise<GraphPayload> => staticFetchGraph(graphId)

export interface OpsResult {
  version: string
  moved: boolean // the graph had changed on the server since baseVersion
}

export async function postOps(graphId: string, ops: Op[], baseVersion: string): Promise<OpsResult> {
  if (!capabilities().write) throw readOnly()
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/ops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops, base_version: baseVersion || null }),
  })
  if (!resp.ok) throw await fail(resp, 'save rejected')
  return resp.json()
}

/** The graph files' current version (cheap: a stat, no export). */
export async function fetchVersion(graphId: string): Promise<string> {
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/version`)
  if (!resp.ok) throw await fail(resp, `GET version of ${graphId} failed`)
  return (await resp.json()).version
}

export async function deleteGraph(graphId: string): Promise<void> {
  if (!capabilities().write) throw readOnly()
  const resp = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, { method: 'DELETE' })
  if (!resp.ok) throw await fail(resp, 'delete graph rejected')
}

export async function createGraph(graphId: string): Promise<void> {
  if (!capabilities().write) throw readOnly()
  const resp = await fetch('/api/graphs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: graphId }),
  })
  if (!resp.ok) throw await fail(resp, 'new graph rejected')
}

# Design: one data path — DuckDB over parquet, everywhere

> Status: proposed (Oct 2026). To be implemented in stages, each shippable on
> its own, using the ebb graph (from skills-ebb-knowledge-graph) as the
> performance test case throughout.

## Summary

kge has two ways of getting graph data into the browser:

- **Live editor:** `GET /api/graphs/{id}` returns the whole graph as JSON; the
  browser holds all of it, edits it in memory, and **Save** `PUT`s all of it
  back ("clobber, never merge").
- **Read-only static site** (`kge export`, `kge serve --readonly`, GitHub
  Pages): the graph is exported to parquet, and the browser queries it
  through DuckDB-Wasm over HTTP range requests, loading only the sliver the
  current view shows.

The read-only path was added later, for big graphs and static hosting, but it
is the better-built of the two: windowed loading, point reads by key, one
query layer. This design makes it the **only** read path. The live server
keeps the parquet current and adds the write features on top. Static
hosting becomes "the same app with writes unavailable" instead of a second
workflow to debug.

DuckDB is the thin waist:

```
  writers                         source of truth           read path
  ───────                         ───────────────           ─────────
  browser edits ──┐                                    ┌── browser (DuckDB-Wasm)
  kge CLI edits ──┼──► ops ──► JSON files (git) ──► parquet cache ──┼── kge sql / reaches (DuckDB)
  ekg sync, git ──┘   (server)                         └── static site (same files)
  pull (direct JSON writes)
```

## Where things stand (Oct 2026)

Read these before changing anything:

| Piece | Where | Notes |
|---|---|---|
| Whole-graph API | `src/kge/server.py` | `GET/PUT /api/graphs/{id}`; `PUT` validates (`Graph.validate_semantics`) then `GraphStore.save` rewrites all files |
| File store | `src/kge/store.py` | `graph dir = schema.json, nodes.json, edges.json, views/*.json`; re-read on every request |
| Parquet export | `src/kge/export.py` | `export_data` writes `data/graphs.json`, `data/<id>/graph.json` (schema, views, counts, skewer subgraph) and `{nodes,edges,ids}.parquet`; module docstring explains the layout (sort, `key`, `adj`, lite data) |
| Live UI data | `ui/src/api.ts`, `ui/src/store.ts` | `refresh()` fetches the whole graph; `save()` PUTs it; `dirty` flag drives the Save `*` |
| Static UI data | `ui/src/static.ts`, `ui/src/duck.ts`, `ui/src/share.ts` | `STATIC_MODE` (from `window.KGE_STATIC`, injected by export) is the whole switch; `ensureViewLoaded` keeps *loaded ⊇ what the view shows*; `WINDOWED_LOAD_CAP = 4000` |
| DuckDB-Wasm | `ui/src/duck.ts` | loaded from `cdn.jsdelivr.net` at runtime |
| Read-only serving | `kge serve --readonly --dir` (`src/kge/cli.py`) | Starlette `StaticFiles`; range requests work |
| CLI | `src/kge/cli.py` | every edit is `_fetch` → mutate → `_push` (whole graph); `sql` builds DuckDB tables from the fetched JSON (live) or reads an export (`--dir`) |
| Traversal | `src/kge/traverse.py` | `reach` / `paths` over a loaded `Graph`; flow directions from `schema.json` edge types |
| Layout | `ui/src/GraphCanvas.tsx` `runLayout`, `ui/src/graph.ts` | 10 s budget (`LAYOUT_BUDGET_MS`); identical in both modes |

Known stale or odd bits found while writing this:

- `ui/src/duck.ts` says "the editor and inline-mode sites never import
  duckdb"; inline mode is gone (export.py: "Prune the shard files of the
  retired inline layout").
- In static mode, the ebb "Everything" view (2,720 nodes, 4,466 edges) reports
  "this view asks for more than 4000 nodes — showing the first 2720 of 2720".
  Probably a count against the wrong total; check while working in
  `static.ts`.

## Target design

### 1. JSON stays the source of truth; parquet is a cache the server owns

- The graph directory's JSON files remain what's committed to git: readable
  diffs, mergeable by hand, written by many tools (ekg's sync writes them
  directly via `GraphStore`).
- The server maintains each graph's parquet (the `export_data` layout) in a
  cache directory, for example `<graphs root>/.kge-cache/<id>/` (gitignored).
- **Freshness is checked lazily, on read:** before serving any `data/…` file,
  compare the cache's recorded source fingerprint (max mtime + size of the
  JSON files, or a content hash) to the current files; regenerate if stale.
  This covers every writer: browser ops, CLI, ekg sync, `git pull`, hand
  edits. Regeneration is cheap: ebb exports in 0.04 s to 276 KB.
- Each regeneration gets a **version token** (the fingerprint). `graph.json`
  carries it; a `GET /api/graphs/{id}/version` lets the browser notice
  outside changes cheaply (poll on focus or every few seconds).
- Concurrency: regeneration must be atomic. Write into a temp dir, then
  rename, so a reader never sees half a parquet set. Two requests racing to
  regenerate should not both write. A per-graph lock in the server is enough
  for kge itself; see "ekg" below for the cross-process case.

### 2. The browser always reads through DuckDB

- The live server serves the same `data/…` URLs the static site has, with
  range support. The UI's data layer becomes the static one
  (`static.ts`/`duck.ts`), always on. `STATIC_MODE` stops meaning "different
  data path" and starts meaning only "writes unavailable".
- Better: replace the `STATIC_MODE` boolean with **capabilities** fetched at
  startup (`{write: true, selection: true, …}` from the server; static sites
  get none), so each feature checks the one thing it needs.
- **Integer keys are unstable across edits** (export.py: "Integers are stable
  only until the graph is edited"). That was acceptable for published sites;
  in the live editor every save renumbers. After any regeneration the client
  must re-resolve what it has loaded **by id**, not by key: reload the
  view's sliver from the new files, and map selection/foci through ids.
  Share URLs in the live editor should use ids (or be rewritten after
  reload); integers stay fine for published static sites.
- DuckDB-Wasm must be **vendored into the package** (served by kge, copied
  into exports) instead of loaded from jsdelivr: the editor has to work
  offline and on networks that block CDNs (the corp VPN machine is
  nexus-only). Check the size it adds to the wheel and to `ui_dist`.

### 3. Writes become operations

The browser no longer holds the whole graph, so it can't `PUT` the whole
graph. Saves become operations applied by the server.

- `POST /api/graphs/{id}/ops` with an atomic batch, for example:
  ```json
  {"ops": [
    {"op": "upsert_node", "id": "handler:X", "type": "handler", "label": "", "data": {"note": "…"}},
    {"op": "merge_node_data", "id": "file:a/b.py", "data": {"summary": "…"}},
    {"op": "remove_node", "id": "…"},
    {"op": "upsert_edge", "type": "CALLS", "from": "…", "to": "…", "data": {…}},
    {"op": "remove_edge", "type": "CALLS", "from": "…", "to": "…"},
    {"op": "put_type", "kind": "edge", "name": "CALLS", "def": {"flow": "fwd", …}},
    {"op": "put_view", "view": {…}},
    {"op": "remove_view", "id": "…"}
  ], "base_version": "<token>"}
  ```
  The server loads the JSON, applies the batch, runs `validate_semantics`,
  writes, regenerates, and returns the new version token. All-or-nothing:
  one invalid op rejects the batch.
- **Conflicts:** an op touches only its own item, so concurrent writers to
  different items no longer clobber each other, which fixes the risk
  `kge onboarding` warns about today (a stale browser Save overwriting an
  agent's edits). Same-item conflicts are last-writer-wins. `base_version`
  is informational at first: return "the graph moved since you loaded it"
  so the UI can prompt a reload rather than reject.
- **No unsaved-edits buffer:** every edit is sent as an op immediately (with
  optimistic local apply; revert and show the error on rejection). View and
  layout changes (drags, spacing actions, filters) are batched and debounced
  into `put_view`. The Save button and the `dirty` flag go away, and so does
  the "Save before the agent edits / Refresh after" dance in onboarding.
- Skewer operations (membership and order) are expressed as the edge ops
  they already are (`skewer-order` edges with `data.index`), sent as one
  batch.
- The CLI's edit commands (`add-node`, `add-edge`, `rm-*`, `add-type`,
  `skewer`) switch to the ops endpoint. `dump`/`load` stay whole-graph for
  bulk work; keep `GET`/`PUT /api/graphs/{id}` for them and for older
  clients, but the UI stops using them.

### 4. The CLI reads the same files

- `kge sql` (live) queries the server's parquet cache with native DuckDB,
  the same tables as an export, instead of building tables from fetched
  JSON. The live/export column differences documented in `kge sql --help`
  disappear.
- `kge reaches` / `reached-by` / `path` can stay in Python over a fetched
  graph (`traverse.py`, which is correct and tested), or move to DuckDB
  recursive queries over the cache. Only move them if the ebb case shows the
  whole-graph fetch is the bottleneck.

### 5. ekg

ekg (skills-ebb-knowledge-graph) is both the test case and a real consumer:

- `ekg serve` mounts kge's app (`ekg/server/main.py`, `_mount_kge`), so it
  inherits everything here. Port 44311 serves ekg's routes, kge's `/api/*`
  and the UI.
- ekg writes graph JSON directly (`ekg/kgraph.py`: `regenerate`, curated edge
  helpers) under its own in-process `kgraph.LOCK`. Lazy freshness (section 1)
  means kge picks those writes up with no ekg change.
- **Cross-writer locking:** kge ops and ekg's regeneration can now both write
  the same JSON, in the same process for `ekg serve` and in different
  processes otherwise. Add a file lock on the graph directory (for example
  `fcntl.flock` on `<dir>/.lock`) inside `GraphStore`, taken for
  load-modify-save, and have ekg's `kgraph` use it, or expose a kge helper
  ekg calls. Without this, an op and a sync can interleave and lose one side.
- ekg's managed views (`ekg/kgraph.py` `_curated_view`: the `default` view's
  filters are rewritten on every regeneration) must keep working when the UI
  writes views via `put_view`. The UI may edit that view's layout; ekg
  rewrites only its filters.

## Stages

Each stage ends with ekg working and measured (see "Test case").

### Stage 1: reads go through parquet everywhere

- Server: parquet cache with lazy freshness and version tokens; serve
  `data/…` with range support in live mode; vendor DuckDB-Wasm.
- UI: the static data layer is the only read path; capabilities replace
  `STATIC_MODE`; reload-by-id after regeneration.
- Writes still use whole-graph `PUT` for now: the UI fetches the full graph
  only at Save time (or keeps a full copy just for editing). This is the
  stage's one wart, and it's what stage 2 removes.
- Done when: the live editor and a `kge export` site behave the same for
  reading, including refresh on a deep link (`#g=ebb&v=everything`), with no
  CDN request.

### Stage 2: writes become operations

- Server: `POST /api/graphs/{id}/ops`, the directory file lock, and the ekg
  integration (ekg's `kgraph` takes the same lock).
- UI: edits as immediate ops with optimistic apply; debounced `put_view`;
  remove Save/dirty; prompt reload when the version moves underneath.
- CLI: edit commands use ops.
- Done when: an agent's `kge add-edge` and a human dragging nodes in the UI
  at the same time both survive; ekg sync during a UI session loses nothing.

### Stage 3: cleanup

- UI stops calling whole-graph GET/PUT; `kge sql` live reads the cache;
  remove now-dead code (`api.ts` whole-graph paths, the dirty buffer).
- Rewrite `kge onboarding` and README around the single workflow: no
  Save/Refresh dance; "read-only" means "no write capability".

## Test case: ebb

The ebb graph is big enough to show scaling problems that small graphs hide.
In October 2026 it had 2,720 nodes and 4,466 edges: mostly regenerated
classes and functions (1,087 + 1,291), plus 454 curated edges.

- Get it: clone skills-ebb-knowledge-graph; the graph is `graphs/ebb/`. Work
  on a **copy** (`cp -r graphs/ebb /tmp/ebb-test/`) when experimenting, so
  the committed graph isn't rewritten by layout saves.
- Views: `default` ("Curated knowledge", 344 nodes / 489 edges, maintained by
  ekg) and `everything` (all 2,720 nodes).
- Serve it without ekg: `uv run kge serve --graph-dir /tmp/ebb-test/ebb`.
  Or with ekg (`ekg serve`, port 44311) to test the mounted case and the
  cross-writer locking.

### Baselines to beat or hold (measured Oct 2026, Apple Silicon laptop)

| Measurement | Value |
|---|---|
| `export_data` for ebb | 0.04 s, 276 KB of parquet |
| Live: `GET /api/graphs/ebb` | 60 ms, 1.4 MB JSON |
| Live: load to finished layout, curated view | 3.6–3.8 s |
| Live: layout of `everything` (budget hit) | ~12 s ("polishing cut short at 10s"); was ~180 s before the budget |
| Static: refresh straight into `#g=ebb&v=everything` | ~22 s to finished layout |
| Curated-view layout profile (3.5 s) | fcose 0.44 s; `compactEdges` 1.56 s; `resolveCollisions` 0.86 s; rest in `layoutPiece` scoring |

Targets for this work: stage 1 must not make the curated view slower than
~4 s. Refresh into `everything` should approach the live number (~12 s,
layout-bound), not regress past 22 s. A save round trip (op → regenerate
→ reload sliver) should be well under 1 s on ebb.

### How to measure

`scripts/ui_timing.py` loads a URL in a headless Chromium browser over the
DevTools protocol, waits for the status line to report a finished layout,
and prints elapsed time and node/edge counts. `--profile` adds a CPU profile
summary (build the UI unminified for readable names; see the script's
docstring).

```bash
uv run --with websockets python scripts/ui_timing.py http://localhost:8151/
uv run --with websockets python scripts/ui_timing.py 'http://localhost:8151/#g=ebb&v=everything' --profile
```

Run it against the ebb copy at the start of each stage (baseline) and after
each change. When a page freezes, the script reports how long the main thread
was unresponsive instead of hanging. With the Claude-in-Chrome extension, the
same page can be inspected live: the cytoscape instance is reachable as
`[...document.querySelectorAll('div')].find(d => d._cyreg)._cyreg.cy`.

## Open questions

- **Cache location:** inside the graphs root (simple; needs a gitignore
  entry in every consumer repo) or a per-user cache dir (no repo litter;
  harder to find)?
- **Version polling vs push:** polling `version` on window focus is simple
  and probably enough. Server-sent events would make agent edits appear
  live. Decide after stage 2.
- **`kge serve --site-dir`:** keeps a static copy current on save. With the
  cache it may reduce to "copy the cache plus UI into the site dir" or go
  away.
- **Do we still need `ids.parquet` and integer keys in the live editor,** or
  can the live path use ids throughout and keep integers only for published
  share URLs?
- **Small graphs:** DuckDB-Wasm startup is a fixed cost (~1 s?). Measure it
  on a tiny graph (grafana-workbench's dashboards) and decide whether it's
  acceptable or needs an inline fast path. The previous inline mode was
  retired in favor of "one code path beats two", which argues for accepting
  it.

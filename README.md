# knowledge-graph-editor (kge)

A knowledge graph that lives in your repo as plain JSON files. You explore
and edit it in a browser, and an agent can read and edit the same graph from
the command line while you work. Because it's just files, you diff it, review
it, and commit it like code.

It works well for things you're trying to understand piece by piece: how a
codebase fits together, how a website's pages and APIs connect, how an
incident unfolded. Your graph can come from a script, from an agent working
through a problem with you, or from both.

## Try it

The [demo repo](https://github.com/MatrixManAtYrService/knowledge-graph-editor-demo)
has two example graphs, the xz-utils backdoor and the first ascents of the
8000-meter peaks:

```bash
git clone https://github.com/MatrixManAtYrService/knowledge-graph-editor-demo
cd knowledge-graph-editor-demo
uv run kge serve        # then open http://localhost:8151
```

## Use it in your own project

Add kge as a dependency. A dev dependency is usually enough:

```toml
# pyproject.toml
[dependency-groups]
dev = ["kge"]

[tool.uv.sources]
kge = { git = "https://github.com/MatrixManAtYrService/knowledge-graph-editor" }
```

Then run `uv run kge serve` from the repo root. kge serves every graph under
`./graphs/<name>/`, or a single graph in `./graph/`, and creates an empty one
if it finds neither.

A common setup has some other tool in your project, such as a scraper or a
code analyzer, write `graphs/<name>/` directly. kge is there to view the
result, curate it, and query it. It notices when the files change, whoever
changed them, and an open browser picks up the change within a few seconds.

kge keeps derived data out of your repo, under `~/.cache/kge` (set
`KGE_CACHE_DIR` to move it): a parquet copy of each graph, which the browser
and `kge sql` read, and the DuckDB-Wasm binary the browser runs, which the
server downloads once from jsdelivr. On a network that can't reach jsdelivr,
set `KGE_DUCKDB_WASM_SOURCE` to a mirror, as a URL template with `{version}`
and `{name}`.

If that tool has its own CLI, it can carry kge's commands, so its users
never need a second CLI or `KGE_*` variables. `mount` registers the commands
you pick under your own groups, defaulting `--server` and `--graph` to yours,
and rewrites `kge <command>` in their help to your spelling:

```python
from kge.cli import mount

mount(query_app, ["ls", "show", "reaches", "reached-by", "sql", "views"],
      prog="mytool query", server=MY_SERVER_URL, graph="mygraph")
mount(graph_app, ["add-edge", "rm-edge", "add-view", "rm-view"],
      prog="mytool graph", server=MY_SERVER_URL, graph="mygraph")
```

## Working with an agent

Point your agent at:

```bash
uv run kge onboarding   # how the graph is stored and how to collaborate on it
uv run kge --help       # every subcommand has its own --help
```

The CLI can do everything the UI does: add and remove nodes, edges, and types,
save and list views, and dump or load the whole graph. To show you a subset,
an agent can save it as a view and hand you the link:
`kge add-view hot --sql "SELECT id FROM nodes WHERE ..."` prints a URL that
opens exactly those nodes. `kge selection` tells the
agent what you've clicked on, so you can ask about "this node" or "these two."

You and the agent can edit at the same time. There's no Save button: the
browser saves each edit a moment after you make it, and the agent's edits
show up in your browser on their own. Each edit touches only its own node,
edge, or view, so neither of you overwrites the other. The exception is
`kge load`, which replaces the whole graph.

## What's in a graph

```
graphs/<name>/
  schema.json     node and edge types: color, description, grouping
  nodes.json      {id, type, label, data}
  edges.json      {type, from, to, data}
  views/*.json    saved views
```

`data` holds any JSON you like. The files are sorted and pretty-printed so
their diffs are readable.

A few ideas will help you find your way around the UI:

- **Views** are saved perspectives on a graph. Each one remembers which
  types are shown, which nodes it's centered on (with a radius in hops),
  and where everything sits on screen.
- **Skewers** put nodes in a line, in order, like a timeline. A skewer is
  part of the graph (`kge skewer my-timeline A B C`). Each view decides where
  its rail is drawn. When several skewers share an ordering field such as a
  date, the UI can line their rails up and space them on a shared scale.
- **Color by field.** Setting `colorKey` in the schema colors nodes by a
  field in their data, such as author, component, or status, so the color
  isn't tied to node type.

## Sharing it

`kge export` writes a read-only static copy of your graphs that you can host
on GitHub Pages or any other static host. Visitors can browse, focus, and
filter, and the URL updates as they go, so they can send a link to exactly
what they're looking at. Data loads lazily, so even a very large graph opens
quickly. Run `kge serve --site-dir docs` to regenerate the export every time
the graph changes.

The graphs also work as a database, live or exported:

```bash
kge sql "SELECT type, count(*) FROM nodes GROUP BY 1"
kge sql --dir docs "SELECT id FROM nodes WHERE data->>'status' = 'open'"
```

## Developing kge

```bash
nix develop                     # uv, node, pnpm
uv run kge serve                # backend + built UI on :8151
cd ui && pnpm dev               # UI dev server on :5173, proxies /api, /data, /duckdb to :8151
nix flake check
```

The built UI is committed under `src/kge/ui_dist/` so that installing kge
from git doesn't need a node toolchain. After you change the UI, refresh it:

```bash
cd ui && pnpm build && rm -rf ../src/kge/ui_dist && cp -r dist ../src/kge/ui_dist
```

Browser checks, against any graph directory (they work on a temporary copy):

```bash
uv run --with websockets python scripts/ui_smoke.py graph            # correctness
uv run --with websockets python scripts/ui_timing.py http://localhost:8151/ --warm
```

`research-layout-persistence.md` has the background research behind the
layout design.

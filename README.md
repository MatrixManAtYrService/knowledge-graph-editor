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
result, curate it, and query it.

## Working with an agent

Point your agent at:

```bash
uv run kge onboarding   # how the graph is stored and how to collaborate on it
uv run kge --help       # every subcommand has its own --help
```

The CLI can do everything the UI does: add and remove nodes, edges, and types,
list saved views, and dump or load the whole graph. `kge selection` tells the
agent what you've clicked on, so you can ask about "this node" or "these two."

Edits are never merged. Saving in the browser overwrites the files, and each
CLI command writes straight through to them. When the agent makes a change,
click **Refresh**. If you have unsaved work (the Save button shows `*`), click
**Save** before the agent starts.

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
you save.

The export also works as a database:

```bash
kge sql "SELECT type, count(*) FROM nodes GROUP BY 1"
```

## Developing kge

```bash
nix develop                     # uv, node, pnpm
uv run kge serve                # backend + built UI on :8151
cd ui && pnpm dev               # UI dev server on :5173, proxies /api to :8151
nix flake check
```

The built UI is committed under `src/kge/ui_dist/` so that installing kge
from git doesn't need a node toolchain. After you change the UI, refresh it:

```bash
cd ui && pnpm build && rm -rf ../src/kge/ui_dist && cp -r dist ../src/kge/ui_dist
```

`research-layout-persistence.md` has the background research behind the
layout design.

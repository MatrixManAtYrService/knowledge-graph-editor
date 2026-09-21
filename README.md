# knowledge-graph-editor (kge)

Knowledge graphs collaboratively edited by humans (browser UI) and agents
(CLI). The source of truth is JSON files checked into this repo; a small
server loads them and serves whole graphs to both kinds of client. One
server can offer several graphs — the toolbar has a graph picker beside the
view picker, and the CLI takes `--graph`/`-g` (or `$KGE_GRAPH`).

## Use it from your own repo (no clone, no node, no nix)

kge is consumable as a git dependency: your repo holds only your graph data,
and the tool — server, CLI, *and* the browser UI, which is vendored into the
Python package as static files — comes from GitHub. In your repo:

```toml
# pyproject.toml
[project]
name = "my-graph"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["kge"]

[tool.uv.sources]
kge = { git = "https://github.com/MatrixManAtYrService/knowledge-graph-editor" }
```

```bash
uv run kge serve            # seeds ./graph if missing; UI at http://localhost:8151
```

The only prerequisites are uv and Python 3.12+. See the
[demo repo](https://github.com/MatrixManAtYrService/knowledge-graph-editor-demo)
for a working example.

## Developing kge itself

```bash
nix develop                 # provides uv, node, pnpm
uv run kge serve            # server + UI at http://localhost:8151
```

The UI is served from `ui/dist` (build it once with `cd ui && pnpm install &&
pnpm build`; `nix build .#ui` builds it hermetically). Agents point the CLI at
the server with `$KGE_SERVER_URL` or `--server` (default
`http://localhost:8151`) and should start with:

```bash
uv run kge onboarding       # the collaboration model, for agents
uv run kge --help           # every subcommand has its own --help
```

## The editing model: clobber, never merge

- The **browser** holds a full copy of the graph in memory. **Save** pushes it
  to the server, which rewrites the files under `graph/` (sorted,
  pretty-printed — diff them, commit them). **Refresh** replaces the browser
  copy with the server's. Nothing ever merges.
- The **CLI** is write-through: every edit command fetches the graph, applies
  the change, and puts it back immediately. It keeps no local state.
- So the working rhythm is: one side edits, the other refreshes to see it.
  After an agent edits, the human clicks Refresh; if the human has unsaved
  work (the Save button shows `*`), they Save before the agent works.
- The server is sessionless. Its only in-memory state is the shared
  *selection* (see below) — everything else is the files.

## Files

Each graph is one directory. `kge serve` with no options serves the
subdirectories of `./graphs` if that exists (one graph per subdir, the
subdir name is the graph id, rescanned per request so a new dir appears
without a restart), else the single `./graph` directory (seeding it if
missing). `--graph-dir` (repeatable) and `--graphs-dir` override; the first
explicit dir — else `graphs/default`, else the alphabetically first — is the
*default graph*, the one unqualified CLI commands and the pre-multigraph
`/api/graph` endpoint mean. `kge add-graph <id>` (or the **+** beside the
UI's graph picker) seeds a new empty graph under the root; `kge rm-graph`
(or the **−**) deletes one — root-scanned graphs only, never the last one,
and git history is the undo. Within a graph directory:

- `schema.json` — node/edge type vocabulary: display color,
  description, and `family` (the grouping level above type in the UI tree).
  Optionally `colorKey`, a node-data field that binds node color: nodes
  sharing a value of `data[colorKey]` share a color, overriding their type
  color (whatever the field means to your data — an author, a component, a
  status). `colorValues` pins colors for specific values; the rest get
  stable palette picks. The sidebar shows the resulting legend. The binding
  reaches rails too: a `skewer` node carrying the field tints its rail —
  arrowhead, grip, and bulb in the exact legend color, base whitened
  (pinned red still wins) — so a rail can visibly belong to its group.
- `nodes.json`, `edges.json` — the graph, sorted for stable
  diffs. Nodes: `{id, type, label, data}`. Edges: `{type, from, to, data}`
  (by convention `data.note` carries `file:line` evidence).
- `views/<id>.json` — one file per saved view (see Views). Views belong to
  their graph: switching graphs in the UI swaps the view picker's entries.

## Skewers

The layout primitive is the **skewer** — an ordered colinearity group, like
nodes on a shish-kebab spit:

- **In the graph** (shared knowledge): a `skewer` node plus `skewer-order`
  edges to its members, `data.index` giving the order. Agents create them
  like any other fact: `kge skewer skewer:flow A B C`.
- **In each view** (presentation): the segment the members sit on — two
  endpoints (encoding position, angle, length) and a `pinned` flag.

The UI never draws the raw skewer node. It renders a rail — a light→dark
chain ending in an arrowhead, the name in a bulb at the base — that threads
through its members *in order*, spacing them evenly along its straight
baseline. A node rides at most one skewer — rails sharing members made a
mess of the view, so adding a node to another skewer *moves* it (the UI's
⊕, the CLI, and save-time validation all enforce this).
Filtering compacts a rail instantly
while preserving its order. Three drags do three things: drag the **rail**
to move the whole skewer, drag an **end handle** to rotate or stretch the
baseline, and drag a **member** to slide it along the rail — hand-placement
that is baked like the spacing actions' output and clamped between its rail
neighbors, so the stored order stays true. Edges between members of one
skewer draw as arcs so they stay legible off the rail.

### Skewer bundles

A skewer may declare `data.orderKey` — the member-data field its order
reflects (a date, a version, any number: `kge skewer ... --order-key date`).
Skewers sharing a key form a **bundle** (set `data.group` to split unrelated
bundles that happen to share a key). The sidebar's **skewers** section lists
bundles and lets you enable/disable rails singly or as a bundle — disabled
rails release their members to float free, the nodes themselves stay — plus
three per-bundle, per-view options:

Below the rails sit two live constraints and a row of one-shot arrangement
actions — apply one, then drag things wherever you like; changing course
means applying a different action, not unchecking a box:

- **align** (checkbox, live) — the bundle's rails share a direction and
  their starts and ends stay colinear; dragging or stretching one rail
  moves them all, each keeping only its sideways lane offset.
- **group** (checkbox, live) — dragging any rail translates the whole
  bundle rigidly, each rail keeping its own position, angle, and length:
  the handle for repositioning a bundle without imposing alignment. Align
  and group are mutually exclusive drag policies — checking one unchecks
  the other. Pinned rails stay put in both modes.
- **make equidistant** — snap the rails onto evenly spaced lanes, keeping
  their order (a pinned rail anchors the grid).
- **rotate 90°** — turn the whole bundle a quarter turn about its center.
- **add padding** — stretch the rails just enough that neighboring dots and
  labels stay clear of each other at the current member spacing (measured
  from the actual label widths; under align the whole bundle takes the
  worst-case stretch so the ends stay colinear).
- **space evenly per skewer** — each rail spaces its own members evenly
  along itself (the default placement).
- **apply shared order** — members interleave across the bundle in one
  merged ordering, evenly spaced: order carries across rails, durations
  carry no weight. Works with any sortable value (strings included).
- **apply proportional order** — members sit at their key value on one
  scale shared by the whole bundle: durations are literal, a lull on one
  rail (while activity ran elsewhere) is a visible gap, and a floating axis
  labels the values at the ends and at round intervals between. Needs
  values that parse as numbers or dates.

The spacing actions bake per-member rail fractions into the view
(`layout.memberFracs`); dragging and filtering never recompute them —
re-apply an action (or "space evenly per skewer") to re-derive.

## Views

A view is a saved perspective on the same graph: pick one in the toolbar,
clone or drop one with the **+** / **−** beside the picker (like graphs, a
new view lives in your edit buffer until you Save). Node and edge creation
sit atop the sidebar's nodes and edges sections (**new node**, and
**connect**, which joins the secondary-selected node to the primary); each
tree row carries micro-actions — a pushpin to pin/unpin nodes and skewers
in place, **⊖** to delete the item from the graph, **⊘** to take a node off
its skewers, and **⊕** on a skewer row to append the selected node. Each
view stores:

- **Inclusion** — the family → type → item tree in the sidebar. Checkboxes
  at every level; checking/unchecking a parent clobbers the overrides
  beneath it. This defines which data the view considers at all.
- **Focus** — optional center nodes, each with a `focus-hops` radius; their
  neighborhoods union. Click behavior picks what a node click does beyond
  selecting: **refocus** makes the clicked node the only focus (a
  "selection-walk": neighborhoods fade in/out and the viewport glides, and
  eye adjustments reset); **add/remove focus** toggles — clicking a node
  adds it as another center at the current `focus-hops`, clicking an
  existing center (red crosshairs) removes that focus along with any
  eye-summons within its reach, and nothing else is clobbered; **view/edit**
  clicks around without touching the foci. The `focus-hops` box sets the
  radius the next refocus/add uses — existing foci keep theirs. **Clear
  focus** / **Restore focus** toggle the whole set.
- **Eye adjustments** — the eye icons in the tree show what's actually on
  canvas and are clickable: summon items the focus banished, or banish shown
  ones, per item / type / family. Distinct from inclusion; cleared by the
  next focus recenter. Peripheral nodes dim — the *frontier* of what's
  shown, not a fixed band: summoning a distant node makes it the new dimmed
  edge and undims the path to it; cycles through the center never dim.
- **Layout** — node positions, skewer segments, pins.

The sidebar legend identifies the markers: solid blue ring = primary
selection, dotted grey ring = secondary, red crosshairs = focus center.

## Layout

**Random layout** runs three trials — fcose over a quotient graph in which
each skewer is one long thin rigid node (and each **aligned bundle** is one
rigid block), from three random starts — then
de-collides each result (edges swing around obstacles by angle, nodes and
rails separate, incident edges spread to share the full circle, over-long
edges contract while the score tolerates it), scores them (collisions, then
crossings), and shows the best. Click again to re-roll; pin what you like
and re-roll the rest. Pinned nodes and skewers never move.

Inside an aligned bundle the layout is lane-aware: rails sit equidistant,
and their order is searched (a few shuffles per trial, scored by how many
rails the bundle's own edges cross without terminating there), so heavily
connected rails become neighbors. Free nodes that connect into the bundle
are tried at every gap — outside the first rail, between each pair, outside
the last — and take the gap whose edges cross the fewest rails, interleaving
between the rails they connect (least-bad wins when zero crossings is
impossible). Nodes with no edge into the bundle are kept out of the band
entirely. A pinned rail anchors the whole grid.

## Selection is shared

Every click publishes the two-slot selection (primary = latest click,
secondary = the one before) and the current graph + view to the server. Agents read
it with `kge selection` — "what is the human looking at" — and can answer
questions about *this* node or *these two*. `kge find-collisions` reports
what the selection spatially overlaps without being logically connected to;
`kge views <id>` resolves a saved view to exactly what it shows.

## Development

```bash
nix develop
uv run kge serve                 # backend + built UI
cd ui && pnpm dev                # UI dev server on :5173, /api proxied to :8151
nix build .#ui                   # hermetic UI build (native nixpkgs pnpm)
nix flake check                  # build check
```

After changing the UI, regenerate the vendored copy that git-dependency
consumers receive (`src/kge/ui_dist/` is committed on purpose — pip/uv build
the wheel straight from the git checkout, where no node toolchain exists):

```bash
cd ui && pnpm build && rm -rf ../src/kge/ui_dist && cp -r dist ../src/kge/ui_dist
```

See `research-layout-persistence.md` for the prior-art survey behind the
layout-persistence design.

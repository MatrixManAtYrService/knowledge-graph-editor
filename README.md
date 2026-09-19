# knowledge-graph-editor (kge)

A knowledge graph collaboratively edited by humans (browser UI) and agents
(CLI). The source of truth is JSON files checked into this repo; a small
server loads them and serves the whole graph to both kinds of client.

## Quick start

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

- `graph/schema.json` — node/edge type vocabulary: display color,
  description, and `family` (the grouping level above type in the UI tree).
- `graph/nodes.json`, `graph/edges.json` — the graph, sorted for stable
  diffs. Nodes: `{id, type, label, data}`. Edges: `{type, from, to, data}`
  (by convention `data.note` carries `file:line` evidence).
- `graph/views/<id>.json` — one file per saved view (see Views).

## Skewers

The layout primitive is the **skewer** — an ordered colinearity group, like
nodes on a shish-kebab spit:

- **In the graph** (shared knowledge): a `skewer` node plus `skewer-order`
  edges to its members, `data.index` giving the order. Agents create them
  like any other fact: `kge skewer skewer:flow A B C`.
- **In each view** (presentation): the segment the members sit on — two
  endpoints (encoding position, angle, length) and a `pinned` flag.

The UI never draws the raw skewer node. It renders a rail — gradient plus an
arrowhead showing direction, the name in a bulb at the base — and spaces the
*visible* members evenly along it, so filtering compacts a skewer instantly
while preserving its order and angle. Drag a member to move the whole
skewer; drag an end handle to rotate or stretch it. Edges between members of
one skewer draw as arcs so they stay legible off the rail.

## Views

A view is a saved perspective on the same graph: pick one in the toolbar,
clone with **New view**, drop with **Delete view**. Each view stores:

- **Inclusion** — the family → type → item tree in the sidebar. Checkboxes
  at every level; checking/unchecking a parent clobbers the overrides
  beneath it. This defines which data the view considers at all.
- **Focus** — an optional center node + `focus-hops` radius. With **click
  behavior: refocus**, every node click recenters the focus (a
  "selection-walk": neighborhoods fade in/out and the viewport glides).
  Switch to **view/edit** to click around without moving the focus — the
  red crosshairs stay put. **Clear focus** / **Restore focus** toggle.
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
each skewer is one long thin rigid node, from three random starts — then
de-collides each result (edges swing around obstacles by angle, nodes and
rails separate, incident edges spread to share the full circle, over-long
edges contract while the score tolerates it), scores them (collisions, then
crossings), and shows the best. Click again to re-roll; pin what you like
and re-roll the rest. Pinned nodes and skewers never move.

## Selection is shared

Every click publishes the two-slot selection (primary = latest click,
secondary = the one before) and the current view to the server. Agents read
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

See `research-layout-persistence.md` for the prior-art survey behind the
layout-persistence design.

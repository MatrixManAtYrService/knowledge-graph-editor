"""The kge CLI: a thin, stateless HTTP client for agents.

Every edit command is write-through: GET the whole graph, mutate it in
memory, PUT it back. The browser is the only client with an edit buffer
(its Save/Refresh); the CLI has no local state at all. For batch edits,
`kge dump` / `kge load` round-trip the whole payload through a file.

Server resolution: --server > $KGE_SERVER_URL > http://localhost:8151.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Annotated

import httpx
import typer
from rich.console import Console

from kge.models import Edge, Graph, Node, TypeDef

console = Console()
app = typer.Typer(
    help=(
        "kge — a knowledge graph collaboratively edited by humans (browser UI) "
        "and agents (this CLI), stored as JSON files in git.\n\n"
        "Agents: run `kge onboarding` first — it explains the collaboration "
        "model (save/refresh, what lives in memory vs. files) and how to guide "
        "your human. Every subcommand has its own --help."
    )
)

DEFAULT_SERVER = os.environ.get("KGE_SERVER_URL", "http://localhost:8151")
DEFAULT_GRAPH = os.environ.get("KGE_GRAPH", "")
ServerOpt = Annotated[str, typer.Option("--server", "-s", help="kge server URL")]
GraphOpt = Annotated[
    str,
    typer.Option(
        "--graph",
        "-g",
        help="Which graph, when the server offers several (kge graphs lists them; "
        "$KGE_GRAPH sets the default; unset = the server's default graph)",
    ),
]
DataOpt = Annotated[str, typer.Option("--data", help="Extra properties as a JSON object")]


def _fail(msg: str) -> typer.Exit:
    console.print(f"[red]{msg}[/red]")
    return typer.Exit(1)


def _graph_url(server: str, graph: str) -> str:
    return f"{server}/api/graphs/{graph}" if graph else f"{server}/api/graph"


def _fetch(server: str, graph: str = "") -> Graph:
    try:
        resp = httpx.get(_graph_url(server, graph), timeout=30.0)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.json().get("detail", exc.response.text)
        raise _fail(f"server refused: {detail}")
    except httpx.HTTPError as exc:
        raise _fail(f"can't reach the kge server at {server}: {exc}")
    return Graph.model_validate(resp.json())


def _push(server: str, graph_id: str, graph: Graph) -> dict:
    resp = httpx.put(
        _graph_url(server, graph_id),
        json=graph.model_dump(by_alias=True, mode="json"),
        timeout=60.0,
    )
    if resp.status_code >= 400:
        ct = resp.headers.get("content-type", "")
        detail = resp.json().get("detail", resp.text) if ct.startswith("application/json") else resp.text
        raise _fail(f"server rejected the save: {detail}")
    return resp.json()


def _parse_data(data: str) -> dict:
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as exc:
        raise _fail(f"--data is not valid JSON: {exc}")
    if not isinstance(parsed, dict):
        raise _fail("--data must be a JSON object")
    return parsed


# -- serve --------------------------------------------------------------------


def _packaged_ui() -> Path | None:
    """The UI vendored inside this package (built ui/dist, committed), so
    consumers installing kge as a git/pypi dependency get the browser UI
    with no node toolchain."""
    from importlib.resources import files

    try:
        candidate = Path(str(files("kge") / "ui_dist"))
    except Exception:
        return None
    return candidate if (candidate / "index.html").is_file() else None


@app.command()
def serve(
    graph_dir: Annotated[
        list[Path] | None,
        typer.Option(
            "--graph-dir",
            help="A graph directory to serve (repeatable; the graph's id is the "
            "dir's basename; the first one is the default graph)",
        ),
    ] = None,
    graphs_dir: Annotated[
        Path | None,
        typer.Option(
            "--graphs-dir",
            help="A root whose subdirectories are graphs (rescanned per request, "
            "so new graph dirs appear without a restart)",
        ),
    ] = None,
    ui_dir: Annotated[
        Path | None,
        typer.Option("--ui-dir", help="Built UI to serve at / (default: ./ui/dist, else the UI vendored in the package)"),
    ] = None,
    site_dir: Annotated[
        Path | None,
        typer.Option(
            "--site-dir",
            help="Also maintain a static read-only site here ($KGE_SITE_DIR): "
            "regenerated on every save, ready for GitHub Pages",
        ),
    ] = None,
    port: Annotated[int, typer.Option("--port", help="Server port")] = 8151,
) -> None:
    """Run the kge server over one or more graph directories.

    With no options: serves the subdirectories of ./graphs if that exists,
    else ./graph (seeding an empty-but-valid graph there if missing, so a
    fresh consumer repo can start with just `kge serve`).
    """
    import uvicorn

    from kge.server import create_app
    from kge.store import GraphRegistry, GraphStore

    if graph_dir is None and graphs_dir is None:
        if Path("graphs").is_dir():
            graphs_dir = Path("graphs")
        else:
            graph_dir = [Path("graph")]
    registry = GraphRegistry(dirs=graph_dir, root=graphs_dir)
    for d in registry.dirs:
        GraphStore(d).ensure()
    if not registry.stores():
        # An empty graphs root seeds one graph, like an absent ./graph does.
        GraphStore(registry.root / "default").ensure()
    stores = registry.stores()
    if ui_dir is None:
        local = Path("ui") / "dist"
        ui_dir = local if (local / "index.html").is_file() else _packaged_ui()
    if site_dir is None and os.environ.get("KGE_SITE_DIR"):
        site_dir = Path(os.environ["KGE_SITE_DIR"])
    for gid, store in stores.items():
        mark = "  (default)" if gid == registry.default_id() else ""
        console.print(f"graph {gid}: {store.dir}{mark}")
    console.print(f"ui: {ui_dir.resolve() if ui_dir else '(none found — API only)'}")
    if site_dir is not None:
        from kge.export import export_site

        summary = export_site(registry, site_dir, ui_dir)
        console.print(f"static site: {site_dir.resolve()} ({summary['graphs']} graph(s), re-exported on save)")
    console.print(f"open http://localhost:{port}")
    uvicorn.run(
        create_app(registry, ui_dir, site_dir=site_dir),
        host="0.0.0.0",
        port=port,
        log_level="warning",
    )


@app.command()
def export(
    graph_dir: Annotated[
        list[Path] | None,
        typer.Option("--graph-dir", help="A graph directory to export (repeatable)"),
    ] = None,
    graphs_dir: Annotated[
        Path | None,
        typer.Option("--graphs-dir", help="A root whose subdirectories are graphs"),
    ] = None,
    ui_dir: Annotated[
        Path | None,
        typer.Option("--ui-dir", help="Built UI to bundle (default: ./ui/dist, else the UI vendored in the package)"),
    ] = None,
    out: Annotated[Path, typer.Option("--out", "-o", help="Site output directory")] = Path("site"),
    inline_threshold: Annotated[
        int | None,
        typer.Option(
            "--inline-threshold",
            help="Graphs with at most this many nodes ship as inline JSON (one "
            "fetch, no wasm); bigger ones become DuckDB-Wasm-queried parquet "
            "so viewers download only the sliver a view shows "
            "($KGE_INLINE_THRESHOLD; default 500; 0 = always parquet)",
        ),
    ] = None,
) -> None:
    """Write a static, read-only copy of the graphs — host it anywhere.

    Reads the graph files directly (no server needed). The output is the
    same browser UI in read-only mode: no saving, but focus, selection, and
    show/hide still work, and the state a visitor navigates to lives in the
    URL fragment — share the link, share the view. Data loads lazily: small
    graphs are one JSON fetch plus detail shards on inspect; large graphs
    are parquet files queried in the browser via DuckDB-Wasm over HTTP range
    requests, so even a huge graph costs a viewer only the focused sliver
    their view shows.

    Graph dir resolution matches `kge serve`: --graph-dir/--graphs-dir, else
    ./graphs, else ./graph.
    """
    from kge.export import export_site
    from kge.store import GraphRegistry

    if graph_dir is None and graphs_dir is None:
        if Path("graphs").is_dir():
            graphs_dir = Path("graphs")
        elif Path("graph").is_dir():
            graph_dir = [Path("graph")]
        else:
            raise _fail("no ./graphs or ./graph here — pass --graphs-dir or --graph-dir")
    registry = GraphRegistry(dirs=graph_dir, root=graphs_dir)
    if not registry.stores():
        raise _fail("no graphs found to export")
    if ui_dir is None:
        local = Path("ui") / "dist"
        ui_dir = local if (local / "index.html").is_file() else _packaged_ui()
    if ui_dir is None:
        raise _fail("no built UI found (build ui/dist or install kge from a wheel/git)")
    summary = export_site(registry, out, ui_dir, inline_threshold)
    console.print(f"exported {summary['graphs']} graph(s) to {out.resolve()}")
    console.print("[dim]serve it with any static host — e.g. GitHub Pages, or: python -m http.server[/dim]")


@app.command()
def onboarding() -> None:
    """How this tool works and how to collaborate with a human through it.

    Read this first: it explains the editing model (whole-state save/refresh,
    never merge), which state lives where, and what to tell your human user.
    """
    console.print("""\
[bold]kge — the knowledge graph editor[/bold]

Knowledge graphs, two kinds of editors: humans use a browser UI, agents use
this CLI. Both talk to the same small server. The source of truth is JSON
files checked into git — the database is just what's in those files.

One server can offer SEVERAL graphs (`kge graphs` lists them; the browser
has a matching picker). Every other command takes --graph/-g (or $KGE_GRAPH)
to say which one; unset means the server's default graph. `kge selection`
reports which graph the human is looking at — check it before editing so
you're both on the same one. `kge add-graph <id>` seeds a new empty graph.

[bold]Where state lives[/bold] (one directory per graph — graphs/<id>/ when the
repo serves several, graph/ when it serves one)

  <dir>/schema.json        node/edge type vocabulary (colors, families)
  <dir>/nodes.json         the nodes            } the knowledge —
  <dir>/edges.json         the edges            } committed to git
  <dir>/views/<id>.json    named views: type filters, per-item overrides,
                           focus + eye adjustments, layout (positions and
                           skewer segments) — views belong to their graph
  server memory only       the human's current selection + graph + view
                           (transient, last-writer-wins; `kge selection`)
  browser memory only      the human's UNSAVED edit buffer
  this CLI                 nothing — every command is stateless

[bold]The editing model — clobber, never merge[/bold]

  - The browser holds a full copy of the graph in memory. [bold]Save[/bold] pushes it
    to the server (rewriting ALL the files); [bold]Refresh[/bold] replaces the browser
    copy with the server's. There is no merging in either direction.
  - This CLI is write-through: every edit command does GET -> mutate -> PUT
    immediately. Your edits land in the files at once.
  - Therefore: [bold]after you edit, tell the human to click Refresh[/bold] — until they
    do, their browser shows stale data, and if they click Save first their
    stale copy will overwrite your edits. Conversely, [bold]before you read or
    edit, ask whether they have unsaved changes[/bold] (the Save button shows a *)
    and have them Save first.

[bold]Getting the human started[/bold]

  - They run, from the repo root:  [bold]uv run kge serve[/bold]
    (in a nix develop shell; add --port to change the default [bold]8151[/bold]).
  - The UI is then at  http://localhost:8151
  - This CLI finds the server via --server, or $KGE_SERVER_URL, defaulting
    to http://localhost:8151. `kge status` confirms you're connected and
    shows which graph directory the server is serving.

[bold]The vocabulary[/bold]

  - Nodes and edges are typed; the schema defines types (with a display
    color and a 'family' grouping). `kge types` lists them; `kge add-type`
    extends them. Edge/node `data` is a free-form JSON object (by
    convention, `data.note` holds file:line evidence for an edge).
  - [bold]Skewers[/bold] are ordered colinearity groups stored IN the graph: a `skewer`
    node plus `skewer-order` edges (data.index gives the order). The UI
    draws them as a rail the members sit on. Create with `kge skewer`.
    Where a skewer sits on screen is per-view, not graph data.
    Declaring `--order-key <field>` (the member-data field the order
    reflects, e.g. a date) bundles skewers so the UI can align their rails
    (shared direction, colinear ends), drag them around as one rigid group,
    snap them into equidistant lanes, and space members on one shared
    scale — by merged rank or by value with a labeled axis; `--group
    <name>` splits bundles that share a key.
  - [bold]Views[/bold] are saved perspectives: which types/items are included, an
    optional k-hop foci (several may coexist; their neighborhoods union)
    with manual show/hide adjustments, and all layout
    geometry. `kge views` lists them; `kge views <id>` resolves one to
    exactly what it displays.

[bold]Working with the human's attention[/bold]

  - `kge selection` shows their primary + secondary selection (last two
    clicks) and current view — "what are they looking at" for questions
    about 'this' or 'these two'.
  - `kge find-collisions` reports what a selected object spatially overlaps
    without being logically connected to (uses the view's saved geometry —
    ask them to Save first if they've been dragging).

[bold]Reading and editing[/bold]

  read:  status · graphs · ls · show · types · views · selection ·
         find-collisions · dump
  edit:  add-graph · add-node · rm-node · add-edge · rm-edge · add-type ·
         skewer · load

  `kge dump > g.json`, edit, `kge load g.json` for bulk changes (whole-state
  replace). After any edit: remind the human to Refresh. The files under
  graph/ are ordinary git files — commit them like code.\
""")


# -- read commands ------------------------------------------------------------


@app.command()
def status(graph: GraphOpt = DEFAULT_GRAPH, server: ServerOpt = DEFAULT_SERVER) -> None:
    """Graph counts and server identity."""
    g = _fetch(server, graph)
    ver = httpx.get(f"{server}/api/version", timeout=10.0).json()
    gid = graph or ver.get("default_graph", "")
    gdir = ver.get("graph_dirs", {}).get(gid, "")
    console.print(f"server: {server}  graph: {gid}  dir: {gdir}  rev: {ver.get('rev', '')[:12]}")
    console.print(
        f"nodes: {len(g.nodes)}  edges: {len(g.edges)}  views: {len(g.views)}  "
        f"node types: {len(g.graph_schema.nodeTypes)}  edge types: {len(g.graph_schema.edgeTypes)}"
    )
    others = [k for k in ver.get("graph_dirs", {}) if k != gid]
    if others:
        console.print(f"[dim]other graphs on this server: {', '.join(others)} (use --graph)[/dim]")


@app.command()
def graphs(server: ServerOpt = DEFAULT_SERVER) -> None:
    """List the graphs this server offers."""
    try:
        resp = httpx.get(f"{server}/api/graphs", timeout=30.0)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise _fail(f"can't reach the kge server at {server}: {exc}")
    for g in resp.json().get("graphs", []):
        mark = "  [dim](default)[/dim]" if g.get("default") else ""
        console.print(
            f"{g['id']}  [dim]{g['nodes']} nodes / {g['edges']} edges / {g['views']} view(s)[/dim]{mark}"
        )


@app.command("add-graph")
def add_graph(
    graph_id: Annotated[str, typer.Argument(help="Id for the new graph (becomes its directory name)")],
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Seed a new empty graph on the server (needs a graphs root: serve --graphs-dir)."""
    resp = httpx.post(f"{server}/api/graphs", json={"id": graph_id}, timeout=30.0)
    if resp.status_code >= 400:
        raise _fail(f"server refused: {resp.json().get('detail', resp.text)}")
    console.print(f"created graph {graph_id}")


@app.command("rm-graph")
def rm_graph(
    graph_id: Annotated[str, typer.Argument(help="Graph to delete (its directory is removed)")],
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Delete a graph and its files from the server. Git history is the undo."""
    resp = httpx.delete(f"{server}/api/graphs/{graph_id}", timeout=30.0)
    if resp.status_code >= 400:
        raise _fail(f"server refused: {resp.json().get('detail', resp.text)}")
    console.print(f"deleted graph {graph_id}")


@app.command()
def ls(
    type: Annotated[str | None, typer.Option("--type", "-t", help="Filter by node type")] = None,
    grep: Annotated[str | None, typer.Option("--grep", help="Regex over id/label")] = None,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """List nodes."""
    import re

    g = _fetch(server, graph)
    pattern = re.compile(grep, re.IGNORECASE) if grep else None
    for n in sorted(g.nodes, key=lambda n: n.id):
        if type and n.type != type:
            continue
        if pattern and not (pattern.search(n.id) or pattern.search(n.label)):
            continue
        label = f"  {n.label}" if n.label and n.label != n.id else ""
        console.print(f"{n.id}  [dim]({n.type}){label}[/dim]")


@app.command()
def show(
    node_id: Annotated[str, typer.Argument(help="Node id")],
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """One node with its edges."""
    g = _fetch(server, graph)
    node = next((n for n in g.nodes if n.id == node_id), None)
    if node is None:
        raise _fail(f"no such node: {node_id}")
    console.print_json(data=node.model_dump())
    for e in g.edges:
        if e.src == node_id:
            console.print(f"  -[{e.type}]-> {e.dst}  [dim]{e.data.get('note', '')}[/dim]")
        if e.dst == node_id:
            console.print(f"  <-[{e.type}]- {e.src}  [dim]{e.data.get('note', '')}[/dim]")


@app.command()
def selection(server: ServerOpt = DEFAULT_SERVER) -> None:
    """What the human has selected in the browser (primary + secondary), resolved.

    Primary is their latest click; secondary trails it — so 'the pair' is
    usually what a question is about. Transient server state, not in the files.
    """
    try:
        sel = httpx.get(f"{server}/api/selection", timeout=10.0).json()
    except httpx.HTTPError as exc:
        raise _fail(f"can't reach the kge server at {server}: {exc}")
    g = _fetch(server, sel.get("graph") or "")
    if sel.get("graph"):
        console.print(f"[dim]graph: {sel['graph']}[/dim]")

    def show_slot(slot: str) -> None:
        s = sel.get(slot)
        if not s:
            console.print(f"[bold]{slot}[/bold]: [dim]none[/dim]")
            return
        console.print(f"[bold]{slot}[/bold]: {s['kind']} {s['id']}")
        if s["kind"] in ("node", "skewer"):
            node = next((n for n in g.nodes if n.id == s["id"]), None)
            if node is None:
                console.print("  [dim](no longer in the graph)[/dim]")
                return
            console.print_json(data=node.model_dump())
            if s["kind"] == "skewer":
                members = sorted(
                    (e for e in g.edges if e.type == "skewer-order" and e.src == s["id"]),
                    key=lambda e: e.data.get("index", 0),
                )
                for m in members:
                    console.print(f"  {m.data.get('index', '?')}: {m.dst}")
        else:
            parts = s["id"].split("|")
            if len(parts) == 3:
                etype, src, dst = parts
                edge = next((e for e in g.edges if e.key == (etype, src, dst)), None)
                if edge is None:
                    console.print("  [dim](no longer in the graph)[/dim]")
                    return
                console.print_json(data=edge.model_dump(by_alias=True))

    show_slot("primary")
    show_slot("secondary")


@app.command()
def views(
    view_id: Annotated[str | None, typer.Argument(help="View id (omit to list all views)")] = None,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """List the saved views of a graph, or resolve one to exactly what it shows.

    With an ID: the view's type filters, include overrides, focus and eye
    adjustments, pinned nodes, skewer segments, and the resolved lists of
    shown nodes and edges.
    """
    from kge import geometry

    g = _fetch(server, graph)
    if view_id is None:
        for v in g.views:
            nodes, edges = geometry.visible_sets(g, v)
            focus = (
                "  foci: " + ", ".join(f"{f.node} ({f.kHops} hops)" for f in v.foci)
                if v.foci
                else ""
            )
            console.print(
                f"{v.id}  [dim]{v.name}[/dim]  showing {len(nodes)} nodes / {len(edges)} edges{focus}"
            )
        return

    v = next((x for x in g.views if x.id == view_id), None)
    if v is None:
        raise _fail(f"no such view: {view_id} (available: {', '.join(x.id for x in g.views)})")

    nodes, edges = geometry.visible_sets(g, v)
    console.print(f"[bold]{v.id}[/bold]  {v.name}")
    console.print(
        f"  node types: {'all' if v.visibleNodeTypes is None else ', '.join(v.visibleNodeTypes) or '(none)'}"
    )
    console.print(
        f"  edge types: {'all' if v.visibleEdgeTypes is None else ', '.join(v.visibleEdgeTypes) or '(none)'}"
    )
    for label, items in (
        ("include overrides (nodes)", v.nodeOverrides),
        ("include overrides (edges)", v.edgeOverrides),
        ("eye: summoned", v.focusShow),
        ("eye: banished", v.focusHide),
    ):
        if items:
            console.print(f"  {label}: {', '.join(items)}")
    for f in v.foci:
        console.print(f"  focus: {f.node} ({f.kHops} hops)")
    if v.layout.pinned:
        console.print(f"  pinned nodes: {', '.join(v.layout.pinned)}")
    for sid, geom in v.layout.skewers.items():
        pin = " [pinned]" if geom.pinned else ""
        console.print(
            f"  skewer {sid}: ({geom.a.x:.0f},{geom.a.y:.0f}) → ({geom.b.x:.0f},{geom.b.y:.0f}){pin}"
        )

    console.print(f"[bold]showing[/bold] {len(nodes)} node(s):")
    for n in sorted(nodes):
        console.print(f"  {n}")
    console.print(f"[bold]showing[/bold] {len(edges)} edge(s):")
    for e in sorted(edges, key=lambda e: (e.src, e.type, e.dst)):
        console.print(f"  {e.src} -[{e.type}]-> {e.dst}")
    hidden = [n.id for n in g.nodes if n.type != "skewer" and n.id not in nodes]
    if hidden:
        console.print(f"[dim]not shown: {len(hidden)} node(s): {', '.join(sorted(hidden))}[/dim]")


@app.command("find-collisions")
def find_collisions(
    of: Annotated[
        str | None,
        typer.Option("--of", help="Node id, skewer id, or edge key type|from|to (default: the primary selection)"),
    ] = None,
    view_id: Annotated[
        str | None,
        typer.Option("--view", help="View whose geometry to use (default: the browser's current view)"),
    ] = None,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Spatial overlaps of the target with objects it isn't connected to.

    Geometry comes from the view's last *saved* state — if the browser has
    unsaved drags, Save there first. Edges are treated as straight segments
    (the UI draws same-skewer edges as arcs), so edge results are approximate.
    """
    from kge import geometry

    try:
        sel = httpx.get(f"{server}/api/selection", timeout=10.0).json()
    except httpx.HTTPError as exc:
        raise _fail(f"can't reach the kge server at {server}: {exc}")
    g = _fetch(server, graph or sel.get("graph") or "")

    if of:
        obj_id = of
        if "|" in of:
            kind = "edge"
        else:
            node = next((n for n in g.nodes if n.id == of), None)
            if node is None:
                raise _fail(f"no such node: {of}")
            kind = "skewer" if node.type == "skewer" else "node"
    else:
        s = sel.get("primary")
        if not s:
            raise _fail("nothing selected in the browser — pass --of")
        kind, obj_id = s["kind"], s["id"]

    vid = view_id or sel.get("view") or "default"
    view = next((v for v in g.views if v.id == vid), None)
    if view is None:
        raise _fail(f"no such view: {vid} (available: {', '.join(v.id for v in g.views)})")

    try:
        collisions, warnings = geometry.find_collisions(g, view, kind, obj_id)
    except ValueError as exc:
        raise _fail(str(exc))

    console.print(f"collisions for {kind} {obj_id} [dim](view: {vid}, saved state)[/dim]")
    for w in warnings:
        console.print(f"  [yellow]note: {w}[/yellow]")
    if not collisions:
        console.print("  [green]none[/green]")
        return
    for c in collisions:
        approx = "  [dim](approx)[/dim]" if c.get("approx") else ""
        console.print(f"  {c['kind']}  {c['id']}  [dim]overlap {c['overlap']}px[/dim]{approx}")


@app.command()
def types(graph: GraphOpt = DEFAULT_GRAPH, server: ServerOpt = DEFAULT_SERVER) -> None:
    """The schema: node and edge types."""
    g = _fetch(server, graph)
    counts: dict[str, int] = {}
    for n in g.nodes:
        counts[n.type] = counts.get(n.type, 0) + 1
    console.print("[bold]node types[/bold]")
    for name, td in sorted(g.graph_schema.nodeTypes.items()):
        console.print(f"  {name} ({counts.get(name, 0)})  [dim]{td.description}[/dim]")
    ecounts: dict[str, int] = {}
    for e in g.edges:
        ecounts[e.type] = ecounts.get(e.type, 0) + 1
    console.print("[bold]edge types[/bold]")
    for name, td in sorted(g.graph_schema.edgeTypes.items()):
        console.print(f"  {name} ({ecounts.get(name, 0)})  [dim]{td.description}[/dim]")


# -- write-through edit commands ----------------------------------------------


@app.command("add-node")
def add_node(
    type: Annotated[str, typer.Argument(help="Node type (must exist in the schema)")],
    node_id: Annotated[str, typer.Argument(help="Node id")],
    label: Annotated[str, typer.Option("--label", "-l")] = "",
    data: DataOpt = "{}",
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Add (or update, if the id exists) a node."""
    g = _fetch(server, graph)
    props = _parse_data(data)
    existing = next((n for n in g.nodes if n.id == node_id), None)
    if existing:
        existing.type = type
        if label:
            existing.label = label
        existing.data.update(props)
        verb = "updated"
    else:
        g.nodes.append(Node(id=node_id, type=type, label=label, data=props))
        verb = "added"
    _push(server, graph, g)
    console.print(f"{verb} {node_id} [dim]({type})[/dim]")


@app.command("rm-node")
def rm_node(
    node_id: Annotated[str, typer.Argument(help="Node id")],
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Remove a node and its incident edges (layout refs are pruned server-side)."""
    g = _fetch(server, graph)
    if not any(n.id == node_id for n in g.nodes):
        raise _fail(f"no such node: {node_id}")
    g.nodes = [n for n in g.nodes if n.id != node_id]
    dropped = [e for e in g.edges if node_id in (e.src, e.dst)]
    g.edges = [e for e in g.edges if node_id not in (e.src, e.dst)]
    _push(server, graph, g)
    console.print(f"removed {node_id} and {len(dropped)} incident edge(s)")


@app.command("add-edge")
def add_edge(
    type: Annotated[str, typer.Argument(help="Edge type (must exist in the schema)")],
    src: Annotated[str, typer.Argument(help="Source node id")],
    dst: Annotated[str, typer.Argument(help="Target node id")],
    note: Annotated[str, typer.Option("--note", help="Evidence note, e.g. file:line")] = "",
    data: DataOpt = "{}",
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Add an edge. Both endpoints must already exist."""
    g = _fetch(server, graph)
    props = _parse_data(data)
    if note:
        props["note"] = note
    existing = next((e for e in g.edges if e.key == (type, src, dst)), None)
    if existing:
        existing.data.update(props)
        verb = "updated"
    else:
        g.edges.append(Edge.model_validate({"type": type, "from": src, "to": dst, "data": props}))
        verb = "added"
    _push(server, graph, g)
    console.print(f"{verb} {src} -[{type}]-> {dst}")


@app.command("rm-edge")
def rm_edge(
    type: Annotated[str, typer.Argument()],
    src: Annotated[str, typer.Argument()],
    dst: Annotated[str, typer.Argument()],
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Remove one edge."""
    g = _fetch(server, graph)
    before = len(g.edges)
    g.edges = [e for e in g.edges if e.key != (type, src, dst)]
    if len(g.edges) == before:
        raise _fail(f"no such edge: {type} {src} -> {dst}")
    _push(server, graph, g)
    console.print(f"removed {src} -[{type}]-> {dst}")


@app.command("add-type")
def add_type(
    kind: Annotated[str, typer.Argument(help="'node' or 'edge'")],
    name: Annotated[str, typer.Argument(help="Type name")],
    color: Annotated[str, typer.Option("--color", help="Hex color for the UI")] = "",
    description: Annotated[str, typer.Option("--description", "-d")] = "",
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Add a node or edge type to the schema."""
    if kind not in ("node", "edge"):
        raise _fail("kind must be 'node' or 'edge'")
    g = _fetch(server, graph)
    block = g.graph_schema.nodeTypes if kind == "node" else g.graph_schema.edgeTypes
    block[name] = TypeDef(color=color, description=description)
    _push(server, graph, g)
    console.print(f"added {kind} type {name}")


@app.command()
def skewer(
    skewer_id: Annotated[str, typer.Argument(help="Skewer node id (created if missing)")],
    members: Annotated[list[str], typer.Argument(help="Member node ids, in skewer order")],
    label: Annotated[str, typer.Option("--label", "-l")] = "",
    order_key: Annotated[
        str,
        typer.Option(
            "--order-key",
            help="Member-data field the order reflects (e.g. 'date'); skewers "
            "sharing one form a bundle the UI can keep parallel, space by "
            "value, and draw an axis for",
        ),
    ] = "",
    group: Annotated[
        str,
        typer.Option(
            "--group",
            help="Bundle name (defaults to the order key) — set it when "
            "unrelated bundles happen to share an ordering key",
        ),
    ] = "",
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Create or replace a skewer: an ordered colinearity group stored in the graph.

    Membership and order are knowledge (a `skewer` node plus `skewer-order`
    edges with data.index); where the skewer sits on screen is per-view and is
    arranged in the browser. Replaces any existing membership of SKEWER_ID,
    and MOVES the given members off any other skewer (one skewer per node).
    """
    if len(members) < 2:
        raise _fail("a skewer needs at least 2 members")
    g = _fetch(server, graph)
    node_ids = {n.id for n in g.nodes}
    missing = [m for m in members if m not in node_ids]
    if missing:
        raise _fail(f"no such node(s): {', '.join(missing)}")
    g.graph_schema.nodeTypes.setdefault(
        "skewer", TypeDef(color="#9aa0a6", description="An ordered colinearity group (layout intent)")
    )
    g.graph_schema.edgeTypes.setdefault(
        "skewer-order", TypeDef(color="#c9cdd2", description="Skewer membership; data.index gives the order")
    )
    node = next((n for n in g.nodes if n.id == skewer_id), None)
    if node is None:
        node = Node(id=skewer_id, type="skewer", label=label, data={})
        g.nodes.append(node)
    elif label:
        node.label = label
    if order_key:
        node.data["orderKey"] = order_key
    if group:
        node.data["group"] = group
    g.edges = [e for e in g.edges if not (e.type == "skewer-order" and e.src == skewer_id)]
    member_set = set(members)
    moved = sorted(
        {f"{e.dst} (from {e.src})" for e in g.edges if e.type == "skewer-order" and e.dst in member_set}
    )
    g.edges = [e for e in g.edges if not (e.type == "skewer-order" and e.dst in member_set)]
    for i, m in enumerate(members):
        g.edges.append(
            Edge.model_validate({"type": "skewer-order", "from": skewer_id, "to": m, "data": {"index": i}})
        )
    _push(server, graph, g)
    console.print(f"skewer {skewer_id}: {' → '.join(members)}")
    if moved:
        console.print(f"[dim]moved off other skewers: {', '.join(moved)}[/dim]")


# -- bulk ---------------------------------------------------------------------


@app.command()
def dump(graph: GraphOpt = DEFAULT_GRAPH, server: ServerOpt = DEFAULT_SERVER) -> None:
    """Print the whole graph as JSON (edit it, then `kge load`)."""
    g = _fetch(server, graph)
    print(json.dumps(g.model_dump(by_alias=True), indent=2))


@app.command()
def load(
    path: Annotated[Path, typer.Argument(help="JSON file with the whole graph payload, or - for stdin")],
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Replace the whole graph from a file (clobber, never merge)."""
    raw = sys.stdin.read() if str(path) == "-" else path.read_text()
    g = Graph.model_validate(json.loads(raw))
    summary = _push(server, graph, g)
    console.print(f"saved: {summary}")


def main() -> None:
    app()

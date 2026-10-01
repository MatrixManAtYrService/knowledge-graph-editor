"""The kge CLI: a thin, stateless HTTP client for agents.

Every edit command is write-through: GET the whole graph, mutate it in
memory, PUT it back. The browser is the only client with an edit buffer
(its Save/Refresh); the CLI has no local state at all. For batch edits,
`kge dump` / `kge load` round-trip the whole payload through a file.

Server resolution: --server > $KGE_SERVER_URL > http://localhost:8151.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Annotated

import httpx
import typer
from rich.console import Console
from rich.markup import escape

from kge.models import FLOW_DIRECTIONS, Edge, Graph

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
    # Messages quote ids, which may look like markup or :emoji: codes.
    console.print(f"[red]{escape(msg)}[/red]", emoji=False)
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


def _ops(server: str, graph_id: str, ops: list[dict]) -> list[dict]:
    """Apply edit operations (all or nothing; see kge.ops). Each touches only
    its own item, so concurrent writers — the browser, other agents — don't
    clobber each other the way a whole-graph push would. Returns one result
    per op."""
    try:
        resp = httpx.post(_graph_url(server, graph_id) + "/ops", json={"ops": ops}, timeout=60.0)
    except httpx.HTTPError as exc:
        raise _fail(f"can't reach the kge server at {server}: {exc}")
    if resp.status_code >= 400:
        ct = resp.headers.get("content-type", "")
        detail = resp.json().get("detail", resp.text) if ct.startswith("application/json") else resp.text
        raise _fail(f"server rejected the edit: {detail}")
    return resp.json()["results"]


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
    readonly: Annotated[
        bool,
        typer.Option(
            "--readonly",
            help="Serve an exported static site from --dir instead of the live "
            "editor: no API, no saving — just the files, with the HTTP Range "
            "support DuckDB-Wasm needs (python -m http.server lacks it)",
        ),
    ] = False,
    dir: Annotated[
        Path | None,
        typer.Option("--dir", help="The exported site --readonly serves (default ./docs)"),
    ] = None,
    port: Annotated[int, typer.Option("--port", help="Server port")] = 8151,
) -> None:
    """Run the kge server over one or more graph directories.

    With no options: serves the subdirectories of ./graphs if that exists,
    else ./graph (seeding an empty-but-valid graph there if missing, so a
    fresh consumer repo can start with just `kge serve`).

    With --readonly: serves an exported site (kge export) from --dir —
    what visitors will get from GitHub Pages, exactly.
    """
    import uvicorn

    from kge.server import create_app
    from kge.store import GraphRegistry, GraphStore

    if readonly:
        site = dir if dir is not None else Path("docs")
        if not (site / "index.html").is_file():
            raise _fail(f"{site} has no index.html — export first: kge export --out {site}")
        from starlette.applications import Starlette

        from fastapi.staticfiles import StaticFiles

        static_app = Starlette()
        static_app.mount("/", StaticFiles(directory=site, html=True), name="site")
        console.print(f"read-only site: {site.resolve()}")
        console.print(f"open http://localhost:{port}")
        uvicorn.run(static_app, host="0.0.0.0", port=port, log_level="warning")
        return
    if dir is not None:
        raise _fail("--dir only applies with --readonly (the editor takes --graph-dir/--graphs-dir)")

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
) -> None:
    """Write a static, read-only copy of the graphs — host it anywhere with
    HTTP Range support (GitHub Pages qualifies).

    Reads the graph files directly (no server needed). The output is the
    same browser UI in read-only mode: no saving, but focus, selection, and
    show/hide still work, and the state a visitor navigates to lives in the
    URL fragment — share the link, share the view. The graphs ship as
    parquet files queried in the browser via DuckDB-Wasm over HTTP range
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
    summary = export_site(registry, out, ui_dir)
    console.print(f"exported {summary['graphs']} graph(s) to {out.resolve()}")
    console.print(
        "[dim]host it anywhere with HTTP Range support (GitHub Pages qualifies; "
        f"python -m http.server does not) — check it locally: kge serve --readonly --dir {out}[/dim]"
    )


def _sql_prefix(graph_id: str) -> str:
    import re

    return re.sub(r"\W", "_", graph_id)


SQL_TABLES = ("nodes", "edges", "ids")


def _parquet_conn(files: dict[str, dict[str, Path]], bare: str):
    """DuckDB views over each graph's parquet (export layout): <graph>_<table>
    per graph, bare nodes/edges/ids for `bare`. The JSON columns are typed
    JSON, so data->>'field' just works."""
    import duckdb

    conn = duckdb.connect()

    def register(view: str, path: Path, table: str) -> None:
        src = "read_parquet('" + str(path).replace("'", "''") + "')"
        cols = {"nodes": "lite, data, adj", "edges": "lite, data"}.get(table)
        sel = f"* REPLACE ({', '.join(f'{c}::JSON AS {c}' for c in cols.split(', '))})" if cols else "*"
        conn.execute(f'CREATE OR REPLACE VIEW "{view}" AS SELECT {sel} FROM {src}')

    for gid, tables in files.items():
        for t, path in tables.items():
            register(f"{_sql_prefix(gid)}_{t}", path, t)
    for t, path in files.get(bare, {}).items():
        register(t, path, t)  # bare names last, so they win any collision
    return conn


def _pick_graph(entries: list[dict], graph: str, where: str) -> str:
    if not entries:
        raise _fail(f"{where} has no graphs")
    ids = [g["id"] for g in entries]
    if graph and graph not in ids:
        raise _fail(f"no such graph in {where}: {graph} (available: {', '.join(ids)})")
    return graph or next((g["id"] for g in entries if g.get("default")), ids[0])


def _site_files(data_dir: Path, gid: str) -> dict[str, Path]:
    """A graph's parquet files, as its graph.json names them (relative to data/<gid>/)."""
    meta = json.loads((data_dir / gid / "graph.json").read_text())
    names = (meta.get("store") or {}).get("files") or {t: f"{t}.parquet" for t in SQL_TABLES}
    return {t: data_dir / gid / name for t, name in names.items() if (data_dir / gid / name).is_file()}


def _export_conn(site: Path, graph: str):
    """DuckDB over an exported site's parquet."""
    data_dir = site / "data"
    graphs_meta = data_dir / "graphs.json"
    if not graphs_meta.is_file():
        raise _fail(f"{site} is not an exported site (no data/graphs.json) — run: kge export --out {site}")
    entries = json.loads(graphs_meta.read_text()).get("graphs", [])
    bare = _pick_graph(entries, graph, "the export")
    return _parquet_conn({e["id"]: _site_files(data_dir, e["id"]) for e in entries}, bare)


def _live_conn(server: str, graph: str, client: httpx.Client | None = None):
    """DuckDB over the live server's graphs: the same parquet the browser
    reads (the server's cache, kge.cache), downloaded into a local mirror.
    Versions never change, so a repeat query downloads nothing."""
    from kge.cache import default_root, prune_versions

    client = client or httpx.Client(base_url=server, timeout=60.0)

    def get(path: str) -> httpx.Response:
        try:
            resp = client.get(path)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise _fail(
                f"can't read {path} from the kge server at {server}: {exc} "
                "(to query an export instead: kge sql --dir <site> ...)"
            )
        return resp

    entries = get("/data/graphs.json").json().get("graphs", [])
    bare = _pick_graph(entries, graph, "the server")
    mirror = default_root() / "remote" / hashlib.sha256(server.encode()).hexdigest()[:12]
    files: dict[str, dict[str, Path]] = {}
    for e in entries:
        gid = e["id"]
        meta = get(f"/data/{gid}/graph.json").json()
        version = meta.get("version") or "unversioned"
        vdir = mirror / gid / version
        local: dict[str, Path] = {}
        for table, name in meta["store"]["files"].items():
            dest = vdir / Path(name).name
            if not dest.is_file():
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(".tmp")
                tmp.write_bytes(get(f"/data/{gid}/{name}").content)
                os.replace(tmp, dest)
            local[table] = dest
        files[gid] = local
        prune_versions(mirror / gid, keep=vdir)
    return _parquet_conn(files, bare)


@app.command()
def sql(
    query_text: Annotated[
        str,
        typer.Argument(
            metavar="QUERY",
            help="DuckDB SQL over the graph tables ('-' reads stdin)",
        ),
    ],
    dir: Annotated[
        Path | None,
        typer.Option(
            "--dir",
            help="Query an exported site (what kge export --out wrote) instead of the live server",
        ),
    ] = None,
    graph: Annotated[
        str,
        typer.Option(
            "--graph",
            "-g",
            help="Graph whose tables get the bare names nodes/edges "
            "(default: the server's / export's default graph)",
        ),
    ] = DEFAULT_GRAPH,
    fmt: Annotated[str, typer.Option("--format", "-f", help="table | json | csv")] = "table",
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Query graphs with DuckDB — the live server's, or an exported site's.

    Both read the same parquet (live: the server's cache — what the
    browser reads — mirrored under ~/.cache/kge/remote), so tables and
    columns are identical. Every graph's tables are registered as
    <graph>_nodes, <graph>_edges, <graph>_ids (non-word characters become
    underscores); the default graph — or the one picked with --graph —
    also gets the bare names nodes, edges, ids.

      nodes: key, id, type, label, data (JSON: the full data; NULL when
             there is none), lite (JSON: the fields the browser draws
             with), adj (JSON: \\[edgeKey, otherKey, edgeType, otherType,
             outgoing] per incident edge)
      edges: key, type, src, dst, src_key, dst_key, data, lite
      ids:   id -> key, sorted by id

    key is the share-URL integer: good for one version of the graph only.

    For "exactly what does saved view X show", use `kge views X` — focus
    and eye resolution live there. For flow questions ("what does X
    reach?") use `kge reaches` / `kge reached-by`. sql is for everything
    else: ad-hoc structure questions, sweeps over data.
    """
    import duckdb

    conn = _export_conn(dir, graph) if dir is not None else _live_conn(server, graph)
    q = sys.stdin.read() if query_text.strip() == "-" else query_text
    try:
        rel = conn.sql(q)
    except duckdb.Error as exc:
        raise _fail(str(exc))
    if rel is None:
        return  # a statement with no result set
    if fmt == "table":
        rel.show()
    elif fmt == "json":
        cols = [d[0] for d in rel.description]
        print(json.dumps([dict(zip(cols, row)) for row in rel.fetchall()], indent=2, default=str))
    elif fmt == "csv":
        import csv

        cols = [d[0] for d in rel.description]
        writer = csv.writer(sys.stdout)
        writer.writerow(cols)
        writer.writerows(rel.fetchall())
    else:
        raise _fail("--format must be table, json, or csv")


@app.command()
def onboarding() -> None:
    """How this tool works and how to collaborate with a human through it.

    Read this first: it explains the editing model (per-item edits that save
    themselves; nobody overwrites anybody), which state lives where, and how
    to work alongside a human in the browser.
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

  <dir>/schema.json        node/edge type vocabulary (colors, families,
                           edge flow directions)
  <dir>/nodes.json         the nodes            } the knowledge —
  <dir>/edges.json         the edges            } committed to git
  <dir>/views/<id>.json    named views: type filters, per-item overrides,
                           focus + eye adjustments, layout (positions and
                           skewer segments) — views belong to their graph
  server memory only       the human's current selection + graph + view
                           (transient, last-writer-wins; `kge selection`)
  browser memory only      at most a second of the human's edits, on their
                           way to the server (they save themselves)
  ~/.cache/kge/            derived, never committed: each graph as parquet
                           (what the browser and `kge sql` read), refreshed
                           whenever the files change; $KGE_CACHE_DIR moves it
  this CLI                 nothing — every command is stateless
  docs/ (if exported)      a static read-only mirror of the graphs as
                           parquet — regenerated on every save when the
                           server runs with --site-dir/$KGE_SITE_DIR, and
                           queryable with `kge sql` (see below)

[bold]The editing model — edits are operations; nobody clobbers anybody[/bold]

  - Every edit, from the browser or this CLI, is an operation on one item
    (add this node, patch that edge's data, replace this view's layout),
    applied by the server to the files under a lock. Edits to different
    items never overwrite each other; two edits to the same item: the last
    one wins.
  - The browser saves as it goes — a moment after each edit; there is no
    Save button — and checks every few seconds for changes made elsewhere.
    [bold]Your CLI edits show up in the human's browser on their own[/bold], and theirs
    are in the files by the time you read them. No Save/Refresh to
    coordinate.
  - Anything that writes the files directly (ekg's sync, git pull, an
    editor) is picked up the same way.
  - The one exception: `kge load` replaces the WHOLE graph with a file
    (clobber, never merge) — edits made since your `kge dump` are lost.
    Prefer the per-item commands while a human is working.

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
    without being logically connected to (uses the view's saved geometry,
    which trails their dragging by about a second).

[bold]Following flow — reaches, reached-by, path[/bold]

  An edge type can declare a flow direction in the schema (`kge add-type
  edge CALLS --flow fwd`; `rev` when flow runs against the arrow, e.g.
  handler -HANDLES-> endpoint). `kge reaches X` / `kge reached-by X` walk
  only those edge types — ownership and hub edges stay unwalked, so the
  answer doesn't sprawl. `-t <type>` filters results, `--chains` shows the
  shortest chain behind each, `--json` for machines. `kge path A B` finds
  shortest connections over any edge (or flow only, with --flow).

[bold]Exploring with SQL — usually your cheapest read[/bold]

  `kge sql "QUERY"` runs DuckDB over the live server's graphs — the same
  parquet the browser reads — or over an exported site with --dir docs.
  For anything beyond a single node — counts, filters, joins, sweeps over
  data — this beats dumping the graph and grepping, and it costs the
  context of one result set instead of the whole payload:

    kge sql "SELECT type, count(*) FROM nodes GROUP BY 1"
    kge sql "SELECT id, label FROM nodes WHERE data->>'actor' = 'Jia Tan'"
    kge sql "SELECT src, dst FROM edges WHERE type = 'MERGED_AS'"
    kge sql -g other-graph -f json "SELECT ... "   # pick graph; json/csv out

  Tables per graph: <graph>_nodes/_edges/_ids, with bare nodes/edges/ids
  aliased to the default (or -g) graph. Columns: nodes(key, id, type,
  label, data, lite, adj), edges(key, type, src, dst, src_key, dst_key,
  data, lite), ids(id, key). data is the item's full JSON (NULL when it has
  none); lite is the few fields the browser draws with; adj lists a node's
  edges as \\[edgeKey, otherKey, edgeType, otherType, outgoing]. key is the
  integer share-URLs use — good for one version of the graph only.

  An export (--dir) is a MIRROR — re-export after editing (or run the
  server with --site-dir so saves do it); same tables and columns.

  "What does saved view X show" belongs to `kge views X`, which applies the
  focus/eye resolution SQL doesn't know about.

[bold]Reading and editing[/bold]

  read:  status · graphs · ls · show · types · views · selection ·
         find-collisions · reaches · reached-by · path · dump · sql
  edit:  add-graph · add-node · rm-node · add-edge · rm-edge · add-type ·
         skewer · load

  `kge dump > g.json`, edit, `kge load g.json` for bulk changes (whole-state
  replace — see the exception above). The files under graph/ are ordinary
  git files — commit them like code.\
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
            console.print(f"  {escape(f'-[{e.type}]-> {e.dst}')}  [dim]{_edge_data_text(e)}[/dim]", highlight=False)
        if e.dst == node_id:
            console.print(f"  {escape(f'<-[{e.type}]- {e.src}')}  [dim]{_edge_data_text(e)}[/dim]", highlight=False)


def _edge_data_text(e: Edge) -> str:
    """The note first (the usual evidence), then any other data as JSON."""
    rest = {k: v for k, v in e.data.items() if k != "note"}
    parts = [str(e.data["note"])] if e.data.get("note") else []
    if rest:
        parts.append(json.dumps(rest, ensure_ascii=False))
    return escape("  ".join(parts))


def _print_chain(chain: list[dict]) -> None:
    """One line per step, written in the direction the edge points."""
    for step in chain:
        arrow = escape(f"-[{step['type']}]->")
        note = escape((step.get("data") or {}).get("note", ""))
        tail = f"  [dim]{note}[/dim]" if note else ""
        console.print(f"      {escape(step['from'])} {arrow} {escape(step['to'])}{tail}", highlight=False)


def _reach_command(node_id: str, forward: bool, types: list[str] | None, max_hops: int,
                   chains: bool, as_json: bool, graph: str, server: str) -> None:
    from kge.traverse import reach

    g = _fetch(server, graph)
    if not any(td.flow for td in g.graph_schema.edgeTypes.values()):
        raise _fail(
            "no edge type in this graph's schema declares a flow direction, so there is "
            "nothing to walk — set one with: kge add-type edge <TYPE> --flow fwd|rev"
        )
    try:
        results = reach(g, node_id, forward=forward, node_types=types, max_hops=max_hops)
    except KeyError:
        raise _fail(f"no such node: {node_id} (kge ls --grep ... finds ids)")
    if as_json:
        print(json.dumps({"node": node_id, "direction": "forward" if forward else "backward",
                          "results": results}, indent=2, ensure_ascii=False))
        return
    if not results:
        console.print("[dim]nothing reached[/dim]")
        return
    for r in results:
        console.print(f"{escape(r['node'])}  [dim]({r['type']}, {r['hops']} hop{'s' if r['hops'] != 1 else ''})[/dim]", highlight=False)
        if chains:
            _print_chain(r["chain"])


TypesOpt = Annotated[
    list[str] | None,
    typer.Option("--type", "-t", help="Only report nodes of this type (repeatable)"),
]
MaxHopsOpt = Annotated[int, typer.Option("--max-hops", help="Maximum flow-path length")]
ChainsOpt = Annotated[bool, typer.Option("--chains", help="Print each result's shortest chain")]
JsonOpt = Annotated[bool, typer.Option("--json", help="Machine-readable output (includes chains)")]


@app.command()
def reaches(
    node_id: Annotated[str, typer.Argument(help="Start node id")],
    type: TypesOpt = None,
    max_hops: MaxHopsOpt = 10,
    chains: ChainsOpt = False,
    as_json: JsonOpt = False,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """What does this node reach, following flow edges forward?

    Only edge types whose schema entry declares `flow` (fwd: from → to,
    rev: to → from) are walked; the rest — ownership, hubs — are not, so
    answers stay specific. Each result carries its hop count and one
    shortest chain (--chains / --json).

    Example: kge reaches task:merchant_cycle.cmm_preload.poll -t endpoint
    """
    _reach_command(node_id, True, type, max_hops, chains, as_json, graph, server)


@app.command("reached-by")
def reached_by(
    node_id: Annotated[str, typer.Argument(help="End node id")],
    type: TypesOpt = None,
    max_hops: MaxHopsOpt = 10,
    chains: ChainsOpt = False,
    as_json: JsonOpt = False,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """What reaches this node, walking flow edges backwards?

    The direct answer to "which tasks ultimately hit this endpoint/table?".
    Chains read in flow order (result → … → this node).

    Example: kge reached-by table:billing_bookkeeper.billing_entity -t task
    """
    _reach_command(node_id, False, type, max_hops, chains, as_json, graph, server)


@app.command()
def path(
    src: Annotated[str, typer.Argument(help="Start node id")],
    dst: Annotated[str, typer.Argument(help="End node id")],
    max_hops: Annotated[int, typer.Option("--max-hops", help="Maximum path length")] = 8,
    max_paths: Annotated[int, typer.Option("--max-paths", help="Maximum number of paths")] = 5,
    flow: Annotated[
        bool, typer.Option("--flow", help="Walk forward flow only, instead of any edge either way")
    ] = False,
    as_json: JsonOpt = False,
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Shortest paths between two nodes.

    By default any edge is walked in either direction — "how are these
    connected at all?" — and each step shows the edge's true direction.
    --flow restricts the walk to forward flow edges.
    """
    from kge.traverse import paths

    g = _fetch(server, graph)
    try:
        found = paths(g, src, dst, max_hops=max_hops, max_paths=max_paths, flow_only=flow)
    except KeyError as exc:
        raise _fail(f"no such node: {exc.args[0]} (kge ls --grep ... finds ids)")
    if as_json:
        print(json.dumps({"src": src, "dst": dst, "paths": found}, indent=2, ensure_ascii=False))
        return
    if not found:
        console.print(f"[dim]no path within {max_hops} hops[/dim]")
        return
    for i, p in enumerate(found, 1):
        console.print(f"path {i}  [dim]({len(p)} hop{'s' if len(p) != 1 else ''})[/dim]")
        _print_chain(p)


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
        flow = f" flow:{td.flow}" if td.flow else ""
        console.print(f"  {name} ({ecounts.get(name, 0)}){flow}  [dim]{td.description}[/dim]")


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
    props = _parse_data(data)
    [res] = _ops(server, graph, [{"op": "upsert_node", "id": node_id, "type": type, "label": label, "set": props}])
    verb = "added" if res["result"] == "created" else "updated"
    console.print(f"{verb} {node_id} [dim]({type})[/dim]")


@app.command("rm-node")
def rm_node(
    node_id: Annotated[str, typer.Argument(help="Node id")],
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Remove a node and its incident edges (layout refs are pruned server-side)."""
    [res] = _ops(server, graph, [{"op": "remove_node", "id": node_id}])
    console.print(f"removed {node_id} and {res['edges']} incident edge(s)")


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
    """Add an edge (or update its data, if it exists). Both endpoints must already exist."""
    props = _parse_data(data)
    if note:
        props["note"] = note
    [res] = _ops(server, graph, [{"op": "upsert_edge", "type": type, "from": src, "to": dst, "set": props}])
    verb = "added" if res["result"] == "created" else "updated"
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
    _ops(server, graph, [{"op": "remove_edge", "type": type, "from": src, "to": dst}])
    console.print(f"removed {src} -[{type}]-> {dst}")


@app.command("add-type")
def add_type(
    kind: Annotated[str, typer.Argument(help="'node' or 'edge'")],
    name: Annotated[str, typer.Argument(help="Type name")],
    color: Annotated[str, typer.Option("--color", help="Hex color for the UI")] = "",
    description: Annotated[str, typer.Option("--description", "-d")] = "",
    family: Annotated[str, typer.Option("--family", help="Grouping above type in the UI tree")] = "",
    flow: Annotated[
        str,
        typer.Option(
            "--flow",
            help="Edge types only: fwd (flow runs from → to), rev (to → from), or "
            "none (not walked by reaches/reached-by)",
        ),
    ] = "",
    graph: GraphOpt = DEFAULT_GRAPH,
    server: ServerOpt = DEFAULT_SERVER,
) -> None:
    """Add a node or edge type to the schema, or update the given fields of an existing one."""
    if kind not in ("node", "edge"):
        raise _fail("kind must be 'node' or 'edge'")
    if flow and kind != "edge":
        raise _fail("--flow applies to edge types only")
    if flow and flow not in (*FLOW_DIRECTIONS, "none"):
        raise _fail("--flow must be fwd, rev, or none")
    fields: dict = {}
    if color:
        fields["color"] = color
    if description:
        fields["description"] = description
    if family:
        fields["family"] = family
    if flow:
        fields["flow"] = None if flow == "none" else flow
    [res] = _ops(server, graph, [{"op": "patch_type", "kind": kind, "name": name, "set": fields}])
    verb = "added" if res["result"] == "created" else "updated"
    console.print(f"{verb} {kind} type {name}")


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
    # Which membership edges to replace depends on the current graph, so
    # read it; the edit itself is one op batch (removals tolerate an edge
    # someone else already removed).
    g = _fetch(server, graph)
    node_ids = {n.id for n in g.nodes}
    missing = [m for m in members if m not in node_ids]
    if missing:
        raise _fail(f"no such node(s): {', '.join(missing)}")
    ops: list[dict] = []
    if "skewer" not in g.graph_schema.nodeTypes:
        ops.append({"op": "patch_type", "kind": "node", "name": "skewer",
                    "set": {"color": "#9aa0a6", "description": "An ordered colinearity group (layout intent)"}})
    if "skewer-order" not in g.graph_schema.edgeTypes:
        ops.append({"op": "patch_type", "kind": "edge", "name": "skewer-order",
                    "set": {"color": "#c9cdd2", "description": "Skewer membership; data.index gives the order"}})
    data = {k: v for k, v in (("orderKey", order_key), ("group", group)) if v}
    ops.append({"op": "upsert_node", "id": skewer_id, "type": "skewer", "label": label, "set": data})
    member_set = set(members)
    moved = sorted(
        {f"{e.dst} (from {e.src})" for e in g.edges
         if e.type == "skewer-order" and e.dst in member_set and e.src != skewer_id}
    )
    for e in g.edges:
        if e.type == "skewer-order" and (e.src == skewer_id or e.dst in member_set):
            ops.append({"op": "remove_edge", "type": e.type, "from": e.src, "to": e.dst, "missing_ok": True})
    for i, m in enumerate(members):
        ops.append({"op": "create_edge", "type": "skewer-order", "from": skewer_id, "to": m, "data": {"index": i}})
    _ops(server, graph, ops)
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

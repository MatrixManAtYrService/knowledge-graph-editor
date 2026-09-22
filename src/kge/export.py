"""Static-site export: the read-only twin of the editor, for GitHub Pages.

`kge export` (or `kge serve --site-dir`) writes a directory that any static
file host can serve:

    <site>/index.html + assets/   the same built UI, with a marker script
                                  injected so it boots in read-only mode
    <site>/data/graphs.json       what GET /api/graphs returns
    <site>/data/<id>/graph.json   schema + views + either the inline graph
                                  (small) or aggregate counts (windowed)
    ...and per graph, one of two data layouts:

Inline mode (graphs of <= inline_threshold nodes, default 500): graph.json
carries every node/edge with *lite* data, plus JSON detail shards
({node,edge}-data-<k>.json) fetched when an item is inspected. One fetch
shows everything; no wasm involved.

Windowed mode (bigger graphs): nodes.parquet / edges.parquet, sorted by
(type, id) with tight row groups (ebb_profile_viz's pattern), which the
browser queries through DuckDB-Wasm over HTTP range requests — so a view
showing a focused sliver of a huge graph downloads roughly that sliver:

  - `key` (INT32, the row's index) doubles as the share-URL integer; row
    groups span tight key ranges, so `WHERE key IN (...)` reads only the
    groups it touches.
  - each node row carries `adj`, its incident non-skewer edges as
    [edgeKey, otherKey, edgeType, otherType] — focus BFS hops by point
    reads instead of scanning the edge table.
  - the (type, id) sort makes "load every included type" a contiguous,
    stats-prunable range scan.
  - graph.json keeps what must be whole: schema, views, per-type and
    per-color-value counts (the sidebar's totals), and the skewer subgraph
    (rails are curated and small; bundles need all members).

"Lite" node data is the fields rendering needs without a detail fetch: the
schema's colorKey, every orderKey any skewer declares (so spacing actions
work offline), and the whole payload for skewer nodes / skewer-order edges.
The rest of an item's `data` loads when it is inspected.

Integers are stable only until the graph is edited — share links may dangle
across data pushes, the accepted cost of not maintaining an id registry.
"""

from __future__ import annotations

import json
import math
import os
import shutil
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from kge.models import Graph
from kge.store import GraphRegistry

INLINE_THRESHOLD = 500  # <= this many nodes: inline JSON, no wasm
SHARD_SIZE = 64  # JSON detail shards (inline mode)
# Parquet row-group size (windowed mode): the browser's fetch unit. Bigger
# groups mean fewer, larger range reads and — just as important — a smaller
# footer: row-group metadata is read up front, and at 200k rows it already
# runs to hundreds of KB.
ROW_GROUP = 1024
STATIC_MARKER = "<script>window.KGE_STATIC = true</script>"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def _hot_node_keys(graph: Graph) -> set[str]:
    """Node-data fields kept inline/lite (everything else loads on inspect)."""
    keys: set[str] = set()
    if graph.graph_schema.colorKey:
        keys.add(graph.graph_schema.colorKey)
    for n in graph.nodes:
        if n.type == "skewer":
            order_key = n.data.get("orderKey")
            if isinstance(order_key, str) and order_key:
                keys.add(order_key)
    return keys


def _write_parquet(
    path: Path,
    schema: pa.Schema,
    columns: dict[str, list],
    total: int,
    stats_cols: list[str] | None = None,
) -> None:
    """Write with one row group per ROW_GROUP rows. Statistics only on the
    columns queries prune by — min/max over the JSON blob columns would
    bloat the footer (the first thing every reader downloads) for nothing."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with pq.ParquetWriter(
        tmp,
        schema,
        compression="zstd",
        write_statistics=stats_cols if stats_cols is not None else True,
    ) as writer:
        for start in range(0, total, ROW_GROUP):
            end = min(start + ROW_GROUP, total)
            writer.write_table(
                pa.table({k: v[start:end] for k, v in columns.items()}, schema=schema),
                row_group_size=end - start,
            )
    os.replace(tmp, path)


def export_graph_data(graph: Graph, out_dir: Path, inline_threshold: int | None = None) -> dict:
    """Write one graph's static data files. Returns a summary dict."""
    if inline_threshold is None:
        inline_threshold = int(os.environ.get("KGE_INLINE_THRESHOLD", INLINE_THRESHOLD))
    out_dir.mkdir(parents=True, exist_ok=True)
    # The export order defines each item's integer: nodes by (type, id) so a
    # type is one contiguous key range, edges by (type, from, to).
    graph.nodes.sort(key=lambda n: (n.type, n.id))
    graph.edges.sort(key=lambda e: (e.type, e.src, e.dst))
    hot = _hot_node_keys(graph)

    nodes_lite: list[dict] = []
    node_detail: dict[int, dict] = {}
    for i, n in enumerate(graph.nodes):
        lite = n.data if n.type == "skewer" else {k: v for k, v in n.data.items() if k in hot}
        nodes_lite.append({"id": n.id, "type": n.type, "label": n.label, "data": lite})
        if any(k not in lite for k in n.data):
            node_detail[i] = n.data

    edges_lite: list[dict] = []
    edge_detail: dict[int, dict] = {}
    for i, e in enumerate(graph.edges):
        lite = e.data if e.type == "skewer-order" else {}
        edges_lite.append({"type": e.type, "from": e.src, "to": e.dst, "data": lite})
        if any(k not in lite for k in e.data):
            edge_detail[i] = e.data

    base = {
        "schema": graph.graph_schema.model_dump(),
        "views": [v.model_dump(by_alias=True) for v in graph.views],
    }
    inline = len(graph.nodes) <= inline_threshold
    if inline:
        base["nodes"] = nodes_lite
        base["edges"] = edges_lite
        base["detail"] = _write_shards(out_dir, node_detail, edge_detail, len(graph.nodes), len(graph.edges))
        for f in ("nodes.parquet", "edges.parquet"):
            (out_dir / f).unlink(missing_ok=True)
    else:
        base["store"] = _write_windowed(graph, out_dir, nodes_lite, edges_lite, node_detail, edge_detail)
        for f in out_dir.glob("node-data-*.json"):
            f.unlink()
        for f in out_dir.glob("edge-data-*.json"):
            f.unlink()
    if inline:
        (out_dir / "ids.parquet").unlink(missing_ok=True)
    _write_json(out_dir / "graph.json", base)
    return {"nodes": len(graph.nodes), "edges": len(graph.edges), "inline": inline}


def _write_shards(
    out_dir: Path,
    node_detail: dict[int, dict],
    edge_detail: dict[int, dict],
    n_nodes: int,
    n_edges: int,
) -> dict:
    """Inline mode's lazy layer: JSON detail shards keyed by item integer."""

    def write(prefix: str, detail: dict[int, dict], total: int) -> list[int]:
        present: list[int] = []
        for k in range(math.ceil(total / SHARD_SIZE) if total else 0):
            entries = {
                str(i): d for i, d in detail.items() if k * SHARD_SIZE <= i < (k + 1) * SHARD_SIZE
            }
            path = out_dir / f"{prefix}-{k}.json"
            if entries:
                present.append(k)
                _write_json(path, entries)
            elif path.is_file():
                path.unlink()
        return present

    return {
        "shardSize": SHARD_SIZE,
        "nodeShards": write("node-data", node_detail, n_nodes),
        "edgeShards": write("edge-data", edge_detail, n_edges),
    }


def _write_windowed(
    graph: Graph,
    out_dir: Path,
    nodes_lite: list[dict],
    edges_lite: list[dict],
    node_detail: dict[int, dict],
    edge_detail: dict[int, dict],
) -> dict:
    """Windowed mode: parquet tables + the aggregate block for graph.json."""
    node_key = {n.id: i for i, n in enumerate(graph.nodes)}

    # Adjacency per node: incident non-skewer edges as
    # [edgeKey, otherKey, edgeType, otherType, outgoing] — what focus BFS
    # hops on, and (with the direction flag) enough to synthesize the edge
    # itself client-side: non-skewer edges carry no lite data, so the edge
    # table is only ever point-read for inspect-time hydration.
    adj: list[list[list]] = [[] for _ in graph.nodes]
    for i, e in enumerate(graph.edges):
        if e.type == "skewer-order":
            continue
        s, d = node_key.get(e.src), node_key.get(e.dst)
        if s is None or d is None:
            continue
        adj[s].append([i, d, e.type, graph.nodes[d].type, 1])
        adj[d].append([i, s, e.type, graph.nodes[s].type, 0])

    compact = {"separators": (",", ":")}
    # id -> key sidecar, sorted by id: the only queries that look nodes up by
    # string id (saved-view foci, overrides, skewer members) hit this small
    # file with row-group stats pruning instead of scanning the node table.
    by_id = sorted(range(len(graph.nodes)), key=lambda i: graph.nodes[i].id)
    _write_parquet(
        out_dir / "ids.parquet",
        pa.schema([("id", pa.large_string()), ("key", pa.int32())]),
        {"id": [graph.nodes[i].id for i in by_id], "key": by_id},
        len(graph.nodes),
        stats_cols=["id"],
    )
    _write_parquet(
        out_dir / "nodes.parquet",
        pa.schema(
            [
                ("key", pa.int32()),
                ("id", pa.large_string()),
                ("type", pa.large_string()),
                ("label", pa.large_string()),
                ("lite", pa.large_string()),
                ("data", pa.large_string()),  # full data; NULL when lite covers it
                ("adj", pa.large_string()),
            ]
        ),
        {
            "key": list(range(len(graph.nodes))),
            "id": [n.id for n in graph.nodes],
            "type": [n.type for n in graph.nodes],
            "label": [n.label for n in graph.nodes],
            "lite": [json.dumps(x["data"], **compact) for x in nodes_lite],
            "data": [
                json.dumps(node_detail[i], **compact) if i in node_detail else None
                for i in range(len(graph.nodes))
            ],
            "adj": [json.dumps(a, **compact) for a in adj],
        },
        len(graph.nodes),
        stats_cols=["key", "type"],
    )
    _write_parquet(
        out_dir / "edges.parquet",
        pa.schema(
            [
                ("key", pa.int32()),
                ("type", pa.large_string()),
                ("src", pa.large_string()),
                ("dst", pa.large_string()),
                ("src_key", pa.int32()),
                ("dst_key", pa.int32()),
                ("lite", pa.large_string()),
                ("data", pa.large_string()),
            ]
        ),
        {
            "key": list(range(len(graph.edges))),
            "type": [e.type for e in graph.edges],
            "src": [e.src for e in graph.edges],
            "dst": [e.dst for e in graph.edges],
            "src_key": [node_key.get(e.src, -1) for e in graph.edges],
            "dst_key": [node_key.get(e.dst, -1) for e in graph.edges],
            "lite": [json.dumps(x["data"], **compact) for x in edges_lite],
            "data": [
                json.dumps(edge_detail[i], **compact) if i in edge_detail else None
                for i in range(len(graph.edges))
            ],
        },
        len(graph.edges),
        stats_cols=["key", "type", "src", "dst"],
    )

    type_counts: dict[str, int] = {}
    for n in graph.nodes:
        type_counts[n.type] = type_counts.get(n.type, 0) + 1
    edge_type_counts: dict[str, int] = {}
    for e in graph.edges:
        edge_type_counts[e.type] = edge_type_counts.get(e.type, 0) + 1
    color_counts: dict[str, int] = {}
    color_key = graph.graph_schema.colorKey
    if color_key:
        for n in graph.nodes:
            if n.type == "skewer":
                continue
            raw = n.data.get(color_key)
            if isinstance(raw, (str, int, float)) and raw != "":
                color_counts[str(raw)] = color_counts.get(str(raw), 0) + 1

    # The skewer subgraph rides along whole: rails are curated and small, the
    # sidebar's bundle tree and the spacing actions need every member edge.
    skewer_nodes = [
        [i, {"id": n.id, "type": n.type, "label": n.label, "data": n.data}]
        for i, n in enumerate(graph.nodes)
        if n.type == "skewer"
    ]
    skewer_edges = [
        [i, {"type": e.type, "from": e.src, "to": e.dst, "data": e.data}]
        for i, e in enumerate(graph.edges)
        if e.type == "skewer-order"
    ]

    return {
        "mode": "parquet",
        "rowGroup": ROW_GROUP,
        "nodes": len(graph.nodes),
        "edges": len(graph.edges),
        "files": {"nodes": "nodes.parquet", "edges": "edges.parquet", "ids": "ids.parquet"},
        "typeCounts": type_counts,
        "edgeTypeCounts": edge_type_counts,
        "colorCounts": color_counts,
        "skewers": {"nodes": skewer_nodes, "edges": skewer_edges},
    }


def export_data(
    registry: GraphRegistry, site_dir: Path, inline_threshold: int | None = None
) -> dict:
    """Write graphs.json + every graph's data files; prune deleted graphs."""
    data_dir = site_dir / "data"
    stores = registry.stores()
    graphs = []
    for gid, store in stores.items():
        g = store.load()
        graphs.append(
            {
                "id": gid,
                "nodes": len(g.nodes),
                "edges": len(g.edges),
                "views": len(g.views),
                "default": gid == registry.default_id(),
            }
        )
        export_graph_data(g, data_dir / gid, inline_threshold)
    _write_json(data_dir / "graphs.json", {"graphs": graphs})
    if data_dir.is_dir():
        for d in data_dir.iterdir():
            if d.is_dir() and d.name not in stores:
                shutil.rmtree(d)
    return {"graphs": len(graphs), "site": str(site_dir)}


def export_assets(ui_dir: Path, site_dir: Path) -> None:
    """Copy the built UI into the site and mark it read-only: the injected
    script sets window.KGE_STATIC before the app module loads, which is the
    whole mode switch (see ui/src/static.ts)."""
    site_dir.mkdir(parents=True, exist_ok=True)
    assets_src = ui_dir / "assets"
    assets_dst = site_dir / "assets"
    if assets_dst.is_dir():
        shutil.rmtree(assets_dst)
    if assets_src.is_dir():
        shutil.copytree(assets_src, assets_dst)
    html = (ui_dir / "index.html").read_text()
    if STATIC_MARKER not in html:
        html = html.replace("<script", f"{STATIC_MARKER}\n    <script", 1)
    (site_dir / "index.html").write_text(html)
    # GitHub Pages: no Jekyll pass over the exported files.
    (site_dir / ".nojekyll").write_text("")


def export_site(
    registry: GraphRegistry,
    site_dir: Path,
    ui_dir: Path | None,
    inline_threshold: int | None = None,
) -> dict:
    if ui_dir is not None and (ui_dir / "index.html").is_file():
        export_assets(ui_dir, site_dir)
    return export_data(registry, site_dir, inline_threshold)

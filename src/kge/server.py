"""The kge server: sessionless HTTP over the file stores, plus the built UI.

One server offers several graphs (a GraphRegistry names them); each graph
keeps the two-endpoint editing model:

    GET /api/graphs               the graph ids (with counts)
    POST /api/graphs              seed a new empty graph under the graphs root
    GET /api/graphs/{id}          that graph, whole (read fresh from the files)
    PUT /api/graphs/{id}          replace that graph, whole (clobber, never merge)
    GET|PUT /api/graph            the default graph (the pre-multigraph API)

    POST /api/graphs/{id}/ops     apply a batch of edit operations (ops.py)
    GET /api/graphs/{id}/version  the graph files' current version token

The browser reads graphs the way a static site does: the same data/ URLs a
`kge export` site has, served from the parquet cache (cache.py), which
follows the JSON files whatever wrote them:

    GET /data/graphs.json                   the graph list (+ capabilities)
    GET /data/{id}/graph.json               schema, views, counts, version
    GET /data/{id}/{version}/{file}         that version's parquet (Range ok)
    GET /duckdb/{version}/duckdb-eh.wasm    the browser's DuckDB binary, fetched
                                            once into the cache (cache.py)

Writes are sessionless: whole-state PUTs (the CLI's dump/load) or op
batches (the browser), each one locked load-modify-save of the files.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kge.cache import ParquetCache, duckdb_wasm, fingerprint
from kge.models import Graph, SelectionState
from kge.ops import OpError, apply_ops
from kge.store import GraphRegistry, GraphStore

# What this server lets the browser do; a static export offers none of it.
CAPABILITIES = {"write": True, "selection": True}
NO_STORE = {"Cache-Control": "no-store"}
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
DATA_FILES = {"nodes.parquet", "edges.parquet", "ids.parquet"}
VERSION_RE = re.compile(r"[0-9a-f]{16}")

_STARTED_AT = time.time()


class NewGraph(BaseModel):
    id: str


class OpBatch(BaseModel):
    ops: list[dict]
    # The version the client loaded. Informational: a mismatch is reported
    # back ("moved") so the client can reload, never rejected.
    base_version: str | None = None


def create_app(
    registry: GraphRegistry,
    ui_dir: Path | None = None,
    site_dir: Path | None = None,
    cache: ParquetCache | None = None,
) -> FastAPI:
    app = FastAPI(title="kge server")
    cache = cache or ParquetCache()
    audit_dir = registry.audit_dir()
    selection = SelectionState()  # transient, in-memory only (see models.SelectionState)

    def sync_site() -> None:
        """Keep the static read-only site current with the files. Best-effort:
        an export hiccup must not turn a successful save into an error."""
        if site_dir is None:
            return
        from kge.export import export_data

        try:
            export_data(registry, site_dir)
        except Exception as exc:
            print(f"static site export failed: {exc}")

    def store_or_404(graph_id: str) -> GraphStore:
        store = registry.get(graph_id)
        if store is None:
            known = ", ".join(registry.stores()) or "(none)"
            raise HTTPException(404, f"no such graph: {graph_id} (available: {known})")
        return store

    def default_store() -> GraphStore:
        gid = registry.default_id()
        if gid is None:
            raise HTTPException(500, "this server has no graphs")
        return store_or_404(gid)

    def load(store: GraphStore) -> dict:
        try:
            return store.load().model_dump(by_alias=True)
        except Exception as exc:
            raise HTTPException(500, f"graph files are unreadable: {exc}")

    def save(store: GraphStore, graph: Graph) -> dict:
        try:
            with store.locked():
                summary = store.save(graph)
                version = fingerprint(store)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        sync_site()
        return {"saved": True, "version": version, **summary}

    def cached(graph_id: str) -> tuple[str, Path]:
        store = store_or_404(graph_id)
        try:
            return cache.ensure(graph_id, store)
        except Exception as exc:
            raise HTTPException(500, f"graph {graph_id}: export to the parquet cache failed: {exc}")

    @app.middleware("http")
    async def audit(request: Request, call_next):
        """Append-only JSONL of every API call (cloverpatch's audit pattern)."""
        response = await call_next(request)
        if request.url.path.startswith("/api"):
            audit_dir.mkdir(parents=True, exist_ok=True)
            record = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "client": request.client.host if request.client else "",
            }
            day = time.strftime("%Y%m%d", time.gmtime())
            with open(audit_dir / f"audit-{day}.jsonl", "a") as f:
                f.write(json.dumps(record) + "\n")
        return response

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/api/version")
    async def version():
        stores = registry.stores()
        rev = ""
        first = next(iter(stores.values()), None)
        if first is not None:
            r = subprocess.run(
                ["git", "-C", str(first.dir), "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
            )
            if r.returncode == 0:
                rev = r.stdout.strip()
        return {
            "rev": rev,
            "started_at": _STARTED_AT,
            "default_graph": registry.default_id(),
            "graph_dirs": {gid: str(s.dir) for gid, s in stores.items()},
        }

    @app.get("/api/graphs")
    async def list_graphs():
        out = []
        for gid, store in registry.stores().items():
            g = Graph.model_validate(load(store))
            out.append(
                {
                    "id": gid,
                    "nodes": len(g.nodes),
                    "edges": len(g.edges),
                    "views": len(g.views),
                    "default": gid == registry.default_id(),
                }
            )
        return {"graphs": out}

    @app.post("/api/graphs")
    async def create_graph(body: NewGraph):
        try:
            registry.create(body.id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        sync_site()
        return {"created": body.id}

    @app.delete("/api/graphs/{graph_id}")
    async def delete_graph(graph_id: str):
        try:
            registry.delete(graph_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        sync_site()
        return {"deleted": graph_id}

    @app.get("/api/graphs/{graph_id}")
    async def get_one(graph_id: str):
        return load(store_or_404(graph_id))

    # Sync handlers from here: they take a file lock or run an export, so
    # they belong in the threadpool, not on the event loop.
    @app.put("/api/graphs/{graph_id}")
    def put_one(graph_id: str, graph: Graph):
        return save(store_or_404(graph_id), graph)

    @app.post("/api/graphs/{graph_id}/ops")
    def post_ops(graph_id: str, batch: OpBatch):
        store = store_or_404(graph_id)
        with store.locked():
            before = fingerprint(store)
            graph = Graph.model_validate(load(store))
            try:
                apply_ops(graph, batch.ops)
                summary = store.save(graph)
            except ValueError as exc:  # OpError, or validate_semantics in save
                raise HTTPException(400, str(exc))
            version = fingerprint(store)
        sync_site()
        moved = batch.base_version is not None and batch.base_version != before
        return {"saved": True, "version": version, "moved": moved, **summary}

    @app.get("/api/graphs/{graph_id}/version")
    def graph_version(graph_id: str):
        return JSONResponse({"version": fingerprint(store_or_404(graph_id))}, headers=NO_STORE)

    # -- the static site's data URLs, served live from the parquet cache ------

    @app.get("/data/graphs.json")
    def data_graphs():
        out = []
        default = registry.default_id()
        for gid in registry.stores():
            _, vdir = cached(gid)
            block = json.loads((vdir / "graph.json").read_text())
            out.append(
                {
                    "id": gid,
                    "nodes": block["store"]["nodes"],
                    "edges": block["store"]["edges"],
                    "views": len(block["views"]),
                    "default": gid == default,
                }
            )
        return JSONResponse(
            {"graphs": out, "capabilities": CAPABILITIES, "duckdbWasmBase": "duckdb/"},
            headers=NO_STORE,
        )

    @app.get("/data/{graph_id}/graph.json")
    def data_graph(graph_id: str):
        version, vdir = cached(graph_id)
        payload = json.loads((vdir / "graph.json").read_text())
        # Point the parquet files at this version's immutable directory.
        files = payload["store"]["files"]
        payload["store"]["files"] = {k: f"{version}/{v}" for k, v in files.items()}
        payload["version"] = version
        return JSONResponse(payload, headers=NO_STORE)

    # HEAD too: DuckDB-Wasm asks for the size before its range reads.
    @app.api_route("/data/{graph_id}/{version}/{name}", methods=["GET", "HEAD"])
    def data_file(graph_id: str, version: str, name: str):
        if name not in DATA_FILES or not VERSION_RE.fullmatch(version):
            raise HTTPException(404, f"no such data file: {version}/{name}")
        cached(graph_id)  # keeps the cache current (and 404s unknown graphs)
        path = cache.graph_root(graph_id, store_or_404(graph_id)) / version / name
        if not path.is_file():
            raise HTTPException(404, f"graph {graph_id} has no version {version} (reload)")
        # Version dirs never change: cache hard.
        return FileResponse(path, headers=IMMUTABLE)

    @app.api_route("/duckdb/{version}/{name}", methods=["GET", "HEAD"])
    def duckdb_file(version: str, name: str):
        try:
            path = duckdb_wasm(version, name, cache.root)
        except ValueError as exc:
            raise HTTPException(404, str(exc))
        except RuntimeError as exc:
            raise HTTPException(502, str(exc))
        return FileResponse(path, media_type="application/wasm", headers=IMMUTABLE)

    # The pre-multigraph API: unqualified means the default graph. Kept so
    # data repos pinning an older CLI against a newer server still work.
    @app.get("/api/graph")
    async def get_graph():
        return load(default_store())

    @app.put("/api/graph")
    def put_graph(graph: Graph):
        return save(default_store(), graph)

    @app.get("/api/selection")
    async def get_selection():
        return selection.model_dump()

    @app.post("/api/selection")
    async def post_selection(state: SelectionState):
        nonlocal selection
        selection = state
        return {"ok": True}

    if ui_dir and ui_dir.is_dir():
        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")

    return app

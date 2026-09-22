"""The kge server: sessionless HTTP over the file stores, plus the built UI.

One server offers several graphs (a GraphRegistry names them); each graph
keeps the two-endpoint editing model:

    GET /api/graphs               the graph ids (with counts)
    POST /api/graphs              seed a new empty graph under the graphs root
    GET /api/graphs/{id}          that graph, whole (read fresh from the files)
    PUT /api/graphs/{id}          replace that graph, whole (clobber, never merge)
    GET|PUT /api/graph            the default graph (the pre-multigraph API)

Every mutating call is one whole-state write, so there is nothing to session:
the browser's memory and the CLI's working.json are the only edit buffers.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kge.models import Graph, SelectionState
from kge.store import GraphRegistry, GraphStore

_STARTED_AT = time.time()


class NewGraph(BaseModel):
    id: str


def create_app(
    registry: GraphRegistry, ui_dir: Path | None = None, site_dir: Path | None = None
) -> FastAPI:
    app = FastAPI(title="kge server")
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
            summary = store.save(graph)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        sync_site()
        return {"saved": True, **summary}

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

    @app.put("/api/graphs/{graph_id}")
    async def put_one(graph_id: str, graph: Graph):
        return save(store_or_404(graph_id), graph)

    # The pre-multigraph API: unqualified means the default graph. Kept so
    # data repos pinning an older CLI against a newer server still work.
    @app.get("/api/graph")
    async def get_graph():
        return load(default_store())

    @app.put("/api/graph")
    async def put_graph(graph: Graph):
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

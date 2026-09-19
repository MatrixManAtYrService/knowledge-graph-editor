"""The kge server: sessionless HTTP over the file store, plus the built UI.

Two endpoints carry the whole editing model:

    GET /api/graph   the full graph (read fresh from the files every call)
    PUT /api/graph   replace the whole graph (clobber, never merge)

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

from kge.models import Graph, SelectionState
from kge.store import GraphStore

_STARTED_AT = time.time()


def create_app(store: GraphStore, ui_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="kge server")
    audit_dir = store.dir / ".audit"
    selection = SelectionState()  # transient, in-memory only (see models.SelectionState)

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
        rev = ""
        r = subprocess.run(
            ["git", "-C", str(store.dir), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            rev = r.stdout.strip()
        return {"rev": rev, "started_at": _STARTED_AT, "graph_dir": str(store.dir)}

    @app.get("/api/graph")
    async def get_graph():
        try:
            return store.load().model_dump(by_alias=True)
        except Exception as exc:
            raise HTTPException(500, f"graph files are unreadable: {exc}")

    @app.get("/api/selection")
    async def get_selection():
        return selection.model_dump()

    @app.post("/api/selection")
    async def post_selection(state: SelectionState):
        nonlocal selection
        selection = state
        return {"ok": True}

    @app.put("/api/graph")
    async def put_graph(graph: Graph):
        try:
            summary = store.save(graph)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"saved": True, **summary}

    if ui_dir and ui_dir.is_dir():
        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")

    return app

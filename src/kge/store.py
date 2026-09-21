"""The file store: graph dirs are the source of truth, checked into git.

    <dir>/schema.json        node/edge type vocabulary
    <dir>/nodes.json         {"nodes": [...]}, sorted by id
    <dir>/edges.json         {"edges": [...]}, sorted by (from, type, to)
    <dir>/views/<id>.json    one file per view (type filters + layout hints)

A GraphStore is one graph directory. A GraphRegistry names several of them —
explicit dirs (id = the dir's basename) plus an optional root whose immediate
subdirs are graphs — and rescans on every call, so a graph dir that appears
under the root (git pull, mkdir) is served without a restart.

Save rewrites everything (the clients send whole state — clobber, never
merge), sorted and pretty-printed so diffs stay reviewable. Each file is
written via temp+rename; stale view files are removed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from kge.models import Graph, GraphSchema, View


class GraphStore:
    def __init__(self, graph_dir: Path):
        self.dir = graph_dir
        self.views_dir = graph_dir / "views"

    # -- io helpers -----------------------------------------------------------

    def _read(self, path: Path) -> dict:
        return json.loads(path.read_text()) if path.is_file() else {}

    def _write(self, path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, path)

    # -- load / save ----------------------------------------------------------

    def load(self) -> Graph:
        """Read the files fresh every time — they may have moved under us (git pull)."""
        views: list[View] = []
        if self.views_dir.is_dir():
            for f in sorted(self.views_dir.glob("*.json")):
                views.append(View.model_validate(self._read(f)))
        if not views:
            views = [View(id="default", name="Default")]
        return Graph.model_validate(
            {
                "schema": self._read(self.dir / "schema.json"),
                "nodes": self._read(self.dir / "nodes.json").get("nodes", []),
                "edges": self._read(self.dir / "edges.json").get("edges", []),
                "views": [v.model_dump(by_alias=True) for v in views],
            }
        )

    def save(self, graph: Graph) -> dict:
        """Validate, prune dangling layout refs, rewrite all files. Returns a summary."""
        errors = graph.validate_semantics()
        if errors:
            raise ValueError("; ".join(errors))
        graph.prune_layout_refs()

        graph.nodes.sort(key=lambda n: n.id)
        graph.edges.sort(key=lambda e: (e.src, e.type, e.dst))
        for v in graph.views:
            v.layout.seedPositions = dict(sorted(v.layout.seedPositions.items()))
            v.layout.pinned.sort()

        self._write(self.dir / "schema.json", graph.graph_schema.model_dump())
        self._write(
            self.dir / "nodes.json",
            {"nodes": [n.model_dump() for n in graph.nodes]},
        )
        self._write(
            self.dir / "edges.json",
            {"edges": [e.model_dump(by_alias=True) for e in graph.edges]},
        )
        self.views_dir.mkdir(parents=True, exist_ok=True)
        keep = set()
        for v in graph.views:
            keep.add(f"{v.id}.json")
            self._write(self.views_dir / f"{v.id}.json", v.model_dump(by_alias=True))
        for f in self.views_dir.glob("*.json"):
            if f.name not in keep:
                f.unlink()

        return {
            "nodes": len(graph.nodes),
            "edges": len(graph.edges),
            "views": len(graph.views),
        }

    def ensure(self) -> None:
        """Create an empty-but-valid graph dir if files are missing."""
        if not (self.dir / "schema.json").is_file():
            self._write(self.dir / "schema.json", GraphSchema().model_dump())
        if not (self.dir / "nodes.json").is_file():
            self._write(self.dir / "nodes.json", {"nodes": []})
        if not (self.dir / "edges.json").is_file():
            self._write(self.dir / "edges.json", {"edges": []})
        if not self.views_dir.is_dir() or not any(self.views_dir.glob("*.json")):
            self._write(
                self.views_dir / "default.json",
                View(id="default", name="Default").model_dump(by_alias=True),
            )


GRAPH_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


class GraphRegistry:
    """The set of graphs the server offers, keyed by id.

    Two sources, combined: explicit graph dirs (id = the dir's basename) and a
    scan root whose immediate subdirs holding a schema.json are graphs (id =
    the subdir's name). Explicit dirs win id collisions. `stores()` rescans
    the root every call — the files are the source of truth, so new graph
    dirs appear (and deleted ones vanish) without a server restart.
    """

    def __init__(self, dirs: list[Path] | None = None, root: Path | None = None):
        self.dirs = [d.resolve() for d in (dirs or [])]
        self.root = root.resolve() if root else None

    def stores(self) -> dict[str, GraphStore]:
        out: dict[str, GraphStore] = {d.name: GraphStore(d) for d in self.dirs}
        if self.root and self.root.is_dir():
            for d in sorted(self.root.iterdir()):
                if d.is_dir() and (d / "schema.json").is_file() and d.name not in out:
                    out[d.name] = GraphStore(d)
        return out

    def get(self, graph_id: str) -> GraphStore | None:
        return self.stores().get(graph_id)

    def default_id(self) -> str | None:
        """The graph unqualified requests (/api/graph, CLI without --graph) mean:
        the first explicit dir, else the root's 'default' subdir, else the
        root's alphabetically first subdir."""
        stores = self.stores()
        if not stores:
            return None
        if self.dirs:
            return self.dirs[0].name
        if "default" in stores:
            return "default"
        return next(iter(stores))

    def create(self, graph_id: str) -> GraphStore:
        """Seed a new empty graph under the scan root."""
        if self.root is None:
            raise ValueError("this server has no graphs root; new graphs can't be created here")
        if not GRAPH_ID_RE.fullmatch(graph_id):
            raise ValueError(f"bad graph id '{graph_id}' (letters, digits, . _ - only)")
        if graph_id in self.stores():
            raise ValueError(f"graph already exists: {graph_id}")
        store = GraphStore(self.root / graph_id)
        store.ensure()
        return store

    def delete(self, graph_id: str) -> None:
        """Remove a graph's directory. Only root-scanned graphs can go (an
        explicit --graph-dir was asked for by name at startup), and never
        the last graph. Git history is the undo."""
        stores = self.stores()
        if graph_id not in stores:
            raise ValueError(f"no such graph: {graph_id}")
        if len(stores) <= 1:
            raise ValueError("the last graph cannot be deleted")
        target = stores[graph_id].dir
        if target in self.dirs or self.root is None or target.parent != self.root:
            raise ValueError(
                f"{graph_id} is served from an explicit --graph-dir; remove its directory yourself"
            )
        shutil.rmtree(target)

    def audit_dir(self) -> Path:
        """One audit log per server: at the scan root if there is one, else
        alongside the first explicit graph (the pre-multigraph location)."""
        base = self.root if self.root else (self.dirs[0] if self.dirs else Path("."))
        return base / ".audit"

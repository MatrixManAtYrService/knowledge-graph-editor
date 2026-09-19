"""The file store: graph/ is the source of truth, checked into git.

    graph/schema.json        node/edge type vocabulary
    graph/nodes.json         {"nodes": [...]}, sorted by id
    graph/edges.json         {"edges": [...]}, sorted by (from, type, to)
    graph/views/<id>.json    one file per view (type filters + layout hints)

Save rewrites everything (the clients send whole state — clobber, never
merge), sorted and pretty-printed so diffs stay reviewable. Each file is
written via temp+rename; stale view files are removed.
"""

from __future__ import annotations

import json
import os
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

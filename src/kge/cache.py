"""The parquet cache: each graph's export data, kept current with its JSON files.

The live server reads graphs the way a static site does — the browser
queries parquet through DuckDB-Wasm — so it needs each graph's `kge export`
data. The JSON files stay the source of truth (any tool may write them: the
server's own ops, the CLI, ekg's sync, git pull, an editor); the cache only
follows:

    <cache root>/<dir hash>-<graph id>/<version>/graph.json
                                                /{nodes,edges,ids}.parquet

`version` is a fingerprint of the graph's JSON files (path, size, mtime,
inode). Freshness is checked lazily, on read: if the files' fingerprint has
no directory yet, the graph is exported into a temp dir and renamed into
place, so a reader never sees half a parquet set. Version dirs are
immutable — a changed graph gets a new dir, and so new URLs. That matters:
DuckDB-Wasm caches parquet footers by URL, so rewriting a file in place
would serve stale metadata. The newest few versions are kept for readers
still mid-load; older ones are pruned.

The cache root defaults to a per-user directory ($KGE_CACHE_DIR, else
$XDG_CACHE_HOME/kge, else ~/.cache/kge), keyed by the graph dir's absolute
path, so consumer repos need no gitignore entry and several servers over the
same graph share (and race harmlessly on) the same entries.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

from kge.export import export_graph_data
from kge.store import GraphStore

KEEP_VERSIONS = 3
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def default_root() -> Path:
    env = os.environ.get("KGE_CACHE_DIR")
    if env:
        return Path(env)
    xdg = os.environ.get("XDG_CACHE_HOME")
    return (Path(xdg) if xdg else Path.home() / ".cache") / "kge"


def fingerprint(store: GraphStore) -> str:
    """The graph files' version token. Stat-only (no reads), so it's cheap
    enough to check on every request. GraphStore writes via temp+rename, so
    every save changes the inode even if size and mtime collide."""
    files = [store.dir / "schema.json", store.dir / "nodes.json", store.dir / "edges.json"]
    if store.views_dir.is_dir():
        files += sorted(store.views_dir.glob("*.json"))
    h = hashlib.sha256()
    for f in files:
        try:
            st = f.stat()
        except FileNotFoundError:
            h.update(f"{f.name}:-\n".encode())
            continue
        h.update(f"{f.relative_to(store.dir)}:{st.st_size}:{st.st_mtime_ns}:{st.st_ino}\n".encode())
    return h.hexdigest()[:16]


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


class ParquetCache:
    def __init__(self, root: Path | None = None):
        self.root = (root or default_root()).resolve()

    def graph_root(self, graph_id: str, store: GraphStore) -> Path:
        tag = hashlib.sha256(str(store.dir.resolve()).encode()).hexdigest()[:12]
        return self.root / f"{tag}-{graph_id}"

    def ensure(self, graph_id: str, store: GraphStore) -> tuple[str, Path]:
        """(version, its directory), exporting first if the files moved."""
        groot = self.graph_root(graph_id, store)
        version = fingerprint(store)
        vdir = groot / version
        if (vdir / "graph.json").is_file():
            return version, vdir
        with _lock_for(str(groot)):
            # A writer can land mid-export: re-fingerprint afterwards and go
            # again rather than file new data under the old files' version.
            for _ in range(5):
                version = fingerprint(store)
                vdir = groot / version
                if (vdir / "graph.json").is_file():
                    return version, vdir
                groot.mkdir(parents=True, exist_ok=True)
                tmp = Path(tempfile.mkdtemp(prefix=".tmp-", dir=groot))
                try:
                    export_graph_data(store.load(), tmp)
                    if fingerprint(store) != version:
                        continue
                    try:
                        tmp.rename(vdir)
                    except OSError:
                        # Another process filed the same version first; its
                        # content is identical (same files, same fingerprint).
                        if not (vdir / "graph.json").is_file():
                            raise
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
                self._prune(groot, keep=vdir)
                return version, vdir
        raise RuntimeError(f"graph {graph_id} kept changing during export; try again")

    def _prune(self, groot: Path, keep: Path) -> None:
        # Temp dirs a crashed export left behind (live ones are seconds old).
        for d in groot.glob(".tmp-*"):
            if time.time() - d.stat().st_mtime > 3600:
                shutil.rmtree(d, ignore_errors=True)
        versions = sorted(
            (d for d in groot.iterdir() if d.is_dir() and not d.name.startswith(".")),
            key=lambda d: d.stat().st_mtime,
            reverse=True,
        )
        for d in versions[KEEP_VERSIONS:]:
            if d != keep:
                shutil.rmtree(d, ignore_errors=True)

"""The live server's read path (parquet cache, data/ URLs) and op writes."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from kge.cache import ParquetCache, fingerprint
from kge.models import Graph
from kge.ops import OpError, apply_ops
from kge.server import create_app
from kge.store import GraphRegistry, GraphStore


def seed(tmp_path) -> GraphStore:
    store = GraphStore(tmp_path / "g")
    store.save(
        Graph.model_validate(
            {
                "schema": {"nodeTypes": {"a": {}, "b": {}}, "edgeTypes": {"R": {}}},
                "nodes": [
                    {"id": "a:1", "type": "a", "data": {"keep": 1, "also": "x"}},
                    {"id": "a:2", "type": "a"},
                    {"id": "b:1", "type": "b"},
                ],
                "edges": [
                    {"type": "R", "from": "a:1", "to": "b:1", "data": {"w": 1}},
                    {"type": "R", "from": "a:2", "to": "b:1"},
                ],
                "views": [{"id": "default", "name": "Default"}],
            }
        )
    )
    return store


@pytest.fixture
def client(tmp_path):
    seed(tmp_path)
    app = create_app(GraphRegistry(dirs=[tmp_path / "g"]), cache=ParquetCache(tmp_path / "cache"))
    return TestClient(app)


def test_data_urls_serve_the_current_version(client):
    graphs = client.get("/data/graphs.json").json()
    assert graphs["capabilities"]["write"] is True
    assert graphs["graphs"][0]["nodes"] == 3

    g = client.get("/data/g/graph.json").json()
    version = g["version"]
    assert g["store"]["files"]["nodes"] == f"{version}/nodes.parquet"
    assert version == client.get("/api/graphs/g/version").json()["version"]

    r = client.get(f"/data/g/{version}/nodes.parquet", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"PAR1"
    assert client.head(f"/data/g/{version}/nodes.parquet").status_code == 200
    assert client.get(f"/data/g/{version}/schema.json").status_code == 404
    assert client.get("/data/g/0000000000000000/nodes.parquet").status_code == 404


def test_cache_follows_outside_writes(tmp_path, client):
    v1 = client.get("/data/g/graph.json").json()["version"]
    # Any writer of the JSON files, not just the server (ekg sync, git pull).
    store = GraphStore(tmp_path / "g")
    g = store.load()
    g.nodes[0].label = "changed"
    store.save(g)
    v2 = client.get("/data/g/graph.json").json()["version"]
    assert v2 != v1
    # The old version stays readable for a client mid-load.
    assert client.get(f"/data/g/{v1}/nodes.parquet").status_code == 200


def test_cache_prunes_old_versions(tmp_path):
    store = seed(tmp_path)
    cache = ParquetCache(tmp_path / "cache")
    for i in range(5):
        g = store.load()
        g.nodes[0].label = f"v{i}"
        store.save(g)
        cache.ensure("g", store)
        time.sleep(0.01)  # distinct dir mtimes
    versions = [d for d in cache.graph_root("g", store).iterdir() if not d.name.startswith(".")]
    assert len(versions) == 3
    assert fingerprint(store) in {d.name for d in versions}


def test_ops_round_trip(tmp_path, client):
    base = client.get("/api/graphs/g/version").json()["version"]
    r = client.post(
        "/api/graphs/g/ops",
        json={
            "ops": [
                {"op": "create_node", "id": "b:2", "type": "b", "data": {"n": 1}},
                {"op": "create_edge", "type": "R", "from": "a:2", "to": "b:2"},
                {"op": "patch_node", "id": "a:1", "label": "one", "set": {"new": True}, "unset": ["also"]},
                {"op": "patch_edge", "type": "R", "from": "a:1", "to": "b:1", "set": {"w": 2}},
            ],
            "base_version": base,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"] is False
    assert r.json()["version"] != base
    g = GraphStore(tmp_path / "g").load()
    a1 = next(n for n in g.nodes if n.id == "a:1")
    assert a1.label == "one" and a1.data == {"keep": 1, "new": True}
    assert next(e for e in g.edges if e.src == "a:1").data == {"w": 2}
    assert any(e.src == "a:2" and e.dst == "b:2" for e in g.edges)


def test_ops_batch_is_all_or_nothing(tmp_path, client):
    before = (tmp_path / "g" / "nodes.json").read_text()
    r = client.post(
        "/api/graphs/g/ops",
        json={"ops": [{"op": "create_node", "id": "b:9", "type": "b"}, {"op": "create_node", "id": "a:1", "type": "a"}]},
    )
    assert r.status_code == 400 and "op 1" in r.json()["detail"]
    # Semantic validation (unknown type) rejects too, after all ops applied.
    r = client.post("/api/graphs/g/ops", json={"ops": [{"op": "create_node", "id": "z:1", "type": "zzz"}]})
    assert r.status_code == 400
    assert (tmp_path / "g" / "nodes.json").read_text() == before


def test_ops_report_a_moved_graph(client):
    r = client.post(
        "/api/graphs/g/ops",
        json={"ops": [{"op": "patch_node", "id": "a:2", "label": "x"}], "base_version": "0" * 16},
    )
    assert r.json()["moved"] is True


def test_remove_node_cascades_its_edges(tmp_path):
    g = seed(tmp_path).load()
    apply_ops(g, [{"op": "remove_node", "id": "b:1"}])
    assert [n.id for n in g.nodes] == ["a:1", "a:2"]
    assert g.edges == []


def test_types_and_views():
    g = Graph.model_validate({"schema": {"nodeTypes": {"a": {}}}, "views": [{"id": "default"}]})
    apply_ops(
        g,
        [
            {"op": "put_type", "kind": "edge", "name": "R", "def": {"flow": "fwd"}},
            {"op": "set_schema", "colorKey": "owner"},
            {"op": "put_view", "view": {"id": "v2", "name": "Two"}},
            {"op": "remove_view", "id": "default"},
        ],
    )
    assert g.graph_schema.edgeTypes["R"].flow == "fwd"
    assert g.graph_schema.colorKey == "owner"
    assert [v.id for v in g.views] == ["v2"]
    with pytest.raises(OpError, match="unknown op"):
        apply_ops(g, [{"op": "explode"}])
    with pytest.raises(OpError, match="malformed"):
        apply_ops(g, [{"op": "create_node", "id": "x"}])


def test_store_lock_is_exclusive(tmp_path):
    import threading

    store = seed(tmp_path)
    order = []

    def hold():
        with store.locked():
            order.append("held")
            time.sleep(0.2)
            order.append("released")

    t = threading.Thread(target=hold)
    t.start()
    time.sleep(0.05)
    with store.locked():
        order.append("second")
    t.join()
    assert order == ["held", "released", "second"]


def test_put_returns_version(client):
    g = client.get("/api/graphs/g").json()
    r = client.put("/api/graphs/g", json=g)
    assert r.json()["version"] == client.get("/api/graphs/g/version").json()["version"]
    assert json.loads(json.dumps(r.json()))["saved"] is True


def test_duckdb_wasm_is_served_from_the_cache(tmp_path, monkeypatch, client):
    from kge.cache import duckdb_wasm

    with pytest.raises(ValueError):
        duckdb_wasm("1.29.0", "duckdb-mvp.wasm", tmp_path)
    with pytest.raises(ValueError):
        duckdb_wasm("../x", "duckdb-eh.wasm", tmp_path)

    # Unreachable source: a clear error naming the override, no partial file.
    monkeypatch.setenv("KGE_DUCKDB_WASM_SOURCE", "http://127.0.0.1:9/{version}/{name}")
    with pytest.raises(RuntimeError, match="KGE_DUCKDB_WASM_SOURCE"):
        duckdb_wasm("1.29.0", "duckdb-eh.wasm", tmp_path)
    assert not any((tmp_path / "duckdb" / "1.29.0").iterdir())

    # Once cached, no network: the server serves the copy as wasm.
    cached = tmp_path / "cache" / "duckdb" / "1.29.0" / "duckdb-eh.wasm"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"\0asm")
    r = client.get("/duckdb/1.29.0/duckdb-eh.wasm")
    assert r.status_code == 200 and r.content == b"\0asm"
    assert r.headers["content-type"] == "application/wasm"
    assert client.get("/duckdb/1.29.1/duckdb-eh.wasm").status_code == 502
    assert client.get("/data/graphs.json").json()["duckdbWasmBase"] == "duckdb/"

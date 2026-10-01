import json

import pytest

from kge.cli import sql_connect_graphs
from kge.models import Graph, TypeDef
from kge.store import GraphStore
from kge.traverse import paths, reach


def make_graph() -> Graph:
    """task -USES-> operator -CALLS-> endpoint <-HANDLES- handler -WRITES-> table,
    plus a SERVES hub edge (no flow) that must not be walked."""
    return Graph.model_validate(
        {
            "schema": {
                "nodeTypes": {t: {} for t in ("task", "operator", "endpoint", "handler", "table", "service")},
                "edgeTypes": {
                    "USES": {"flow": "fwd"},
                    "CALLS": {"flow": "fwd"},
                    "HANDLES": {"flow": "rev"},
                    "WRITES": {"flow": "fwd"},
                    "SERVES": {},
                },
            },
            "nodes": [
                {"id": "task:t", "type": "task"},
                {"id": "operator:Op", "type": "operator"},
                {"id": "endpoint:svc:/x", "type": "endpoint"},
                {"id": "handler:H", "type": "handler"},
                {"id": "table:db.t", "type": "table"},
                {"id": "service:svc", "type": "service"},
                {"id": "endpoint:svc:/other", "type": "endpoint"},
            ],
            "edges": [
                {"type": "USES", "from": "task:t", "to": "operator:Op"},
                {"type": "CALLS", "from": "operator:Op", "to": "endpoint:svc:/x", "data": {"note": "op.py:3"}},
                {"type": "HANDLES", "from": "handler:H", "to": "endpoint:svc:/x"},
                {"type": "WRITES", "from": "handler:H", "to": "table:db.t", "data": {"per": "entity"}},
                {"type": "SERVES", "from": "service:svc", "to": "endpoint:svc:/x"},
                {"type": "SERVES", "from": "service:svc", "to": "endpoint:svc:/other"},
            ],
        }
    )


def test_reach_forward_follows_flow_and_rev_edges():
    got = {r["node"]: r for r in reach(make_graph(), "task:t")}
    assert set(got) == {"operator:Op", "endpoint:svc:/x", "handler:H", "table:db.t"}
    assert got["table:db.t"]["hops"] == 4
    # Chain reads start → result, edges as stored.
    assert [s["type"] for s in got["table:db.t"]["chain"]] == ["USES", "CALLS", "HANDLES", "WRITES"]


def test_reach_skips_edges_without_flow():
    # SERVES has no flow: the sibling endpoint is not reachable through the service hub.
    assert "endpoint:svc:/other" not in {r["node"] for r in reach(make_graph(), "task:t")}
    assert reach(make_graph(), "service:svc") == []


def test_reached_by_with_type_filter():
    got = reach(make_graph(), "table:db.t", forward=False, node_types=["task"])
    assert [r["node"] for r in got] == ["task:t"]
    # Backward chains read in flow order: result → … → start.
    assert got[0]["chain"][0]["from"] == "task:t"
    assert got[0]["chain"][-1]["to"] == "table:db.t"


def test_reach_max_hops_and_unknown_node():
    assert {r["node"] for r in reach(make_graph(), "task:t", max_hops=2)} == {"operator:Op", "endpoint:svc:/x"}
    with pytest.raises(KeyError):
        reach(make_graph(), "nope")


def test_paths_undirected_and_flow_only():
    g = make_graph()
    found = paths(g, "endpoint:svc:/other", "table:db.t")
    assert len(found) == 1
    assert [s["direction"] for s in found[0]] == ["in", "out", "in", "out"]
    # Flow-only can't go through the SERVES hub.
    assert paths(g, "endpoint:svc:/other", "table:db.t", flow_only=True) == []
    assert len(paths(g, "task:t", "table:db.t", flow_only=True)[0]) == 4


def test_flow_is_omitted_when_unset(tmp_path):
    g = make_graph()
    store = GraphStore(tmp_path)
    store.save(g)
    schema = json.loads((tmp_path / "schema.json").read_text())
    assert schema["edgeTypes"]["CALLS"]["flow"] == "fwd"
    assert "flow" not in schema["edgeTypes"]["SERVES"]
    assert "flow" not in schema["nodeTypes"]["task"]
    assert store.load().graph_schema.edgeTypes["HANDLES"].flow == "rev"


def test_flow_on_node_type_is_rejected():
    g = make_graph()
    g.graph_schema.nodeTypes["task"] = TypeDef(flow="fwd")
    assert any("edge types only" in e for e in g.validate_semantics())


def test_sql_over_live_graphs():
    conn = sql_connect_graphs({"ebb": make_graph(), "other-g": Graph()}, bare="ebb")
    assert conn.sql("SELECT count(*) FROM nodes").fetchone()[0] == 7
    assert conn.sql("SELECT count(*) FROM ebb_edges").fetchone()[0] == 6
    assert conn.sql("SELECT count(*) FROM other_g_nodes").fetchone()[0] == 0
    row = conn.sql("SELECT src, dst FROM edges WHERE data->>'per' = 'entity'").fetchone()
    assert row == ("handler:H", "table:db.t")
    # lite mirrors data so export-style queries run unchanged.
    assert conn.sql("SELECT count(*) FROM edges WHERE lite->>'note' = 'op.py:3'").fetchone()[0] == 1

"""CLI commands end to end against an in-process server."""

import types

import httpx
import pytest
import typer
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from kge import cli
from kge.cache import ParquetCache
from kge.server import create_app
from kge.store import GraphRegistry, GraphStore

from test_traverse import make_graph

runner = CliRunner()


@pytest.fixture
def server(tmp_path, monkeypatch):
    """Route the CLI's httpx calls into a test server holding make_graph() as 'ebb'."""
    monkeypatch.setenv("KGE_CACHE_DIR", str(tmp_path / "cache"))
    GraphStore(tmp_path / "graphs" / "ebb").save(make_graph())
    client = TestClient(
        create_app(GraphRegistry(root=tmp_path / "graphs"), cache=ParquetCache(tmp_path / "cache"))
    )
    fake = types.SimpleNamespace(
        **{k: getattr(httpx, k) for k in ("HTTPError", "HTTPStatusError", "Response")},
        get=client.get,
        post=client.post,
        put=client.put,
        delete=client.delete,
        Client=lambda **_: client,
    )
    monkeypatch.setattr(cli, "httpx", fake)
    return GraphStore(tmp_path / "graphs" / "ebb")


def run(*args: str):
    result = runner.invoke(cli.app, [*args, "-s", "http://test", "-g", "ebb"])
    assert result.exit_code == 0, result.output
    return result


def saved_view(store, view_id):
    return next(v for v in store.load().views if v.id == view_id)


def test_add_view_from_sql_shows_exactly_those_nodes(server):
    out = run("add-view", "writers", "--sql", "SELECT src AS id FROM edges WHERE type = 'WRITES' UNION SELECT 'table:db.t'")
    assert "created view writers: 2 nodes / 1 edges" in out.output
    assert "#g=ebb&v=writers" in out.output
    v = saved_view(server, "writers")
    assert v.visibleNodeTypes == []
    assert v.nodeOverrides == ["handler:H", "table:db.t"]


def test_add_view_types_plus_nodes_and_focus(server):
    run("add-view", "mixed", "-t", "endpoint", "-n", "handler:H", "-n", "endpoint:svc:/x",
        "--focus", "endpoint:svc:/x:1")
    v = saved_view(server, "mixed")
    assert v.visibleNodeTypes == ["endpoint"]
    assert v.nodeOverrides == ["handler:H"]  # the endpoint is covered by its type
    assert [(f.node, f.kHops) for f in v.foci] == [("endpoint:svc:/x", 1)]


def test_add_view_refuses_overwrite_and_bad_input(server):
    run("add-view", "v", "-t", "task")
    for args in (["v", "-t", "task"], ["w", "-t", "nope"], ["w", "-n", "task:missing"],
                 ["w", "--sql", "SELECT id FROM nodes WHERE false"],
                 ["w", "-t", "table", "--focus", "task:t"]):
        result = runner.invoke(cli.app, ["add-view", *args, "-s", "http://test", "-g", "ebb"])
        assert result.exit_code == 1, args
    run("add-view", "v", "-t", "table", "--replace")
    assert saved_view(server, "v").visibleNodeTypes == ["table"]
    run("rm-view", "v")
    assert "v" not in [v.id for v in server.load().views]


def test_mount_rebinds_server_and_graph_defaults(server):
    host = typer.Typer()
    sub = typer.Typer()
    host.add_typer(sub, name="q")
    cli.mount(sub, ["ls", "add-view", "views"], prog="host q", server="http://test", graph="ebb")
    result = runner.invoke(host, ["q", "ls", "-t", "table"])
    assert result.exit_code == 0, result.output
    assert "table:db.t" in result.output
    assert runner.invoke(host, ["q", "add-view", "t", "-t", "task"]).exit_code == 0
    assert saved_view(server, "t").visibleNodeTypes == ["task"]
    # Help points at the host's spelling, not kge's.
    help_text = runner.invoke(host, ["q", "add-view", "--help"]).output
    assert "host q views ID" in help_text and "kge views" not in help_text
    with pytest.raises(ValueError):
        cli.mount(sub, ["no-such-command"])

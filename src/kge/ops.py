"""Graph edits as operations: what POST /api/graphs/{id}/ops applies.

A client that holds only part of a graph (the browser reads a parquet
sliver) can't PUT the whole thing back. It sends what changed instead, and
each op touches only its own item, so writers editing different items no
longer clobber each other. A batch is all-or-nothing: the server loads the
graph, applies every op, validates, and only then writes.

    create_node   {id, type, label?, data?}       fails if the id exists
    patch_node    {id, type?, label?, set?, unset?}
    remove_node   {id}                            and its incident edges
    create_edge   {type, from, to, data?}         fails if the edge exists
    patch_edge    {type, from, to, set?, unset?}
    remove_edge   {type, from, to}
    put_type      {kind: node|edge, name, def}
    remove_type   {kind, name}
    set_schema    {colorKey?, colorValues?}
    put_view      {view}                          whole view, create or replace
    remove_view   {id}

`set` / `unset` patch `data` key by key (`set` merges top-level keys,
`unset` removes them), so a client that only loaded some of an item's data
can't wipe the rest. Same-item conflicts are last-writer-wins.
"""

from __future__ import annotations

from typing import Any

from kge.models import Edge, Graph, Node, TypeDef, View


class OpError(ValueError):
    pass


def _patch_data(data: dict, op: dict) -> dict:
    out = dict(data)
    for k in op.get("unset") or []:
        out.pop(k, None)
    out.update(op.get("set") or {})
    return out


def apply_ops(graph: Graph, ops: list[dict[str, Any]]) -> None:
    """Apply `ops` to `graph` in place. Raises OpError naming the failing op."""
    nodes = {n.id: n for n in graph.nodes}
    edges = {e.key: e for e in graph.edges}
    views = {v.id: v for v in graph.views}

    for i, op in enumerate(ops):
        kind = op.get("op")
        try:
            if kind == "create_node":
                if op["id"] in nodes:
                    raise OpError(f"node already exists: {op['id']}")
                nodes[op["id"]] = Node(
                    id=op["id"], type=op["type"], label=op.get("label", ""), data=op.get("data") or {}
                )
            elif kind == "patch_node":
                n = nodes.get(op["id"])
                if n is None:
                    raise OpError(f"no such node: {op['id']}")
                if "type" in op:
                    n.type = op["type"]
                if "label" in op:
                    n.label = op["label"]
                n.data = _patch_data(n.data, op)
            elif kind == "remove_node":
                if nodes.pop(op["id"], None) is None:
                    raise OpError(f"no such node: {op['id']}")
                for k in [k for k in edges if op["id"] in (k[1], k[2])]:
                    del edges[k]
            elif kind == "create_edge":
                key = (op["type"], op["from"], op["to"])
                if key in edges:
                    raise OpError(f"edge already exists: {'|'.join(key)}")
                edges[key] = Edge.model_validate(
                    {"type": op["type"], "from": op["from"], "to": op["to"], "data": op.get("data") or {}}
                )
            elif kind == "patch_edge":
                e = edges.get((op["type"], op["from"], op["to"]))
                if e is None:
                    raise OpError(f"no such edge: {op['type']}|{op['from']}|{op['to']}")
                e.data = _patch_data(e.data, op)
            elif kind == "remove_edge":
                if edges.pop((op["type"], op["from"], op["to"]), None) is None:
                    raise OpError(f"no such edge: {op['type']}|{op['from']}|{op['to']}")
            elif kind in ("put_type", "remove_type"):
                if op["kind"] not in ("node", "edge"):
                    raise OpError(f"type kind must be node or edge, not {op['kind']!r}")
                table = graph.graph_schema.nodeTypes if op["kind"] == "node" else graph.graph_schema.edgeTypes
                if kind == "put_type":
                    table[op["name"]] = TypeDef.model_validate(op["def"])
                elif table.pop(op["name"], None) is None:
                    raise OpError(f"no such {op['kind']} type: {op['name']}")
            elif kind == "set_schema":
                for field in ("colorKey", "colorValues"):
                    if field in op:
                        setattr(graph.graph_schema, field, op[field])
            elif kind == "put_view":
                v = View.model_validate(op["view"])
                views[v.id] = v
            elif kind == "remove_view":
                if views.pop(op["id"], None) is None:
                    raise OpError(f"no such view: {op['id']}")
            else:
                raise OpError(f"unknown op: {kind!r}")
        except OpError as exc:
            raise OpError(f"op {i} ({kind}): {exc}") from None
        except (KeyError, TypeError, ValueError) as exc:
            raise OpError(f"op {i} ({kind}): malformed: {exc}") from None

    graph.nodes = list(nodes.values())
    graph.edges = list(edges.values())
    graph.views = list(views.values())

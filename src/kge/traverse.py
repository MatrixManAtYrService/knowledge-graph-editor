"""Graph traversal over a loaded Graph: flow reach and shortest paths.

Pure functions over the same payload the CLI fetches, so they run client-side
like `ls` and `show` — the server stays a file store.

Flow is declared per edge type in the schema (`TypeDef.flow`): "fwd" means
flow runs from → to, "rev" means to → from, unset means the edge type is not
walked. That keeps ownership and hub edges (a service SERVES many endpoints,
a policy GOVERNS many handlers) from connecting everything to everything.
"""

from __future__ import annotations

from collections import defaultdict, deque

from kge.models import Edge, Graph


def edge_dict(e: Edge, direction: str | None = None) -> dict:
    d: dict = {"type": e.type, "from": e.src, "to": e.dst}
    if e.data:
        d["data"] = e.data
    if direction:
        d["direction"] = direction
    return d


class Adjacency:
    def __init__(self, graph: Graph):
        self.node_types = {n.id: n.type for n in graph.nodes}
        self.flow = {name: td.flow for name, td in graph.graph_schema.edgeTypes.items()}
        self.out: dict[str, list[Edge]] = defaultdict(list)
        self.inc: dict[str, list[Edge]] = defaultdict(list)
        for e in graph.edges:
            self.out[e.src].append(e)
            self.inc[e.dst].append(e)

    def flow_step(self, node: str, forward: bool) -> list[tuple[str, Edge]]:
        """Neighbors one flow hop away. forward=True follows flow out of
        `node`; False walks it backwards (who flows into `node`)."""
        steps: list[tuple[str, Edge]] = []
        # Out-edge node→dst: flow goes node→dst when fwd, dst→node when rev.
        for e in self.out.get(node, []):
            sem = self.flow.get(e.type)
            if sem is not None and (sem == "fwd") is forward:
                steps.append((e.dst, e))
        # In-edge src→node: flow goes node→src when rev, src→node when fwd.
        for e in self.inc.get(node, []):
            sem = self.flow.get(e.type)
            if sem is not None and (sem == "rev") is forward:
                steps.append((e.src, e))
        return steps


def reach(
    graph: Graph,
    start: str,
    forward: bool = True,
    node_types: list[str] | None = None,
    max_hops: int = 10,
) -> list[dict]:
    """Everything reachable from `start` along flow edges, each with its hop
    count and one shortest chain (edges in flow order). forward=False answers
    "what reaches `start`?"."""
    adj = Adjacency(graph)
    if start not in adj.node_types:
        raise KeyError(start)
    parent: dict[str, tuple[str, Edge]] = {}
    dist = {start: 0}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if dist[node] >= max_hops:
            continue
        for neighbor, e in adj.flow_step(node, forward):
            if neighbor not in dist:
                dist[neighbor] = dist[node] + 1
                parent[neighbor] = (node, e)
                queue.append(neighbor)
    wanted = set(node_types or [])
    results = []
    for node in sorted(dist, key=lambda n: (dist[n], n)):
        if node == start or (wanted and adj.node_types.get(node) not in wanted):
            continue
        chain: list[dict] = []
        cursor = node
        while cursor != start:
            prev, e = parent[cursor]
            chain.append(edge_dict(e))
            cursor = prev
        if forward:
            # Collected node→start; flip so it reads start→node. A backward
            # walk's chain already reads node→start, which is flow order.
            chain.reverse()
        results.append(
            {"node": node, "type": adj.node_types.get(node, ""), "hops": dist[node], "chain": chain}
        )
    return results


def paths(
    graph: Graph,
    src: str,
    dst: str,
    max_hops: int = 8,
    max_paths: int = 5,
    flow_only: bool = False,
) -> list[list[dict]]:
    """Shortest paths between two nodes. By default every edge is walked in
    either direction (each step reports the edge's true direction: "out" when
    walked from → to, "in" when walked against it) — the question is "how are
    these connected at all?". flow_only=True walks forward flow only."""
    adj = Adjacency(graph)
    for n in (src, dst):
        if n not in adj.node_types:
            raise KeyError(n)
    if src == dst:
        return [[]]

    def neighbors(node: str) -> list[tuple[Edge, str, str]]:
        if flow_only:
            return [(e, nb, "out" if e.src == node else "in") for nb, e in adj.flow_step(node, True)]
        return [(e, e.dst, "out") for e in adj.out.get(node, [])] + [
            (e, e.src, "in") for e in adj.inc.get(node, [])
        ]

    # BFS layering, then a back-walk over parents to enumerate shortest paths.
    dist = {src: 0}
    parents: dict[str, list[tuple[str, Edge, str]]] = defaultdict(list)
    queue = deque([src])
    found_at: int | None = None
    while queue:
        node = queue.popleft()
        d = dist[node]
        if (found_at is not None and d >= found_at) or d >= max_hops:
            continue
        for e, nb, direction in neighbors(node):
            if nb not in dist:
                dist[nb] = d + 1
                queue.append(nb)
            if dist[nb] == d + 1:
                parents[nb].append((node, e, direction))
                if nb == dst and found_at is None:
                    found_at = d + 1
    if dst not in parents:
        return []

    out: list[list[dict]] = []

    def back(node: str, acc: list[dict]) -> None:
        if len(out) >= max_paths:
            return
        if node == src:
            out.append(list(reversed(acc)))
            return
        for prev, e, direction in parents[node]:
            back(prev, acc + [edge_dict(e, direction)])

    back(dst, [])
    return out

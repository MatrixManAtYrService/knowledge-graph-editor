"""Collision detection over a view's geometry.

Mirrors the UI's rendering math (ui/src/graph.ts and GraphCanvas.tsx): nodes
are circles of NODE_RADIUS at their skewer-derived or seed positions; rails
are thick segments between a skewer's endpoints; edges are approximated as
straight segments between their endpoints (the UI draws same-skewer edges as
arcs, so edge results are approximate). Everything is computed from the last
*saved* state of the view — unsaved browser drags are invisible here.

"Collision" means geometric overlap between objects that are NOT logically
connected: edges connect their endpoints, skewers connect their members, and
those relationships (plus shared skewer membership) are excluded.
"""

from __future__ import annotations

import math
from typing import Any

from kge.models import Edge, Graph, SkewerGeom, View

NODE_RADIUS = 13.0  # ui NODE_SIZE / 2
RAIL_HALF_WIDTH = 3.0  # ui RAIL_WIDTH / 2
EDGE_HALF_WIDTH = 1.0  # ui edge width 2
SKEWER_TYPE = "skewer"
SKEWER_EDGE = "skewer-order"

Vec = tuple[float, float]
Seg = tuple[Vec, Vec]


# -- primitives ----------------------------------------------------------------


def _dist(p: Vec, q: Vec) -> float:
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _seg_point_dist(a: Vec, b: Vec, p: Vec) -> float:
    ab = (b[0] - a[0], b[1] - a[1])
    ap = (p[0] - a[0], p[1] - a[1])
    denom = ab[0] * ab[0] + ab[1] * ab[1]
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (ap[0] * ab[0] + ap[1] * ab[1]) / denom))
    return _dist((a[0] + t * ab[0], a[1] + t * ab[1]), p)


def _orient(a: Vec, b: Vec, c: Vec) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segs_intersect(a1: Vec, b1: Vec, a2: Vec, b2: Vec) -> bool:
    d1, d2 = _orient(a2, b2, a1), _orient(a2, b2, b1)
    d3, d4 = _orient(a1, b1, a2), _orient(a1, b1, b2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    return False  # collinear-touching cases fall through to distance checks


def _seg_seg_dist(s1: Seg, s2: Seg) -> float:
    if _segs_intersect(s1[0], s1[1], s2[0], s2[1]):
        return 0.0
    return min(
        _seg_point_dist(s1[0], s1[1], s2[0]),
        _seg_point_dist(s1[0], s1[1], s2[1]),
        _seg_point_dist(s2[0], s2[1], s1[0]),
        _seg_point_dist(s2[0], s2[1], s1[1]),
    )


# -- the view's geometry, mirroring ui/src/graph.ts ------------------------------


def visible_sets(graph: Graph, view: View) -> tuple[set[str], list[Edge]]:
    n_ov = set(view.nodeOverrides)
    e_ov = set(view.edgeOverrides)

    def node_type_checked(t: str) -> bool:
        return view.visibleNodeTypes is None or t in view.visibleNodeTypes

    def edge_type_checked(t: str) -> bool:
        return view.visibleEdgeTypes is None or t in view.visibleEdgeTypes

    # Included iff type checked XOR individually overridden.
    included = {
        n.id
        for n in graph.nodes
        if n.type != SKEWER_TYPE and (node_type_checked(n.type) != (n.id in n_ov))
    }
    nodes = included

    def edge_visible(e: Edge) -> bool:
        if e.type == SKEWER_EDGE:
            return False
        key = f"{e.type}|{e.src}|{e.dst}"
        shown = edge_type_checked(e.type) != (key in e_ov)
        return shown and e.src in nodes and e.dst in nodes

    foci = [f for f in view.foci if f.node in nodes]
    if foci:
        adj: dict[str, list[str]] = {}
        for e in graph.edges:
            if not edge_visible(e):
                continue
            adj.setdefault(e.src, []).append(e.dst)
            adj.setdefault(e.dst, []).append(e.src)
        # Union of the foci's k-hop neighborhoods (each focus its own radius).
        reach: set[str] = set()
        for f in foci:
            dist = {f.node: 0}
            queue = [f.node]
            while queue:
                cur = queue.pop(0)
                if dist[cur] >= f.kHops:
                    continue
                for nxt in adj.get(cur, []):
                    if nxt not in dist:
                        dist[nxt] = dist[cur] + 1
                        queue.append(nxt)
            reach |= dist.keys()
        nodes = {n for n in nodes if n in reach}

    # Eye adjustments on top of the focus: summon included items back, banish
    # shown ones. (Summoned edges still need both endpoints shown to render.)
    show = set(view.focusShow)
    hide = set(view.focusHide)
    nodes = (nodes | (show & included)) - hide

    def edge_shown(e: Edge) -> bool:
        return edge_visible(e) and f"{e.type}|{e.src}|{e.dst}" not in hide

    return nodes, [e for e in graph.edges if edge_shown(e)]


def skewer_members(graph: Graph) -> dict[str, list[str]]:
    """skewer id -> members ordered by skewer-order data.index.

    Dict order is ownership order (data.priority, then id) — the first skewer
    claiming a shared member places it on its straight baseline; other rails
    bend through it in the UI. Rail geometry here stays the straight baseline
    segment, so collision results near bent rails are approximate.
    """
    rows: list[tuple[float, str, list[str]]] = []
    for n in graph.nodes:
        if n.type != SKEWER_TYPE:
            continue
        pairs = [
            (e.data.get("index", i), e.dst)
            for i, e in enumerate(graph.edges)
            if e.type == SKEWER_EDGE and e.src == n.id
        ]
        prio = n.data.get("priority", 50)
        if not isinstance(prio, (int, float)):
            prio = 50
        rows.append((float(prio), n.id, [dst for _, dst in sorted(pairs)]))
    rows.sort(key=lambda r: (r[0], r[1]))
    return {sid: members for _, sid, members in rows}


def _default_geom(members: list[str], seed: dict[str, Any]) -> SkewerGeom:
    """Same derivation as ui defaultGeom, for skewers the view has no geometry for."""
    ps = [(seed[m].x, seed[m].y) for m in members if m in seed]
    if len(ps) >= 2:
        first, last = ps[0], ps[-1]
        half = 0.5 / max(len(ps) - 1, 1)
        return SkewerGeom.model_validate(
            {
                "a": {"x": first[0] - (last[0] - first[0]) * half, "y": first[1] - (last[1] - first[1]) * half},
                "b": {"x": last[0] + (last[0] - first[0]) * half, "y": last[1] + (last[1] - first[1]) * half},
            }
        )
    cx, cy = ps[0] if ps else (0.0, 0.0)
    length = 90.0 * max(len(members) - 1, 1)
    return SkewerGeom.model_validate(
        {"a": {"x": cx - length / 2, "y": cy}, "b": {"x": cx + length / 2, "y": cy}}
    )


def view_geometry(
    graph: Graph, view: View
) -> tuple[set[str], list[Edge], dict[str, Vec], dict[str, Seg], dict[str, str], list[str]]:
    """Everything placeable: (visible nodes, visible edges, node positions,
    rail segments, member->skewer (first wins), warnings)."""
    vis_nodes, vis_edges = visible_sets(graph, view)
    seed = view.layout.seedPositions
    skewer_type_checked = view.visibleNodeTypes is None or SKEWER_TYPE in view.visibleNodeTypes

    def skewer_hidden(sid: str) -> bool:
        # Per-skewer interpretation: the skewer node's own tree checkbox
        # (type checked XOR individually overridden).
        return skewer_type_checked == (sid in view.nodeOverrides)

    positions: dict[str, Vec] = {}
    rails: dict[str, Seg] = {}
    member_of: dict[str, str] = {}
    warnings: list[str] = []

    for sid, members in skewer_members(graph).items():
        if skewer_hidden(sid):
            continue
        vis_members = [m for m in members if m in vis_nodes and m not in member_of]
        if not vis_members:
            continue
        for m in vis_members:
            member_of[m] = sid
        geom = view.layout.skewers.get(sid) or _default_geom(members, seed)
        a: Vec = (geom.a.x, geom.a.y)
        b: Vec = (geom.b.x, geom.b.y)
        rails[sid] = (a, b)
        n = len(vis_members)
        # Baked fractions (the UI's spacing actions write them into the view);
        # members without one take their even slot.
        sk_frac = view.layout.memberFracs.get(sid, {})
        for i, m in enumerate(vis_members):
            t = sk_frac.get(m, (i + 0.5) / n)
            positions[m] = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    for nid in vis_nodes:
        if nid in positions:
            continue
        if nid in seed:
            positions[nid] = (seed[nid].x, seed[nid].y)
        else:
            warnings.append(f"{nid} has no saved position — skipped")

    return vis_nodes, vis_edges, positions, rails, member_of, warnings


# -- collisions -----------------------------------------------------------------


def find_collisions(graph: Graph, view: View, kind: str, obj_id: str) -> tuple[list[dict], list[str]]:
    """Objects that `obj_id` overlaps without being logically connected to.

    Returns (collisions sorted by overlap depth, warnings). Raises ValueError
    when the target can't be placed in this view.
    """
    _vis_nodes, vis_edges, positions, rails, _member_of, warnings = view_geometry(graph, view)
    members = skewer_members(graph)
    skewers_of: dict[str, set[str]] = {}
    for sid, ms in members.items():
        for m in ms:
            skewers_of.setdefault(m, set()).add(sid)

    def edge_key(e: Edge) -> str:
        return f"{e.type}|{e.src}|{e.dst}"

    # The target's shape (as (kind, segment-or-point, half-width)) and exclusions.
    excl_nodes: set[str] = set()
    excl_rails: set[str] = set()
    excl_edges: set[str] = set()

    if kind == "node":
        if obj_id not in positions:
            raise ValueError(f"{obj_id} is not placed in this view (hidden, or no saved position)")
        p = positions[obj_id]
        shape: Seg = (p, p)
        half = NODE_RADIUS
        excl_nodes.add(obj_id)
        for e in graph.edges:
            if e.src == obj_id:
                excl_nodes.add(e.dst)
                excl_edges.add(edge_key(e))
            if e.dst == obj_id:
                excl_nodes.add(e.src)
                excl_edges.add(edge_key(e))
        for sid in skewers_of.get(obj_id, ()):  # same-skewer members + own rails
            excl_rails.add(sid)
            excl_nodes.update(members[sid])
    elif kind == "skewer":
        if obj_id not in rails:
            raise ValueError(f"{obj_id} has no rail in this view (no visible members, or skewers hidden)")
        shape = rails[obj_id]
        half = RAIL_HALF_WIDTH
        excl_rails.add(obj_id)
        my_members = set(members.get(obj_id, ()))
        excl_nodes.update(my_members)
        for sid, ms in members.items():
            if my_members & set(ms):
                excl_rails.add(sid)
        for e in graph.edges:
            if e.src in my_members or e.dst in my_members:
                excl_edges.add(edge_key(e))
    elif kind == "edge":
        parts = obj_id.split("|")
        if len(parts) != 3:
            raise ValueError(f"not an edge key (type|from|to): {obj_id}")
        _etype, src, dst = parts
        if src not in positions or dst not in positions:
            raise ValueError(f"edge endpoints are not both placed in this view: {obj_id}")
        shape = (positions[src], positions[dst])
        half = EDGE_HALF_WIDTH
        excl_edges.add(obj_id)
        excl_nodes.update((src, dst))
        for e in graph.edges:
            if {e.src, e.dst} & {src, dst}:
                excl_edges.add(edge_key(e))
        for endpoint in (src, dst):
            excl_rails.update(skewers_of.get(endpoint, ()))
        warnings.append("edge target approximated as a straight segment (the UI may draw it as an arc)")
    else:
        raise ValueError(f"unknown kind: {kind}")

    out: list[dict] = []

    for nid, p in positions.items():
        if nid in excl_nodes:
            continue
        clearance = _seg_point_dist(shape[0], shape[1], p) - (half + NODE_RADIUS)
        if clearance < 0:
            out.append({"kind": "node", "id": nid, "overlap": round(-clearance, 1)})

    for sid, seg in rails.items():
        if sid in excl_rails:
            continue
        clearance = _seg_seg_dist(shape, seg) - (half + RAIL_HALF_WIDTH)
        if clearance < 0:
            out.append({"kind": "skewer", "id": sid, "overlap": round(-clearance, 1)})

    for e in vis_edges:
        key = edge_key(e)
        if key in excl_edges:
            continue
        if e.src not in positions or e.dst not in positions:
            continue
        seg = (positions[e.src], positions[e.dst])
        clearance = _seg_seg_dist(shape, seg) - (half + EDGE_HALF_WIDTH)
        if clearance < 0:
            out.append({"kind": "edge", "id": key, "overlap": round(-clearance, 1), "approx": True})

    out.sort(key=lambda c: -c["overlap"])
    return out, warnings

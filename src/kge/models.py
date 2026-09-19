"""The graph payload: what clients hold in memory and what GET/PUT /api/graph carries.

The same shape, minus runtime concerns, is what lands in the JSON files under
graph/ (see store.py). Layout hints live inside views, never on nodes/edges,
so agent edits to the graph don't touch layout and vice-versa.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TypeDef(BaseModel):
    color: str = ""
    description: str = ""
    family: str = ""  # grouping level above type in the visibility tree


class GraphSchema(BaseModel):
    nodeTypes: dict[str, TypeDef] = {}
    edgeTypes: dict[str, TypeDef] = {}


class Node(BaseModel):
    id: str
    type: str
    label: str = ""
    data: dict = {}


class Edge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: str
    src: str = Field(alias="from")
    dst: str = Field(alias="to")
    data: dict = {}

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.type, self.src, self.dst)


class Position(BaseModel):
    x: float
    y: float


class SkewerGeom(BaseModel):
    """Per-view geometry of one skewer: the segment its members lie on.

    Which nodes are on the skewer, and in what order, is graph knowledge
    (a `skewer` node plus `skewer-order` edges carrying `data.index`); where
    the segment sits, its angle and length (all encoded by the two endpoints)
    and whether layout may move it are per-view presentation.
    """

    a: Position
    b: Position
    pinned: bool = False


class Layout(BaseModel):
    engine: str = "fcose"
    seedPositions: dict[str, Position] = {}
    pinned: list[str] = []
    skewers: dict[str, SkewerGeom] = {}  # skewer node id -> geometry
    rules: list[dict] = []  # reserved: type-scoped (SetCoLa-style) rules


class Focus(BaseModel):
    node: str
    kHops: int = 2


class View(BaseModel):
    id: str
    name: str = ""
    visibleNodeTypes: list[str] | None = None  # None = all types checked
    visibleEdgeTypes: list[str] | None = None
    # Per-item exceptions: an item is shown iff its type is checked XOR it's
    # listed here. Checking/unchecking a type or family clobbers (clears) the
    # overrides beneath it. Edge overrides use the 'type|from|to' key.
    nodeOverrides: list[str] = []
    edgeOverrides: list[str] = []
    focus: Focus | None = None
    # Eye adjustments: manual display tweaks layered on top of the focus —
    # summon items the focus banished (focusShow) or banish shown ones
    # (focusHide). Distinct from inclusion: adjusted items stay part of the
    # view's data. A focus recenter (walk step / hops change) clears both.
    focusShow: list[str] = []  # node ids or edge keys
    focusHide: list[str] = []
    layout: Layout = Layout()


class SelSlot(BaseModel):
    """One selection slot. Edge ids use the edge key form 'type|from|to'."""

    kind: Literal["node", "edge", "skewer"]
    id: str


class SelectionState(BaseModel):
    """The shared UI selection: primary is the latest click, secondary trails it.

    Transient collaboration state, held in server memory only (never written to
    the graph files): the browser publishes it so agents can ask 'what pair is
    the human looking at?' via `kge selection`. Last writer wins.
    """

    primary: SelSlot | None = None
    secondary: SelSlot | None = None
    view: str | None = None  # the view the browser is showing (for geometry queries)


class Graph(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    graph_schema: GraphSchema = Field(alias="schema", default_factory=GraphSchema)
    nodes: list[Node] = []
    edges: list[Edge] = []
    views: list[View] = []

    def validate_semantics(self) -> list[str]:
        """Semantic errors that should reject a save (shape errors are pydantic's job)."""
        errors: list[str] = []
        node_ids: set[str] = set()
        for n in self.nodes:
            if n.id in node_ids:
                errors.append(f"duplicate node id: {n.id}")
            node_ids.add(n.id)
            if n.type not in self.graph_schema.nodeTypes:
                errors.append(f"node {n.id}: unknown node type '{n.type}' (add it to the schema)")
        node_types = {n.id: n.type for n in self.nodes}
        edge_keys: set[tuple[str, str, str]] = set()
        for e in self.edges:
            if e.key in edge_keys:
                errors.append(f"duplicate edge: {e.type} {e.src} -> {e.dst}")
            edge_keys.add(e.key)
            if e.type not in self.graph_schema.edgeTypes:
                errors.append(f"edge {e.src} -> {e.dst}: unknown edge type '{e.type}'")
            for endpoint in (e.src, e.dst):
                if endpoint not in node_ids:
                    errors.append(f"edge {e.type} {e.src} -> {e.dst}: no such node '{endpoint}'")
            if e.type == "skewer-order" and node_types.get(e.src) not in (None, "skewer"):
                errors.append(f"skewer-order edge must originate from a skewer node, not {e.src}")
        view_ids: set[str] = set()
        for v in self.views:
            if v.id in view_ids:
                errors.append(f"duplicate view id: {v.id}")
            view_ids.add(v.id)
        return errors

    def prune_layout_refs(self) -> None:
        """Drop layout/focus references to nodes that no longer exist.

        Hints degrade by omission (a chain just skips missing links), so a node
        deleted by one client must not fail another client's save.
        """
        node_ids = {n.id for n in self.nodes}
        edge_keys = {f"{e.type}|{e.src}|{e.dst}" for e in self.edges}
        for v in self.views:
            lay = v.layout
            lay.seedPositions = {k: p for k, p in lay.seedPositions.items() if k in node_ids}
            lay.pinned = [n for n in lay.pinned if n in node_ids]
            lay.skewers = {k: geom for k, geom in lay.skewers.items() if k in node_ids}
            v.nodeOverrides = [n for n in v.nodeOverrides if n in node_ids]
            v.edgeOverrides = [k for k in v.edgeOverrides if k in edge_keys]
            v.focusShow = [i for i in v.focusShow if i in node_ids or i in edge_keys]
            v.focusHide = [i for i in v.focusHide if i in node_ids or i in edge_keys]
            if v.focus and v.focus.node not in node_ids:
                v.focus = None

# Persisting Manual Graph Layouts Under Filtering: Prior Art, Tooling, and a Recommended Architecture

> Deep-research report (Sept 2026) that informed kge's design. The
> constraint-hint proposal in "Recommendations" was subsequently superseded
> by the **skewer** model (see README.md), which keeps the report's central
> conclusion — persist relative structural intent, not absolute coordinates —
> but reifies it as graph data (skewer + skewer-order edges) with per-view
> geometry, instead of fcose constraint hints.

## TL;DR
- **Persist relative structural hints, not absolute coordinates.** The right primitive for your "the column stays a column, in the same order, even after nodes are hidden" requirement is a small set of **alignment groups + relative-ordering (before/after) constraints**, re-materialized by a constraint-aware layout engine at render time. This is exactly what `cytoscape.js-fcose` (alignment + relative-placement constraints) and WebCoLa/SetCoLa were built to do, and it degrades gracefully when intervening nodes are hidden or when agents add un-hinted nodes.
- **Best-fit OSS stack: Cytoscape.js (data model + renderer + type filtering) + fcose (constraint-seeded layout), with elkjs as a layered-layout fallback.** Cytoscape.js is the only mature, MIT-licensed, TypeScript-typed library that combines interactive editing, native show/hide by type, k-hop neighborhood selectors, per-element metadata, and a layout adapter that accepts persistable relative constraints. React Flow is the strongest alternative if you want React-component nodes, but you supply your own layout/filtering logic.
- **The academic literature is a caution, not a mandate:** "mental map preservation" is intuitively appealing but empirically weak. Per Archambault & Purchase (IJHCS 2013), "To date, no experiment has found conclusive evidence that supports the effectiveness of the mental map in the comprehension of a dynamic graph series," and "No experiment has found a positive effect of the mental map on undirected graphs." So build the *cheapest* thing that preserves the user's intent (ordering + alignment), store coordinates as a fallback seed, and don't over-invest in a full constraint solver.

## Key Findings

1. **"Mental map preservation" is a real, named research area — but the evidence that it helps users is surprisingly thin.** The canonical definition (Coleman & Parker; Eades, Lai, Misue & Sugiyama 1991, "Preserving the mental map of a diagram") is "the placement of existing nodes and edges should change as little as possible when a change is made to the graph." Archambault & Purchase's experiments (IJHCS 2013 and GD 2012) found *no conclusive general benefit* — verbatim, "To date, no experiment has found conclusive evidence that supports the effectiveness of the mental map," with orientation/"find-by-name" tasks being the main place it helps. Takeaway: preserve the user's *explicit intent* (the column, the order) cheaply; don't chase pixel-stability for its own sake.

2. **Constraint-based layout is the mature, directly-applicable body of prior art.** WebCoLa (cola.js, from Tim Dwyer's Monash lab) does browser constraint layout via separation/alignment constraints; SetCoLa (Hoffswell, Borning, Heer, EuroVis 2018 / Computer Graphics Forum 37(3):537–548) is a DSL that compiles *high-level, data-relative* constraints down to WebCoLa instance constraints — it is "a domain-specific language for specifying high-level constraints relative to properties of the backing data. Users identify node sets based on data or graph properties and apply high-level constraints within each set," which "facilitates reapplication of customized layouts across distinct graphs." Crucially, SetCoLa's own authors flag the open problem you care about: "Generate constraints from local interactions... understand and explicitly list users['] constraints from their interactions or modifications on graph layout" and "Given one constrained layout and an original layout, is it possible to extract the constraints?"

3. **Two shipping libraries already persist *relative* constraints, not just coordinates.** `cytoscape.js-fcose` supports three constraint types you can serialize verbatim to JSON: **fixed-node**, **alignment** (`['n1','n2','n3']`, "given in most compact form"), and **relative placement** (`{top:'n1', bottom:'n2', gap:100}` / `{left, right, gap}`). The docs explicitly note these "can also be added incrementally on a given layout while maintaining the user's mental map." ELK's *layered* algorithm supports semi-interactive constraints — `layerChoiceConstraint`, `positionChoiceConstraint`, `crossingMinimization.semiInteractive`, and (per ELK's 2023 blog) forthcoming relative `inLayerPredOf`/`inLayerSuccOf`. dagre supports layer assignment and — in the `dagrejs` fork — `keepNodeOrder`/`nodeOrder` for in-layer ordering.

4. **Existing tools overwhelmingly persist coordinates, not constraints.** yEd/GraphML stores explicit `<y:Geometry x=.. y=.. width=.. height=..>` per node; draw.io/mxGraph stores `mxGeometry`; Graphviz uses `pos` + `pin`/`-n` to fix coordinates. Neo4j Bloom "Scenes" save node positions (including a "coordinate layout" that "arranges, and fixes, the nodes... by their integer" coordinates) inside "Perspectives." Kumu has "fixed vs floating" elements and saves views. **None of these persist user-derived *relative* constraints** — they either save absolute positions or re-run a fresh force layout. So your instinct (relative > absolute) is genuinely under-served by existing tooling, and fcose/CoLa are the exceptions worth copying.

5. **For the JS/TS framework layer, Cytoscape.js is the best all-round OSS fit; React Flow wins only if you need React-component nodes.** Cytoscape.js is MIT, TypeScript-typed, handles thousands of elements, has first-class `.hide()`/`.show()` and rich selectors for type filtering and k-hop neighborhoods (`node.neighborhood()`, `.closedNeighborhood()`, `bfs`), per-element `data()` for evidence notes, and native adapters for fcose/cola/elk/dagre.

## Details

### The problem restated, and why relative beats absolute
Your requirement has two moving parts that fight each other: (a) the user manually arranges a set of nodes (a column, in a specific order) and expects that to *persist*; (b) the view then filters — toggling types off, or focusing to k hops — which should let the drawing *compact*, closing the gaps left by hidden nodes, **without** scrambling the arrangement. Absolute coordinates satisfy (a) but break (b): if you hide the three nodes between A and B, their saved Y-coordinates leave a hole, or worse, an unrelated node re-layout collides. What survives filtering is the *relational* content of the arrangement: "these five nodes are vertically aligned" and "A is above B is above C." That is precisely an **alignment group** plus a **total order** (a chain of relative-placement constraints). Re-running a constraint-aware layout on the *visible* subgraph, seeded with only the constraints whose endpoints are still visible, gives you a compacted column in the same order.

### Academic prior art (summarized, not just cited)
- **Eades, Lai, Misue, Sugiyama (1991), "Preserving the mental map of a diagram"** — origin of the term; defines mental map via orthogonal ordering, proximity, and topology. The "orthogonal ordering" component (relative up/down/left/right relationships between nodes) is the theoretical justification for storing *order* rather than *position*.
- **Archambault & Purchase, "The map in the mental map" (IJHCS 71(11), 2013) and "Mental Map Preservation Helps User Orientation in Dynamic Graphs" (GD 2012)** — the empirical reality check. Across many experiments "no experiment has found conclusive evidence" of a general benefit, and specifically "no experiment has found a positive effect of the mental map on undirected graphs"; the GD 2012 paper did find a benefit for *orientation/map-based* tasks. Interpretation for you: your users' hand-built columns are semantic ("these endpoints all read the billing table"), so preserving *that* grouping matters more than pixel stability.
- **Dwyer, Koren, Marriott — IPSep-CoLa (2006)** — the incremental separation-constraint algorithm underneath WebCoLa; supports "incremental" re-layout that keeps existing positions stable while satisfying separation constraints. This is the algorithmic core of "re-layout locally but stay close to what the user had."
- **SetCoLa (Hoffswell, Borning, Heer, EuroVis 2018)** — the most directly relevant. It lets you declare constraints over *node sets* selected by data properties ("all `endpoint:*` nodes align vertically", "order by field"), which generalize across graph edits — important because your agents add nodes that should slot into existing rules without per-node hinting.

### Constraint / layout engines, with persistence and maintenance status (as of Sept 2026)
- **cytoscape.js-fcose** — fast compound spring embedder with **fixed / alignment / relative-placement** constraints; alignment must be given in compact form (`['n1','n2','n3']`). MIT. **Maintenance caveat: latest is 2.2.0, last published ~4 years ago on npm and flagged by Snyk as effectively dormant** — it "hasn't seen any new versions released to npm in the past 12 months, and could be considered as a discontinued project, or that which receives low attention from its maintainers." It still works against the actively-maintained Cytoscape.js core (3.34.3, published ~11 days ago as of Sept 2026), but you should budget for maintaining a fork.
- **WebCoLa / cola.js** — the constraint-layout pioneer; supports alignment and inequality separation constraints, an `avoidOverlaps` mode, and a d3 adaptor. **Effectively abandoned: latest npm `webcola` is 3.4.0, last published ~7 years ago; Snyk marks maintenance "Inactive."** A Rust/WASM fork (`webcola-wasm`) claims up to 4× speedups but is incomplete — notably "Setting .constraints on the layout doesn't work either." Use CoLa's *ideas*; be wary of depending on the library.
- **elkjs (Eclipse Layout Kernel, GWT-compiled to JS)** — actively maintained (0.12.0, published ~1 month ago). Its *layered* algorithm supports **semi-interactive** layout: you set `cycleBreaking.strategy: INTERACTIVE`, `layering.strategy: INTERACTIVE`, `crossingMinimization.semiInteractive: true`, plus per-node `layerChoiceConstraint`/`positionChoiceConstraint`; relative in-layer constraints (`inLayerPredOf`/`inLayerSuccOf`) are on the roadmap. Best when your graph is naturally directed/layered (CALLS/READS/HANDLES often is).
- **dagre / @dagrejs/dagre** — the `dagrejs` org fork is active (3.1.0/3.1.1, published within days–1 month as of Sept 2026); original `dagre` (0.8.5) is dead. Supports manual `layer`/rank assignment and `keepNodeOrder`+`nodeOrder` for in-layer ordering. Classic graphviz-style `rank=same` was never fully ported (open issues #54, #159). Lighter-weight than ELK but less expressive on constraints.

### Serialization formats — what everyone actually stores
- **GraphML (yEd)**: absolute geometry per node (`<y:Geometry height width x y/>`). Version-control-friendly XML but coordinate-based.
- **draw.io / mxGraph**: `mxGeometry` (x, y, width, height) per cell.
- **Graphviz**: `pos` attribute (+ `pin=true` / `neato -n`) to fix/restore coordinates; `notranslate=true` to avoid origin shifts. Pure coordinate pinning.
- **Neo4j Bloom**: "Perspectives" (type/category config, styling, saved Cypher, filters) are serializable to JSON; "Scenes" store node positions; a "coordinate layout" fixes nodes by integer coords. Perspective = *view config*; Scene = *positions*. Good separation-of-concerns model to copy, but positions are absolute.
- **Kumu**: "views" (decorations/filters, CSS-like stylesheet) separate from element data; elements can be "fixed" or "floating." Again view-config + positions, not relative constraints.

**Conclusion:** the ecosystem norm is *coordinates or a fresh force layout*. Persisting relative constraints is rare enough that fcose/CoLa/SetCoLa are essentially the reference implementations.

### The framework shortlist, scored against your seven criteria
- **Cytoscape.js (+ fcose/elk/dagre adapters)** — MIT, TypeScript typings, actively maintained core (3.34.3). Editable via `cy.add()`/`cy.remove()`; native `.hide()/.show()` and powerful selectors for **type filtering** (`node[type="endpoint"]`) and **k-hop** (`ele.neighborhood()`, `.closedNeighborhood()`, `cy.elements().bfs()`); typed styling via selectors; per-element `data()` for evidence notes (tooltip via `popper`/`cytoscape-popper`); handles low-thousands of elements on canvas. **This is the recommended base.** Its one weakness — fcose being dormant — is manageable because the constraint format is simple and stable.
- **React Flow / @xyflow/react** — MIT, TypeScript-first, very actively maintained (12.11.6, published ~17 days ago; React Flow 12 shipped Oct 2025). Superb for **editable, React-component nodes** with inputs/inspectors, custom edges, MiniMap/Controls. **But:** no built-in graph-theoretic layout (you bring dagre/elk/d3-force), no built-in type/k-hop filtering (you compute visible sets yourself), and DOM-per-node performance degrades toward the upper end of your 1–5k range without virtualization. Choose it if node UIs matter more than layout automation.
- **Sigma.js + graphology** — MIT, TypeScript, actively maintained (3.0.3, Apr 2026; v4 alpha in progress). WebGL renderer that comfortably exceeds your node budget; graphology gives you the data model, k-hop traversal, and metrics. **But** it's a *renderer*, not an editor — interactive create/delete and inspectors are DIY, and custom rendering is "way harder" than SVG/canvas. Overkill for ≤5k nodes unless you expect big growth.
- **AntV G6 v5** — MIT, TypeScript-first, actively maintained (5.1.1, May 2026). Batteries-included: many layouts, combos (compound nodes), behaviors (drag/collapse/create-edge), Canvas/SVG/WebGL. Strong option; the main cost is a larger, faster-moving API surface and Chinese-first (though translated) docs.
- **AntV X6** — the diagram/editor sibling of G6 (node-edge editing, ports); good for editor UX but less graph-analytics-oriented.
- **JointJS (@joint/core)** — open-source core, actively maintained, first-class TypeScript and native React support; the powerful stencils/inspectors/layouts live in the **commercial JointJS+**. Great for diagramming UX; layout constraint persistence is DIY.
- **vis-network** — actively maintained (10.1.2, ~1 month ago; Snyk rates maintenance "Healthy"), easy, editable, has physics + hierarchical layout and built-in show/hide. TypeScript typings exist but the API is JS-first and dated; no relative-constraint layout. Fine for a quick MVP, weaker for your constraint requirement.
- **Rete.js** — node-editor framework (dataflow/rete-style), core `rete` 2.0.6 with actively updated plugins. Wrong shape for a knowledge-graph viewer (it's for wired node programs), so **not recommended** here.
- **tldraw** — excellent infinite-canvas SDK (TypeScript, React, custom shapes + **bindings** that survive edits/copy). **License caveat: tldraw is *not* OSS for production — "Production use requires a license key"** under the tldraw license (starter kits are MIT). Viable as a *canvas substrate* if you want a Figma-like feel and will build graph semantics + layout yourself, but you'd reimplement a lot Cytoscape gives free.

### Commercial options
- **GoJS (Northwoods)** — public per-developer, perpetual pricing (confirmed on gojs.net/latest/pricing): **Team $6,990** (up to 3 developers), **Group $11,950** (up to 20 developers), **Individual $3,995**, **Enterprise** by quote (unlimited developers); "no runtime fees or royalties." Canvas/SVG only. Excellent editing + layout API.
- **yFiles for HTML (yWorks)** — public term (annual) pricing (confirmed on yfiles.com/pricing.html): **Single Developer $11,000/yr, Project $22,000/yr, Site $66,000/yr** (net prices, USD outside the Eurozone; EUR equivalents €9,200 / €18,400 / €55,200). The most capable layout engine on the market (including interactive/incremental layouts) — but expensive and proprietary.
- **Ogma (Linkurious)** — quote-only SDK; no public per-developer list price (an AWS Marketplace listing shows a fixed **$5,000/month** subscription). WebGL, large-graph focused, strong for KG exploration.
- **KeyLines/ReGraph (Cambridge Intelligence)** — commercial JS/React graph SDKs (quote-only) often used for KG apps; worth a look for combos + incremental arrange if budget allows. (Incremental-layout specifics unverified within research budget — treat as lower-confidence.)

### KG editors/viewers — design ideas worth stealing
- **Bloom's Perspective/Scene split** is the cleanest mental model: a *Perspective* = reusable view config (which types are shown, styling, filters, saved queries); a *Scene* = the current spatial arrangement. Adopt this split in your JSON: layout hints belong to a named *view/perspective*, not to the canonical node records.
- **Kumu's fixed-vs-floating** per-element flag is a nice UX primitive: let the user "pin" a node (store a hint) while everything else re-flows.
- **Obsidian's graph view** deliberately does *not* save node positions (long-standing top feature request "Save Node Positions in Graph View") — a cautionary example of users hating pure re-layout with no persistence. Don't ship that.
- **Gephi Lite** persists layout via GEXF coordinates but notoriously *loses* appearance/size on reload (issue #113) — a reminder to version your hint schema and round-trip it fully.

## Recommendations

**Stage 1 — Ship coordinates-as-seed first (1–2 weeks).**
Adopt Cytoscape.js + fcose. Persist, per node, the last manual `{x,y}` **and** a `pinned: boolean`. On load of an unfiltered view, place nodes at saved coordinates (no layout run). This gives immediate "it looks like I left it" behavior and is trivial to implement. Store these hints in a **separate `layout` block / named view object** in your JSON (Bloom-style Perspective/Scene split), never mixed into the canonical node/edge records, so agent edits to the graph don't touch layout and vice-versa.

**Stage 2 — Derive relative constraints from the manual arrangement (the core of your ask).**
When the user saves, **infer constraints from geometry** rather than (or in addition to) storing raw coordinates:
- **Alignment groups:** cluster nodes whose x (or y) coordinates fall within a tolerance into a vertical (or horizontal) alignment group → store as `{axis:'x', nodes:[ids...]}`.
- **Order chains:** within a group, sort by the cross-axis coordinate and store the resulting **total order** as a relative-placement chain (`{before:'A', after:'B'}`, …). This is what makes "the column stays a column, in the same order" survive hiding of intervening members.
- Keep coordinates as a **fallback seed** for un-constrained nodes and for initial placement.

On render, translate the stored alignment/order hints into fcose `alignmentConstraint` + `relativePlacementConstraint` (or WebCoLa alignment + separation constraints), **filtered to currently-visible nodes**, and run fcose seeded from saved positions. Hidden intervening nodes simply drop out of the chain, so the visible members compact while preserving order. This is the "store coordinates but re-layout locally with constraints derived from them" pragmatic answer — and yes, that is the recommended answer.

**Stage 3 — Generalize with type-scoped (SetCoLa-style) rules for agent-inserted nodes.**
Because agents add nodes without hints, add a small layer of **data-relative rules** ("all `table:*` nodes align in a right-hand column", "order `endpoint:cos:v3/*` by name"). New nodes matching a rule inherit the arrangement automatically — solving the "insertion by agents who don't set hints" degradation. This mirrors SetCoLa's node-set constraints; you don't need the SetCoLa compiler, just a rule→fcose-constraint mapping.

**Honest trade-offs of each hint type:**
| Hint | Survives node insertion by agents | Survives hidden/deleted referents | Impl. effort |
|---|---|---|---|
| Absolute coordinates | Poorly (holes/overlaps) | Poorly (holes) | Trivial |
| Pinned nodes only | OK (unpinned reflow) | OK | Trivial |
| Alignment groups | Medium (new nodes ignored unless ruled) | Well (drop missing ids) | Low |
| Relative order chains | Medium | **Well** (skip missing links in chain) | Low–Medium |
| Layer/rank assignment (ELK/dagre) | Medium | Well | Medium |
| SetCoLa-style data rules | **Well** (new nodes auto-match) | Well | Medium–High |
| Full constraint solver (CoLa) | Well | Well | High |

**Benchmarks that should change the plan:**
- If your graph routinely exceeds ~3–5k visible nodes, switch the *renderer* to Sigma.js/graphology (WebGL) while keeping the same hint schema and computing constraints in graphology.
- If your edges are strongly directional and users think in layers, prefer **elkjs layered** with `layerChoiceConstraint`/`positionChoiceConstraint` over fcose.
- If fcose's dormancy becomes a maintenance risk (unpatched Cytoscape.js breakage), vendor a fork or migrate the constraint logic onto elkjs/CoLa-wasm.

## Caveats
- **Mental-map preservation is empirically weak.** Don't sell (or over-engineer) pixel-stability; the defensible win is preserving *explicit user intent* (groups + order), which is cheap.
- **fcose and WebCoLa carry maintenance risk.** fcose (2.2.0, ~4 years since last npm publish) and WebCoLa (3.4.0, ~7 years) have both been effectively static for years and Snyk flags them as inactive/dormant. Their constraint *formats* are stable and simple, which mitigates the risk, but plan to own the code.
- **Constraint solvers can conflict.** User-drawn arrangements can produce over-constrained or contradictory constraint sets (e.g., a node in two alignment groups on the same axis). You'll need a reconciliation/priority step; fcose resolves best-effort but may violate soft constraints silently.
- **Deriving constraints from geometry is heuristic.** Tolerance thresholds for "these are aligned" and "this is a column vs. a cluster" will need tuning, and mis-inference will occasionally re-arrange something the user didn't mean as a group. Offer an explicit "group these / pin this" affordance so intent can be stated rather than only inferred.
- **Pricing figures** for commercial tools are as of Sept 2026 and (for Ogma especially) are quote-driven; confirm directly with vendors before budgeting.
- Cambridge Intelligence (KeyLines/ReGraph) incremental-layout specifics and a couple of maintenance edge-cases were not verified within research budget; those points are lower-confidence.

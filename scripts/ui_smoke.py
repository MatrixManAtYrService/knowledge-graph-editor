"""Browser smoke test: the read path and an edit round trip, live and static.

    uv run --with websockets python scripts/ui_smoke.py ~/src/skills-ebb-knowledge-graph/graphs/ebb
    uv run --with websockets python scripts/ui_smoke.py graph --view default

Works on a temporary copy of the graph directory (the original is never
written) and starts its own servers:

1. Live editor (`kge serve`): open `#g=<id>&v=<view>`, wait for the layout.
2. Edit through the UI's store (window.__kgeStore, the same actions the
   buttons call): add a node next to one the view shows, connect them, set
   data on the new node, save (ops; the page reloads the graph after).
3. Check the graph files on disk, reload the page, and check the edit
   survived: in the store, and on the canvas if the view showed it before.
   Then edits around what the page never loaded: relabel a node without its
   full data, delete one whose edges aren't all loaded, while an outside
   writer edits a third — nothing unloaded or outside may be lost.
4. Export the edited copy (`kge export`), serve it read-only, open the same
   view, and require the same rendered counts and the new node on canvas.

Any page exception or console.error fails the run. Exits nonzero on failure.
Speed is ui_timing.py's job; this checks correctness only.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ui_timing import Cdp, browser_page, wait_for_status  # noqa: E402

LAYOUT_DONE = r"^layout: "
KGE = [sys.executable, "-c", "from kge.cli import main; main()"]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def kge_server(*args: str):
    """`kge serve <args>` on a free port; yields its base URL."""
    port = free_port()
    proc = subprocess.Popen(
        [*KGE, "serve", *args, "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    base = f"http://127.0.0.1:{port}/"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base)
                break
            except OSError:
                if proc.poll() is not None:
                    raise SystemExit(f"kge serve exited: {proc.stderr.read().decode()}")
                time.sleep(0.1)
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=10)


class Checks:
    def __init__(self):
        self.failed = 0

    def __call__(self, ok: bool, what: str) -> bool:
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
        if not ok:
            self.failed += 1
        return ok


def read_list(path: Path, key: str) -> list[dict]:
    return json.loads(path.read_text())[key]


def page_errors(events: list) -> list[str]:
    out = []
    for m in events:
        p = m.get("params", {})
        if m.get("method") == "Runtime.exceptionThrown":
            d = p.get("exceptionDetails", {})
            out.append(d.get("exception", {}).get("description") or d.get("text", "exception"))
        elif m.get("method") == "Runtime.consoleAPICalled" and p.get("type") == "error":
            out.append(" ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", [])))
    return out


async def open_view(cdp: Cdp, url: str, timeout: float) -> dict:
    """Navigate (a fresh document even if only the hash differs) and wait for the layout."""
    await cdp.call("Page.navigate", url="about:blank")
    await cdp.call("Page.navigate", url=url)
    t0 = time.time()
    while True:
        ok, state = await wait_for_status(cdp, LAYOUT_DONE, min(2, timeout), t0=time.time())
        if ok or state.get("drawn") == "saved" or time.time() - t0 > timeout:
            break
    if not (ok or state.get("drawn") == "saved"):
        raise SystemExit(f"no finished layout at {url}: {state}")
    return state


ON_CANVAS_JS = """(() => {
  const el = [...document.querySelectorAll('div')].find(d => d._cyreg)
  const cy = el._cyreg.cy
  const node = cy.getElementById(%(node)s).nonempty()
  const edge = cy.edges().some(e => e.source().id() === %(from)s && e.target().id() === %(to)s
                                   && e.data('etype') === %(etype)s)
  return { node, edge }
})()"""


async def on_canvas(cdp: Cdp, node: str, frm: str, to: str, etype: str, settle: float = 5) -> dict:
    """Whether the node and edge are drawn, polling up to `settle` seconds for
    both (a save reloads the graph, and the canvas follows asynchronously)."""
    js = ON_CANVAS_JS % {k: json.dumps(v) for k, v in
                         {"node": node, "from": frm, "to": to, "etype": etype}.items()}
    t0 = time.time()
    while True:
        r = await cdp.eval(js)
        if (r["node"] and r["edge"]) or time.time() - t0 > settle:
            return r
        await asyncio.sleep(0.25)


async def run(args) -> int:
    check = Checks()
    src = Path(args.graph_dir).resolve()
    graph_id = src.name
    with tempfile.TemporaryDirectory() as tmp:
        gdir = Path(tmp) / graph_id
        shutil.copytree(src, gdir)
        hash_ = f"#g={graph_id}&v={args.view}"
        token = uuid.uuid4().hex[:8]
        new_id = f"smoke:{token}"
        events: list = []
        async with browser_page(events) as cdp:
            # -- live editor -------------------------------------------------
            print(f"live: {graph_id} / {args.view}")
            with kge_server("--graph-dir", str(gdir)) as base:
                before = await open_view(cdp, base + hash_, args.timeout)
                check(bool(before["nodes"]), f"view renders ({before['nodes']} nodes, {before['edges']} edges)")
                # Anchor the new node on something the view shows, with its type
                # and an edge type the schema has, so the edit lands in view.
                anchor = await cdp.eval("""(() => {
                  const st = window.__kgeStore.getState()
                  const cy = [...document.querySelectorAll('div')].find(d => d._cyreg)._cyreg.cy
                  const shown = st.graph.nodes.find(n => n.type !== 'skewer' && cy.getElementById(n.id).nonempty())
                  const p = cy.getElementById(shown.id).position()
                  return { id: shown.id, type: shown.type, pos: { x: p.x + 60, y: p.y + 60 },
                           etype: st.connectEdgeType }
                })()""")
                etype = anchor["etype"]
                frm, to = new_id, anchor["id"]
                await cdp.eval(f"""(async () => {{
                  const S = window.__kgeStore
                  S.getState().addNode({json.dumps(anchor['type'])}, {json.dumps(new_id)}, 'smoke test',
                                       {json.dumps(anchor['pos'])})
                  S.getState().setNodeProps({json.dumps(new_id)}, {{ data: {{ smoke: {json.dumps(token)} }} }})
                  S.setState({{ primary: {{ kind: 'node', id: {json.dumps(to)} }},
                               secondary: {{ kind: 'node', id: {json.dumps(frm)} }} }})
                  S.getState().connect()
                  // A filtered view may hide the new items: include them per item
                  // (also checks overrides survive save and export).
                  const edgeId = S.getState().primary.id
                  await new Promise(r => setTimeout(r, 600))
                  const cy = [...document.querySelectorAll('div')].find(d => d._cyreg)._cyreg.cy
                  if (cy.getElementById({json.dumps(new_id)}).empty()) S.getState().toggleOverride('node', {json.dumps(new_id)})
                  if (cy.getElementById(edgeId).empty()) S.getState().toggleOverride('edge', edgeId)
                  await new Promise(r => setTimeout(r, 600))
                  await S.getState().save()
                  return S.getState().status
                }})()""")
                status = await cdp.eval("window.__kgeStore.getState().status")
                dirty = await cdp.eval("window.__kgeStore.getState().dirty")
                check(not dirty and status.startswith("saved"), f"save ({status})")
                shown_before = await on_canvas(cdp, new_id, frm, to, etype)
                check(shown_before["node"] and shown_before["edge"], "edit on canvas before reload")

                nodes = read_list(gdir / "nodes.json", "nodes")
                edges = read_list(gdir / "edges.json", "edges")
                disk = next((n for n in nodes if n["id"] == new_id), None)
                check(disk is not None and disk.get("data", {}).get("smoke") == token, "node + data on disk")
                check(any(e["type"] == etype and e["from"] == frm and e["to"] == to for e in edges),
                      "edge on disk")

                after = await open_view(cdp, base + hash_, args.timeout)
                # Loaded rows carry lite data only; pull the full payload the
                # way the inspector does.
                stored = await cdp.eval(f"""(async () => {{
                  const S = window.__kgeStore
                  await S.getState().hydrateSel({{ kind: 'node', id: {json.dumps(new_id)} }})
                  const g = S.getState().graph
                  const n = g.nodes.find(n => n.id === {json.dumps(new_id)})
                  return {{ data: n ? n.data : null,
                           edge: g.edges.some(e => e.from === {json.dumps(frm)} && e.to === {json.dumps(to)}
                                                && e.type === {json.dumps(etype)}) }}
                }})()""")
                check((stored["data"] or {}).get("smoke") == token, "after reload: node + data in store")
                check(stored["edge"], "after reload: edge in store")
                shown_after = await on_canvas(cdp, new_id, frm, to, etype)
                if shown_before["node"]:
                    check(shown_after["node"], "after reload: node on canvas")
                    check(shown_after["edge"] == shown_before["edge"], "after reload: edge on canvas")
                else:
                    print("  (the view hides the new node; canvas checks skipped)")

                # Edits that must not lose anything the page never loaded:
                # relabel a node without pulling its full data; meanwhile an
                # outside writer (an agent, a sync) edits another node; then
                # delete a third node whose edges aren't all loaded.
                pick = await cdp.eval(f"""(() => {{
                  const st = window.__kgeStore.getState()
                  const cy = [...document.querySelectorAll('div')].find(d => d._cyreg)._cyreg.cy
                  const shown = st.graph.nodes.filter(n => n.type !== 'skewer' && n.id !== {json.dumps(to)}
                                                         && n.id !== {json.dumps(new_id)} && cy.getElementById(n.id).nonempty())
                  return shown.length >= 2 ? [shown[0].id, shown[1].id] : null
                }})()""")
                if pick is None:
                    print("  (fewer than 3 nodes shown; partial-load checks skipped)")
                else:
                    relabel, victim = pick
                    disk_nodes = {n["id"]: n for n in read_list(gdir / "nodes.json", "nodes")}
                    outsider = next(i for i in disk_nodes if i not in (relabel, victim, new_id, to))
                    req = urllib.request.Request(
                        f"{base}api/graphs/{graph_id}/ops", method="POST",
                        headers={"Content-Type": "application/json"},
                        data=json.dumps({"ops": [{"op": "patch_node", "id": outsider,
                                                  "set": {"outside": token}}]}).encode())
                    urllib.request.urlopen(req).read()
                    await cdp.eval(f"""(async () => {{
                      const S = window.__kgeStore
                      S.getState().setNodeProps({json.dumps(relabel)}, {{ label: 'relabeled {token}' }})
                      S.getState().deleteItems([{json.dumps(victim)}], [])
                      await S.getState().save()
                    }})()""")
                    status = await cdp.eval("window.__kgeStore.getState().status")
                    check("also changed" in status, f"save reports the outside change ({status})")
                    nodes2 = {n["id"]: n for n in read_list(gdir / "nodes.json", "nodes")}
                    edges2 = read_list(gdir / "edges.json", "edges")
                    check(nodes2[relabel]["label"] == f"relabeled {token}"
                          and nodes2[relabel]["data"] == disk_nodes[relabel]["data"],
                          "relabel kept the node's unloaded data")
                    check(nodes2.get(outsider, {}).get("data", {}).get("outside") == token,
                          "outside writer's edit survived the save")
                    check(victim not in nodes2 and not any(victim in (e["from"], e["to"]) for e in edges2),
                          "delete removed the node and all its edges")
                    after = await open_view(cdp, base + hash_, args.timeout)
                live_counts = (after["nodes"], after["edges"])

            # -- static export ------------------------------------------------
            print(f"static: {graph_id} / {args.view}")
            site = Path(tmp) / "site"
            subprocess.run([*KGE, "export", "--graph-dir", str(gdir),
                            "--out", str(site)], check=True, stdout=subprocess.DEVNULL)
            with kge_server("--readonly", "--dir", str(site)) as base:
                st = await open_view(cdp, base + hash_, args.timeout)
                check((st["nodes"], st["edges"]) == live_counts,
                      f"same counts as live ({st['nodes']}/{st['edges']} vs {live_counts[0]}/{live_counts[1]})")
                if shown_before["node"]:
                    shown = await on_canvas(cdp, new_id, frm, to, etype)
                    check(shown["node"], "new node on canvas")
                    check(shown["edge"] == shown_before["edge"], "new edge on canvas")

        errs = page_errors(events)
        check(not errs, "no page errors" + ("".join(f"\n         {e}" for e in errs[:10]) if errs else ""))
    print("PASS" if not check.failed else f"FAILED: {check.failed} check(s)")
    return 1 if check.failed else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("graph_dir", help="graph directory to test against (copied; never written)")
    ap.add_argument("--view", default="default")
    ap.add_argument("--timeout", type=float, default=120, help="seconds to wait for each layout")
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()

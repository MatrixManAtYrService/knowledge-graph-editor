"""Time (and optionally CPU-profile) the kge UI in a headless Chromium browser.

    uv run --with websockets python scripts/ui_timing.py http://localhost:8151/
    uv run --with websockets python scripts/ui_timing.py 'http://localhost:8152/#g=ebb&v=everything' --profile

Loads the URL in a fresh browser profile (with --warm: loads it once, then
times a second load with the caches filled) and polls the status line until it
reports a finished layout (or --until matches), printing elapsed time, the
rendered node/edge counts and the status text. --profile records a CPU
profile of the whole load and prints the top functions by inclusive and self
time; build the UI unminified for readable names:

    cd ui && pnpm exec vite build --minify false --outDir /tmp/kge-ui-dev
    uv run kge serve --ui-dir /tmp/kge-ui-dev ...

--resources lists the page's network fetches (start, duration, size) and
the UI's performance.measure timings (duck:boot, each duck:query), the
slowest first: where the time before layout goes, and whether anything
came from a CDN.

Talks to the browser over the DevTools protocol directly (no Playwright), so
any Chromium works: $CHROME, else Chrome/Chromium/Brave in the usual places.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from collections import Counter
from pathlib import Path

import websockets

CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome", "chromium", "chromium-browser",
]

STATE_JS = """JSON.stringify((() => {
  const el = [...document.querySelectorAll('div')].find(d => d._cyreg)
  const cy = el && el._cyreg && el._cyreg.cy
  return {
    status: [...document.querySelectorAll('[class*=status]')].map(e => e.innerText).join(' '),
    drawn: el ? el.getAttribute('data-drawn') : null,
    nodes: cy ? cy.nodes().length : null,
    edges: cy ? cy.edges().length : null,
  }
})())"""

RESOURCES_JS = """JSON.stringify([
  ...performance.getEntriesByType('resource').map(r => ({
    url: r.name, start: r.startTime, dur: r.duration, size: r.transferSize,
  })),
  ...performance.getEntriesByType('measure').map(m => ({
    url: '[measure] ' + m.name, start: m.startTime, dur: m.duration, size: 0,
  })),
])"""


CDN_HOST = "cdn.jsdelivr.net"


def find_browser() -> str:
    for c in [os.environ.get("CHROME", ""), *CANDIDATES]:
        if c and (Path(c).exists() or shutil.which(c)):
            return c
    raise SystemExit("no Chromium-family browser found; set $CHROME")


class Cdp:
    def __init__(self, ws, events: list | None = None):
        self.ws, self.n, self.events = ws, 0, events

    async def call(self, method: str, **params):
        self.n += 1
        my = self.n
        await self.ws.send(json.dumps({"id": my, "method": method, "params": params}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get("id") == my:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})
            if "method" in m and self.events is not None:
                self.events.append(m)

    async def eval(self, expression: str, timeout: float = 60):
        """Evaluate JS in the page (awaiting promises); the value, or raise on a JS exception."""
        r = await asyncio.wait_for(
            self.call("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True),
            timeout,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r["result"].get("value")


def report_profile(prof: dict, top: int) -> None:
    nodes = {x["id"]: x for x in prof["nodes"]}
    parent = {c: x["id"] for x in prof["nodes"] for c in x.get("children", [])}
    incl, self_t = Counter(), Counter()
    for sid, d in zip(prof["samples"], prof["timeDeltas"]):
        cf = nodes[sid]["callFrame"]
        self_t[f'{cf["functionName"] or "(anon)"} {cf["url"].rsplit("/", 1)[-1]}:{cf["lineNumber"]}'] += d
        seen, i = set(), sid
        while i in nodes:  # count each function once per stack (recursion)
            fn = nodes[i]["callFrame"]["functionName"] or "(anon)"
            if fn not in seen:
                incl[fn] += d
                seen.add(fn)
            i = parent.get(i, -1)
    print(f"-- inclusive (top {top}) --")
    for k, v in incl.most_common(top):
        print(f"{v / 1e6:8.2f}s {k}")
    print(f"-- self (top {top}) --")
    for k, v in self_t.most_common(top):
        print(f"{v / 1e6:8.2f}s {k}")


@contextlib.asynccontextmanager
async def browser_page(events: list | None = None, extra_args: list[str] | None = None):
    """A fresh headless browser profile and a Cdp session on its one page.
    With `events`, protocol events (console, exceptions) are appended there."""
    port = 9400 + os.getpid() % 500
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile_dir:
        proc = subprocess.Popen(
            [find_browser(), "--headless=new", f"--remote-debugging-port={port}",
             f"--user-data-dir={profile_dir}", "--window-size=1600,1000", *(extra_args or []),
             "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            ws_url = None
            for _ in range(100):  # until the debug port answers and lists the page
                try:
                    tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                    ws_url = next((t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page"), None)
                except OSError:
                    pass
                if ws_url:
                    break
                time.sleep(0.1)
            if not ws_url:
                raise SystemExit("the browser never offered a page to debug")
            async with websockets.connect(ws_url, max_size=2**30) as ws:
                cdp = Cdp(ws, events)
                await cdp.call("Page.enable")
                await cdp.call("Runtime.enable")
                yield cdp
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)  # let it stop writing to the profile dir
            except subprocess.TimeoutExpired:
                proc.kill()


async def page_state(cdp: Cdp, timeout: float) -> dict | None:
    """Status line + rendered counts, or None if the main thread is too busy to answer."""
    try:
        r = await asyncio.wait_for(
            cdp.call("Runtime.evaluate", expression=STATE_JS, returnByValue=True), timeout
        )
    except asyncio.TimeoutError:
        return None
    return json.loads(r["result"]["value"])


async def wait_for_status(cdp: Cdp, pattern: str, timeout: float, t0: float | None = None) -> tuple[bool, dict]:
    """Poll the status line until it matches `pattern` (or time runs out)."""
    t0 = time.time() if t0 is None else t0
    done = re.compile(pattern)
    state: dict = {}
    while time.time() - t0 < timeout:
        await asyncio.sleep(0.5)
        s = await page_state(cdp, timeout)
        if s is None:  # a busy main thread can't answer: that is the measurement
            break
        state = s
        if done.search(state.get("status") or ""):
            return True, state
    return False, state


async def run(args) -> None:
    extra = [f"--host-resolver-rules=MAP {CDN_HOST} ~NOTFOUND"] if args.no_cdn else []
    async with browser_page(extra_args=extra) as cdp:
        if args.profile:
            await cdp.call("Profiler.enable")
            await cdp.call("Profiler.setSamplingInterval", interval=500)
            await cdp.call("Profiler.start")
        if args.warm:
            # A first visit fills the HTTP and compiled-wasm caches; time the
            # second, which is what a returning user sees.
            await cdp.call("Page.navigate", url=args.url)
            await wait_for_status(cdp, args.until, args.timeout)
            await cdp.call("Page.navigate", url="about:blank")
        t0 = time.time()
        await cdp.call("Page.navigate", url=args.url)
        ok, state = await wait_for_status(cdp, args.until, args.timeout, t0)
        elapsed = time.time() - t0
        print(f"{'ready' if ok else 'NOT READY'} after {elapsed:.1f}s: "
              f"{state.get('nodes')} nodes, {state.get('edges')} edges")
        print(f"status: {state.get('status')}")
        if args.resources:
            r = await cdp.call("Runtime.evaluate", expression=RESOURCES_JS, returnByValue=True)
            entries = sorted(json.loads(r["result"]["value"]), key=lambda e: -e["dur"])
            print(f"-- resources (top {args.top} by duration) --")
            print(f"{'start':>7} {'dur':>7} {'KB':>7}  url")
            for e in entries[: args.top]:
                print(f"{e['start'] / 1e3:6.2f}s {e['dur'] / 1e3:6.2f}s {e['size'] / 1024:7.0f}  {e['url']}")
        if args.profile:
            prof = (await asyncio.wait_for(cdp.call("Profiler.stop"), args.timeout))["profile"]
            report_profile(prof, args.top)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("url")
    ap.add_argument("--until", default=r"^layout: ", help="status-line regex meaning 'ready'")
    ap.add_argument("--timeout", type=float, default=300, help="seconds before giving up")
    ap.add_argument("--profile", action="store_true", help="record and summarize a CPU profile")
    ap.add_argument("--warm", action="store_true", help="load once first; time the second (cached) load")
    ap.add_argument("--no-cdn", action="store_true",
                    help=f"make {CDN_HOST} unresolvable: the page must load without it")
    ap.add_argument("--resources", action="store_true", help="list network fetches, slowest first")
    ap.add_argument("--top", type=int, default=25)
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()

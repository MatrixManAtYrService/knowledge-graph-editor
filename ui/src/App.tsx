import { useEffect } from 'react'
import { GraphCanvas } from './GraphCanvas'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { initShare } from './share'
import { STATIC_MODE } from './static'
import { useStore } from './store'
import { Toolbar } from './Toolbar'

export function App() {
  const status = useStore((s) => s.status)
  const refresh = useStore((s) => s.refresh)

  useEffect(() => {
    // Static site: boot from the URL hash and keep it mirrored (share.ts);
    // editor: open on the hash's graph + view (#g=…&v=…), then keep those two
    // mirrored so a browser refresh lands where you were.
    if (STATIC_MODE) {
      void initShare()
      return
    }
    const params = new URLSearchParams(window.location.hash.slice(1))
    const g = params.get('g')
    const v = params.get('v')
    if (g) useStore.setState({ graphId: g })
    if (v) useStore.setState({ viewId: v })
    void refresh()
    return useStore.subscribe((s) => {
      if (!s.graph || !s.graphId) return
      const h = `#g=${encodeURIComponent(s.graphId)}&v=${encodeURIComponent(s.viewId)}`
      if (h !== window.location.hash) history.replaceState(null, '', h)
    })
  }, [refresh])

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <Sidebar />
        <GraphCanvas />
        <Inspector />
      </div>
      <div className="statusbar">{status}</div>
    </div>
  )
}

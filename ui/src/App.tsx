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
    // editor: just load from the server.
    if (STATIC_MODE) void initShare()
    else void refresh()
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

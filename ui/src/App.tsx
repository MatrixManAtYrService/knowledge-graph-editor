import { useEffect } from 'react'
import { GraphCanvas } from './GraphCanvas'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { initShare } from './share'
import { useStore } from './store'
import { Toolbar } from './Toolbar'

export function App() {
  const status = useStore((s) => s.status)

  useEffect(() => {
    // Boot from the URL hash and keep it mirrored (share.ts) — the same in
    // the editor and on a static export.
    void initShare()
  }, [])

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

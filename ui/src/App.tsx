import { useEffect } from 'react'
import { GraphCanvas } from './GraphCanvas'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { useStore } from './store'

export function App() {
  const status = useStore((s) => s.status)
  const refresh = useStore((s) => s.refresh)

  useEffect(() => {
    void refresh()
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

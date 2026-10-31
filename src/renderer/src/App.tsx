import { useEffect, useState } from 'react'
import type { AppStatus, ComponentStatus } from '@shared/ipc'

function Card({ title, status }: { title: string; status: ComponentStatus }): React.JSX.Element {
  return (
    <section className="card">
      <header>
        <span className={`dot ${status.health}`} />
        <h2>{title}</h2>
      </header>
      <p className="health">{status.health}</p>
      <p className="detail">{status.detail}</p>
    </section>
  )
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)

  useEffect(() => {
    void window.api.getStatus().then(setStatus)
    return window.api.onStatus(setStatus)
  }, [])

  if (!status) return <main className="loading">Loading…</main>

  return (
    <main>
      <header className="top">
        <h1>
          <span className={`dot ${status.overall}`} /> Claude Desktop Proxy
        </h1>
        <button onClick={() => void window.api.refreshStatus().then(setStatus)}>Check now</button>
      </header>
      <div className="grid">
        <Card title="Proxy (mitmproxy)" status={status.proxy} />
        <Card title="Compressor (headroom)" status={status.compressor} />
        <Card title="Clients" status={status.clients} />
      </div>
      <footer>
        Last check: {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : 'never'}
      </footer>
    </main>
  )
}

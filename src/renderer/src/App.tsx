import { useEffect, useState } from 'react'
import type { AppStatus, ClientInfo, ComponentStatus, CompressorStats, ProxyAction, ProxyInfo } from '@shared/ipc'

const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

const stateLabel: Record<ClientInfo['state'], string> = {
  applied: 'routed',
  absent: 'direct',
  partial: 'partly set',
  conflict: 'conflict',
  missing: 'not installed',
  error: 'error'
}

function Card({ title, status, children }: {
  title: string
  status: ComponentStatus
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="card">
      <header>
        <span className={`dot ${status.health}`} />
        <h2>{title}</h2>
      </header>
      <p className="health">{status.health}</p>
      <p className="detail">{status.detail}</p>
      {children}
    </section>
  )
}

function Client({ client, busy, onToggle }: {
  client: ClientInfo
  busy: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const ok = !client.enabled || client.state === 'applied'
  return (
    <li className="client">
      <div className="client-main">
        <strong>{client.name}</strong>
        <span className={`badge ${ok ? '' : 'warn'}`}>{stateLabel[client.state]}</span>
        <label className="switch" title={client.enabled ? 'Stop routing' : 'Route through the proxy'}>
          <input
            type="checkbox"
            checked={client.enabled}
            disabled={busy || client.state === 'missing'}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span />
        </label>
      </div>
      <p className="detail">{client.detail}</p>
      <p className="path">{client.configPath}</p>
    </li>
  )
}

function proxyButtons(info: ProxyInfo): { action: ProxyAction; label: string; primary?: boolean }[] {
  if (!info.mitmdump) return [{ action: 'install', label: 'Install mitmproxy', primary: true }]
  if (info.unit === 'missing') return [{ action: 'setup', label: 'Set up & start', primary: true }]
  const buttons: { action: ProxyAction; label: string; primary?: boolean }[] = []
  if (info.unit === 'legacy' || info.unit === 'outdated') buttons.push({ action: 'setup', label: 'Apply', primary: true })
  if (info.listening) buttons.push({ action: 'restart', label: 'Restart' }, { action: 'stop', label: 'Stop' })
  else buttons.push({ action: 'start', label: 'Start', primary: !buttons.length })
  buttons.push({ action: 'remove', label: 'Remove' })
  return buttons
}

function ProxyControls({ info, compressorDown, busy, onAction }: {
  info: ProxyInfo
  compressorDown: boolean
  busy: ProxyAction | null
  onAction: (action: ProxyAction) => void
}): React.JSX.Element {
  const [logs, setLogs] = useState<string | null>(null)
  async function toggleLogs(): Promise<void> {
    setLogs(logs === null ? await window.api.proxyLogs() : null)
  }
  return (
    <>
      {info.listening && compressorDown && (
        <p className="note">headroom is down: API requests go straight to Anthropic, without compression.</p>
      )}
      <div className="actions">
        {proxyButtons(info).map((b) => (
          <button key={b.action} className={b.primary ? 'primary' : ''} disabled={busy !== null} onClick={() => onAction(b.action)}>
            {busy === b.action ? '…' : b.label}
          </button>
        ))}
        {info.unit !== 'missing' && (
          <button className="link" onClick={() => void toggleLogs()}>{logs === null ? 'Logs' : 'Hide logs'}</button>
        )}
      </div>
      {logs !== null && <pre className="log">{logs || 'no log lines'}</pre>}
    </>
  )
}

function Stats({ stats }: { stats: CompressorStats }): React.JSX.Element {
  const { lifetime, session } = stats
  const days = stats.daily.slice(-14)
  const max = Math.max(1, ...days.map((d) => d.tokensSaved))
  return (
    <section className="card stats">
      <header>
        <h2>headroom savings</h2>
      </header>
      <div className="tiles">
        <div>
          <span className="value">{compact.format(lifetime.tokensSaved)}</span>
          <span className="label">tokens saved</span>
        </div>
        <div>
          <span className="value">{usd.format(lifetime.compressionSavingsUsd)}</span>
          <span className="label">saved by compression</span>
        </div>
        <div>
          <span className="value">{usd.format(lifetime.cacheSavingsUsd)}</span>
          <span className="label">saved by cache</span>
        </div>
        <div>
          <span className="value">{int.format(lifetime.requests)}</span>
          <span className="label">requests</span>
        </div>
      </div>
      {session && (
        <p className="detail">
          Current session: {int.format(session.requests)} requests, {compact.format(session.tokensSaved)} tokens saved
        </p>
      )}
      {days.length > 0 && (
        <div className="bars" aria-label="Tokens saved per day">
          {days.map((d) => (
            <div key={d.day} className="bar" title={`${d.day}: ${int.format(d.tokensSaved)} tokens`}>
              <span style={{ height: `${(d.tokensSaved / max) * 100}%` }} />
              <small>{d.day.slice(8)}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proxyBusy, setProxyBusy] = useState<ProxyAction | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])

  useEffect(() => {
    void window.api.getStatus().then(setStatus)
    const offStatus = window.api.onStatus(setStatus)
    const offLog = window.api.onInstallLog((line) => setInstallLog((l) => [...l.slice(-200), line]))
    return () => {
      offStatus()
      offLog()
    }
  }, [])

  async function runProxy(action: ProxyAction): Promise<void> {
    setProxyBusy(action)
    setError(null)
    if (action === 'install') setInstallLog([])
    try {
      const result = await window.api.proxyAction(action)
      setStatus(result.status)
      if (result.error) setError(result.error)
    } finally {
      setProxyBusy(null)
    }
  }

  async function toggle(id: string, enabled: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.setClientEnabled(id, enabled)
      setStatus(result.status)
      if (!result.ok) setError(result.error ?? 'failed')
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <main className="loading">Loading…</main>

  return (
    <main>
      <header className="top">
        <h1>
          <span className={`dot ${status.overall}`} /> Claude Desktop Proxy
        </h1>
        <button onClick={() => void window.api.refreshStatus().then(setStatus)}>Check now</button>
      </header>
      {error && (
        <div className="error" role="alert">
          <span className="error-text">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="grid">
        <Card title="Proxy (mitmproxy)" status={status.proxy}>
          {status.proxyInfo && (
            <ProxyControls
              info={status.proxyInfo}
              compressorDown={status.compressor.health === 'down'}
              busy={proxyBusy}
              onAction={(a) => void runProxy(a)}
            />
          )}
        </Card>
        <Card title="Compressor (headroom)" status={status.compressor} />
        <Card title="Clients" status={status.clients}>
          <ul className="clients">
            {status.clientList.map((c) => (
              <Client key={c.id} client={c} busy={busy} onToggle={(on) => void toggle(c.id, on)} />
            ))}
          </ul>
        </Card>
      </div>
      {installLog.length > 0 && (
        <section className="card install">
          <header>
            <h2>Installing mitmproxy</h2>
            {proxyBusy === null && <button className="link" onClick={() => setInstallLog([])}>Close</button>}
          </header>
          <pre className="log">{installLog.join('\n')}</pre>
        </section>
      )}
      {status.stats && <Stats stats={status.stats} />}
      <footer>
        Last check: {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : 'never'}
      </footer>
    </main>
  )
}

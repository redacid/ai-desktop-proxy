import { useEffect, useRef, useState } from 'react'
import type {
  AppStatus,
  ClientInfo,
  ComponentStatus,
  CompressorAction,
  CompressorInfo,
  CompressorStats,
  ProxyAction,
  ProxyInfo,
  UserSettings
} from '@shared/ipc'
import { HeadroomSettings } from './HeadroomSettings'
import { RecentRequests } from './RecentRequests'
import { Tools } from './Tools'

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

type Action = ProxyAction | CompressorAction
type ButtonSpec = { action: Action; label: string; primary?: boolean }

function proxyButtons(info: ProxyInfo): ButtonSpec[] {
  if (!info.mitmdump) return [{ action: 'install', label: 'Install mitmproxy', primary: true }]
  if (info.unit === 'missing') return [{ action: 'setup', label: 'Set up & start', primary: true }]
  const buttons: ButtonSpec[] = []
  if (info.unit === 'legacy' || info.unit === 'outdated') buttons.push({ action: 'setup', label: 'Apply', primary: true })
  if (info.listening) buttons.push({ action: 'restart', label: 'Restart' }, { action: 'stop', label: 'Stop' })
  else buttons.push({ action: 'start', label: 'Start', primary: !buttons.length })
  buttons.push({ action: 'remove', label: 'Remove' })
  return buttons
}

function compressorButtons(info: CompressorInfo): ButtonSpec[] {
  if (!info.local || info.managed === 'external') return []
  if (!info.binary) return [{ action: 'install', label: 'Install headroom', primary: true }]
  if (info.unit === 'missing') return [{ action: 'setup', label: 'Set up & start', primary: true }]
  const buttons: ButtonSpec[] = []
  if (info.unit === 'outdated') buttons.push({ action: 'setup', label: 'Apply', primary: true })
  if (info.active) buttons.push({ action: 'restart', label: 'Restart' }, { action: 'stop', label: 'Stop' })
  else buttons.push({ action: 'start', label: 'Start', primary: !buttons.length })
  buttons.push({ action: 'remove', label: 'Remove' })
  return buttons
}

function ServiceControls({ buttons, showLogs, loadLogs, busy, onAction, note }: {
  buttons: ButtonSpec[]
  showLogs: boolean
  loadLogs: () => Promise<string>
  busy: Action | null
  onAction: (action: Action) => void
  note?: string | null
}): React.JSX.Element {
  const [logs, setLogs] = useState<string | null>(null)
  async function toggleLogs(): Promise<void> {
    setLogs(logs === null ? await loadLogs() : null)
  }
  return (
    <>
      {note && <p className="note">{note}</p>}
      {(buttons.length > 0 || showLogs) && (
        <div className="actions">
          {buttons.map((b) => (
            <button key={b.action} className={b.primary ? 'primary' : ''} disabled={busy !== null} onClick={() => onAction(b.action)}>
              {busy === b.action ? '…' : b.label}
            </button>
          ))}
          {showLogs && (
            <button className="link" onClick={() => void toggleLogs()}>{logs === null ? 'Logs' : 'Hide logs'}</button>
          )}
        </div>
      )}
      {logs !== null && <pre className="log">{logs || 'no log lines'}</pre>}
    </>
  )
}

function SettingsPanel({ onSaved, headroomExternal }: {
  onSaved: (s: AppStatus) => void
  headroomExternal: boolean
}): React.JSX.Element {
  const [form, setForm] = useState<UserSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.api.getSettings().then(setForm)
  }, [])
  if (!form) return <section className="card settings">Loading…</section>

  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]): void => setForm({ ...form, [key]: value })

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!form) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.api.saveSettings(form)
      onSaved(result.status)
      setMessage(result.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: result.error ?? 'not saved' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card settings" onSubmit={(e) => void save(e)}>
      <header>
        <h2>Settings</h2>
      </header>
      <label>
        <span>Proxy port</span>
        <input type="number" min={1024} max={65535} value={form.proxyPort} onChange={(e) => set('proxyPort', Number(e.target.value))} />
        <small>mitmproxy listens on 127.0.0.1 at this port. Changing it restarts the proxy and updates routed clients.</small>
      </label>
      <label>
        <span>Codex port</span>
        <input type="number" min={1024} max={65535} value={form.codexPort} onChange={(e) => set('codexPort', Number(e.target.value))} />
        <small>A second mitmproxy listener that Codex uses as its OpenAI base URL, because Codex cannot use an HTTPS proxy.</small>
      </label>
      <label>
        <span>headroom URL</span>
        <input type="url" value={form.headroomUrl} onChange={(e) => set('headroomUrl', e.target.value)} />
        <small>Where the proxy sends API requests. A local URL can be run by this app.</small>
      </label>
      <label>
        <span>Check interval, seconds</span>
        <input type="number" min={10} max={3600} value={form.checkIntervalSec} onChange={(e) => set('checkIntervalSec', Number(e.target.value))} />
        <small>How often client configs are re-checked; file changes are noticed immediately anyway.</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.autoRepair} onChange={(e) => set('autoRepair', e.target.checked)} />
        <span>Restore proxy settings when they disappear from a routed client's config</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.autostart} onChange={(e) => set('autostart', e.target.checked)} />
        <span>Start at login, hidden in the tray</span>
      </label>
      <HeadroomSettings value={form.headroom} onChange={(v) => set('headroom', v)} external={headroomExternal} />
      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {message && <span className={message.ok ? 'saved' : 'error-inline'}>{message.text}</span>}
      </div>
    </form>
  )
}

/** A log box that stays scrolled to the newest line. */
function LiveLog({ lines }: { lines: string[] }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  return <pre ref={ref} className="log">{lines.join('\n')}</pre>
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
      <RecentRequests recent={stats.recent} messagesLogged={stats.messagesLogged} />
    </section>
  )
}

type Tab = 'overview' | 'savings' | 'tools' | 'settings'
const TABS: [Tab, string][] = [['overview', 'Overview'], ['savings', 'Savings'], ['tools', 'Tools'], ['settings', 'Settings']]

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<{ target: 'proxy' | 'compressor'; action: Action } | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [installLog, setInstallLog] = useState<string[]>([])
  const [toolBusy, setToolBusy] = useState(false)

  useEffect(() => {
    void window.api.getStatus().then(setStatus)
    const offStatus = window.api.onStatus(setStatus)
    const offLog = window.api.onInstallLog((line) => setInstallLog((l) => [...l.slice(-200), line]))
    return () => {
      offStatus()
      offLog()
    }
  }, [])

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

  async function runAction(target: 'proxy' | 'compressor', action: Action): Promise<void> {
    setBusyAction({ target, action })
    setError(null)
    if (action === 'install') setInstallLog([])
    try {
      const result = target === 'proxy'
        ? await window.api.proxyAction(action as ProxyAction)
        : await window.api.compressorAction(action as CompressorAction)
      setStatus(result.status)
      if (result.error) setError(result.error)
    } finally {
      setBusyAction(null)
    }
  }

  if (!status) return <main className="loading">Loading…</main>

  return (
    <main>
      <header className="top">
        <h1>
          <span className={`dot ${status.overall}`} /> Claude Desktop Proxy
        </h1>
        <div className="top-actions">
          <button onClick={() => void window.api.refreshStatus().then(setStatus)}>Check now</button>
        </div>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'overview' && <span className={`dot ${status.overall}`} />}
          </button>
        ))}
      </nav>
      {error && (
        <div className="error" role="alert">
          <span className="error-text">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {tab === 'settings' && (
        <SettingsPanel onSaved={setStatus} headroomExternal={status.compressorInfo?.managed === 'external'} />
      )}
      {tab === 'overview' && <div className="grid">
        <Card title="Proxy (mitmproxy)" status={status.proxy}>
          {status.proxyInfo && (
            <ServiceControls
              buttons={proxyButtons(status.proxyInfo)}
              showLogs={status.proxyInfo.unit !== 'missing'}
              loadLogs={() => window.api.proxyLogs()}
              busy={busyAction?.target === 'proxy' ? busyAction.action : busyAction || toolBusy ? 'start' : null}
              onAction={(a) => void runAction('proxy', a)}
              note={status.proxyInfo.listening && status.compressor.health === 'down'
                ? 'headroom is down: API requests go straight to Anthropic and OpenAI, without compression.'
                : null}
            />
          )}
        </Card>
        <Card title="Compressor (headroom)" status={status.compressor}>
          {status.compressorInfo && (
            <ServiceControls
              buttons={compressorButtons(status.compressorInfo)}
              showLogs={status.compressorInfo.unit !== 'missing'}
              loadLogs={() => window.api.compressorLogs()}
              busy={busyAction?.target === 'compressor' ? busyAction.action : busyAction || toolBusy ? 'start' : null}
              onAction={(a) => void runAction('compressor', a)}
            />
          )}
        </Card>
        <Card title="Clients" status={status.clients}>
          <ul className="clients">
            {status.clientList.map((c) => (
              <Client key={c.id} client={c} busy={busy || toolBusy || busyAction !== null} onToggle={(on) => void toggle(c.id, on)} />
            ))}
          </ul>
        </Card>
      </div>}
      {/* Kept mounted so a running tool action and its state survive switching tabs. */}
      <div hidden={tab !== 'tools'}>
        <Tools disabled={busy || toolBusy || busyAction !== null} onBusy={setToolBusy} onLogStart={() => { setInstallLog([]) }} />
      </div>
      {installLog.length > 0 && (
        <section className="card install">
          <header>
            <h2>Install log</h2>
            {busyAction === null && !toolBusy && <button className="link" onClick={() => setInstallLog([])}>Close</button>}
          </header>
          <LiveLog lines={installLog} />
        </section>
      )}
      {tab === 'savings' && (status.stats
        ? <Stats stats={status.stats} />
        : <p className="detail">No headroom statistics yet: headroom is not answering at the configured URL.</p>)}
      <footer>
        Last check: {status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : 'never'}
      </footer>
    </main>
  )
}

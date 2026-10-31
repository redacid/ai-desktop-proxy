import { useEffect, useState } from 'react'
import type { ToolAction, ToolId, ToolInfo, ToolStats } from '@shared/ipc'

const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function Stats({ stats }: { stats: ToolStats }): React.JSX.Element {
  const max = Math.max(1, ...stats.daily.map((d) => d.value))
  return (
    <div className="tool-stats">
      <div className="tiles">
        {stats.facts.map((f) => (
          <div key={f.label}>
            <span className="value">{f.value}</span>
            <span className="label">{f.label}</span>
          </div>
        ))}
      </div>
      {stats.daily.length > 0 && (
        <div className="bars" aria-label="Tokens saved per day">
          {stats.daily.map((d) => (
            <div key={d.day} className="bar" title={`${d.day}: ${int.format(d.value)} tokens`}>
              <span style={{ height: `${(d.value / max) * 100}%` }} />
              <small>{d.day.slice(8)}</small>
            </div>
          ))}
        </div>
      )}
      <p className="detail">Source: {stats.source}</p>
    </div>
  )
}

export function Tools({ disabled, onBusy, onLogStart }: {
  disabled: boolean
  onBusy: (busy: boolean) => void
  onLogStart: () => void
}): React.JSX.Element {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const off = window.api.onTools(setTools)
    void window.api.getTools().then(setTools).catch((e) => setError(String(e)))
    return off
  }, [])

  async function check(): Promise<void> {
    setBusy('check')
    setError(null)
    try { setTools(await window.api.checkTools()) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  async function act(id: ToolId, action: ToolAction): Promise<void> {
    setBusy(`${id}/${action}`)
    onBusy(true)
    onLogStart()
    setError(null)
    try {
      const result = await window.api.toolAction(id, action)
      setTools(result.tools)
      if (result.error) setError(result.error)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null); onBusy(false) }
  }

  const locked = disabled || busy !== null
  const version = (tool: ToolInfo): string =>
    tool.installed === null ? 'unknown' : !tool.installed ? 'not installed' : tool.version ? `v${tool.version}` : 'installed'
  const notes = (tool: ToolInfo): React.JSX.Element => <>
    {tool.blocked && <p className="note">{tool.blocked}</p>}
    {tool.error && <p className="error-inline">{tool.error}</p>}
  </>

  /** One client row, shaped like the Clients card: name, state badge, switch. */
  function Row({ name, badge, warn, on, canToggle, onToggle, title, children }: {
    name: string; badge: string; warn?: boolean; on: boolean; canToggle: boolean
    onToggle: (on: boolean) => void; title: string; children?: React.ReactNode
  }): React.JSX.Element {
    return (
      <li className="client">
        <div className="client-main">
          <strong>{name}</strong>
          <span className={`badge ${warn ? 'warn' : ''}`}>{badge}</span>
          <label className="switch" title={title}>
            <input type="checkbox" checked={on} disabled={locked || !canToggle} onChange={(e) => onToggle(e.target.checked)} />
            <span />
          </label>
        </div>
        {children}
      </li>
    )
  }

  const updateButton = (tool: ToolInfo): React.JSX.Element | null => tool.updateAvailable
    ? <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'update')}>Update to {tool.latest}</button>
    : null

  const rtk = tools.find((t) => t.id === 'rtk')
  const ponytail = tools.filter((t) => t.id.startsWith('ponytail'))
  const clientName = (id: string): string => id.endsWith('codex') ? 'Codex' : 'Claude Code'

  return (
    <section className="card tools">
      <header>
        <h2>Tools &amp; updates</h2>
        <button className="link" disabled={locked} onClick={() => void check()}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
      </header>
      <p className="detail">Checks installations every minute and new versions every 6 hours while the app runs. Installs, updates and switches always ask for approval.</p>
      {error && <p className="error-inline" role="alert">{error}</p>}
      {!tools.length && <p className="detail">Checking tools…</p>}
      <div className="tool-grid">
        {tools.filter((t) => t.id === 'headroom' || t.id === 'rtk').map((tool) => (
          <article className="tool" key={tool.id}>
            <div className="client-main">
              <strong>{tool.name}</strong>
              <span className={`badge ${tool.updateAvailable ? 'warn' : ''}`}>{version(tool)}</span>
            </div>
            <p className="detail">{tool.detail}</p>
            {tool.stats && <Stats stats={tool.stats} />}
            {tool.latest && <p className="detail">Latest: {tool.latest}{tool.updateAvailable ? ' · update available' : ''}</p>}
            {notes(tool)}
            <div className="actions">
              {tool.installed === false && <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'install')}>Install</button>}
              {updateButton(tool)}
            </div>
            {tool === rtk && tool.installed === true && (
              <ul className="clients">
                {(['claude', 'codex'] as const).map((client) => {
                  const connected = tool.connected?.[client] ?? null
                  return (
                    <Row key={client} name={clientName(client)} on={connected === true}
                      badge={connected === null ? 'unknown' : connected ? 'connected' : 'not connected'}
                      canToggle={!tool.blocked && connected !== null}
                      title={connected ? 'Remove RTK hooks from this client' : 'Add RTK hooks to this client'}
                      onToggle={(on) => void act('rtk', `${on ? 'connect' : 'disconnect'}-${client}`)} />
                  )
                })}
              </ul>
            )}
            <p className="detail">Version check: {tool.checkedAt ? new Date(tool.checkedAt).toLocaleString() : 'not checked yet'}</p>
          </article>
        ))}
        {ponytail.length > 0 && (
          <article className="tool">
            <div className="client-main">
              <strong>Ponytail</strong>
              {ponytail[0].latest && <span className="badge">latest v{ponytail[0].latest}</span>}
            </div>
            {ponytail.map((t) => t.stats).find(Boolean) && <Stats stats={ponytail.map((t) => t.stats).find(Boolean)!} />}
            <ul className="clients">
              {ponytail.map((tool) => (
                <Row key={tool.id} name={clientName(tool.id)} on={tool.installed === true}
                  badge={version(tool)} warn={tool.updateAvailable}
                  canToggle={!tool.blocked && tool.installed !== null}
                  title={tool.installed ? 'Uninstall Ponytail from this client' : 'Install Ponytail for this client'}
                  onToggle={(on) => void act(tool.id, on ? 'install' : 'remove')}>
                  <p className="detail">{tool.detail}</p>
                  {notes(tool)}
                  {tool.updateAvailable && <div className="actions">{updateButton(tool)}</div>}
                </Row>
              ))}
            </ul>
            <p className="detail">Version check: {ponytail[0].checkedAt ? new Date(ponytail[0].checkedAt).toLocaleString() : 'not checked yet'}</p>
          </article>
        )}
      </div>
    </section>
  )
}

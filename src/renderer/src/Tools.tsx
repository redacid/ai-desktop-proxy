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
  return (
    <section className="card tools">
      <header>
        <h2>Tools &amp; updates</h2>
        <button className="link" disabled={locked} onClick={() => void check()}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
      </header>
      <p className="detail">Checks installations every minute and new versions every 6 hours while the app runs. Installs and updates always ask for approval.</p>
      {error && <p className="error-inline" role="alert">{error}</p>}
      {!tools.length && <p className="detail">Checking tools…</p>}
      <div className="tool-grid">
        {tools.map((tool) => (
          <article className="tool" key={tool.id}>
            <div className="client-main">
              <strong>{tool.name}</strong>
              <span className={`badge ${tool.updateAvailable ? 'warn' : ''}`}>
                {tool.installed === null ? 'unknown' : !tool.installed ? 'not installed' : tool.version ? `v${tool.version}` : 'installed'}
              </span>
            </div>
            <p className="detail">{tool.detail}</p>
            {tool.stats && <Stats stats={tool.stats} />}
            {tool.latest && <p className="detail">Latest: {tool.latest}{tool.updateAvailable ? ' · update available' : ''}</p>}
            {tool.blocked && <p className="note">{tool.blocked}</p>}
            {tool.error && <p className="error-inline">{tool.error}</p>}
            <div className="actions">
              {tool.installed === false && <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'install')}>Install</button>}
              {tool.updateAvailable && <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'update')}>Update to {tool.latest}</button>}
              {tool.id === 'rtk' && tool.installed === true && <>
                <button disabled={locked || !!tool.blocked} onClick={() => void act('rtk', 'connect-claude')}>Connect to Claude Code</button>
                <button disabled={locked || !!tool.blocked} onClick={() => void act('rtk', 'connect-codex')}>Connect to Codex</button>
              </>}
            </div>
            <p className="detail">Version check: {tool.checkedAt ? new Date(tool.checkedAt).toLocaleString() : 'not checked yet'}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

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

  const clientName = (id: string): string => id.endsWith('codex') ? 'Codex' : 'Claude Code'
  const checked = (tool: ToolInfo): React.JSX.Element =>
    <p className="checked">Version check: {tool.checkedAt ? new Date(tool.checkedAt).toLocaleString() : 'not checked yet'}</p>

  /** Per-client connection rows: RTK hooks or an MCP server registration. */
  const connectionRows = (tool: ToolInfo): React.JSX.Element => (
    <ul className="clients">
      {(['claude', 'codex'] as const).map((client) => {
        const connected = tool.connected?.[client] ?? null
        const foreign = tool.foreign?.[client] ?? false
        return (
          <Row key={client} name={clientName(client)} on={connected === true}
            badge={foreign ? 'set up elsewhere' : connected === null ? 'unknown' : connected ? 'connected' : 'not connected'}
            warn={foreign}
            canToggle={!tool.blocked && connected !== null && !foreign}
            title={connected ? `Remove ${tool.name} from this client` : `Add ${tool.name} to this client`}
            onToggle={(on) => void act(tool.id, `${on ? 'connect' : 'disconnect'}-${client}`)} />
        )
      })}
    </ul>
  )

  const ours = (t: ToolInfo): boolean => (['claude', 'codex'] as const).some((c) => t.connected?.[c] && !t.foreign?.[c])
  /** Machine-wide Stop / Start / Remove; each opens a confirmation listing its commands. */
  const lifecycle = (id: ToolId, can: { stop?: boolean; start?: boolean; remove?: boolean }): React.JSX.Element | null =>
    can.stop || can.start || can.remove ? (
      <div className="actions lifecycle">
        {can.start && <button disabled={locked} onClick={() => void act(id, 'start')}>Start</button>}
        {can.stop && <button disabled={locked} onClick={() => void act(id, 'stop')}>Stop</button>}
        {can.remove && <button className="danger" disabled={locked} onClick={() => void act(id, 'uninstall')}>Remove from system</button>}
      </div>
    ) : null

  /** One card per plugin with a row per client, whose switch installs or uninstalls it there. */
  const pluginCard = (name: string, group: ToolInfo[]): React.JSX.Element | null => group.length ? (
    <article className="tool" key={name}>
      <div className="client-main">
        <strong>{name}</strong>
        {group[0].latest && <span className="badge">latest v{group[0].latest}</span>}
      </div>
      {group.map((t) => t.stats).find(Boolean) && <Stats stats={group.map((t) => t.stats).find(Boolean)!} />}
      <ul className="clients">
        {group.map((tool) => (
          <Row key={tool.id} name={clientName(tool.id)} on={tool.installed === true}
            badge={tool.installed && tool.enabled === false ? `${version(tool)} · disabled` : version(tool)}
            warn={tool.updateAvailable || (tool.installed === true && tool.enabled === false)}
            canToggle={!tool.blocked && tool.installed !== null}
            title={tool.installed ? `Uninstall ${name} from this client` : `Install ${name} for this client`}
            onToggle={(on) => void act(tool.id, on ? 'install' : 'remove')}>
            <p className="detail">{tool.detail}</p>
            {notes(tool)}
            {tool.updateAvailable && <div className="actions">{updateButton(tool)}</div>}
          </Row>
        ))}
      </ul>
      {(() => {
        const claude = group.find((t) => t.id.endsWith('-claude'))
        return lifecycle(claude?.id ?? group[0].id, {
          stop: claude?.installed === true && claude.enabled === true,
          start: claude?.installed === true && claude.enabled === false,
          remove: group.some((t) => t.installed === true)
        })
      })()}
      {checked(group[0])}
    </article>
  ) : null

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
        {tools.filter((t) => ['headroom', 'rtk', 'serena', 'markitdown'].includes(t.id)).map((tool) => (
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
              {tool.installed === false && ['headroom', 'rtk'].includes(tool.id) && <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'install')}>Install</button>}
              {updateButton(tool)}
            </div>
            {tool.installed === true && tool.connected && connectionRows(tool)}
            {tool.id !== 'headroom' && tool.installed === true && lifecycle(tool.id, { stop: ours(tool), remove: true })}
            {checked(tool)}
          </article>
        ))}
        {pluginCard('Ponytail', tools.filter((t) => t.id.startsWith('ponytail-')))}
        {pluginCard('Chisle', tools.filter((t) => t.id.startsWith('chisle-')))}
      </div>
    </section>
  )
}

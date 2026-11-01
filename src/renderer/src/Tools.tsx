import { useEffect, useState } from 'react'
import type { ComponentStatus, CompressorStats, ToolAction, ToolId, ToolInfo, ToolStats } from '@shared/ipc'

/** What each tool is for (shown on hover) and its official page. Keyed by card, not by ToolId. */
const ABOUT: Record<string, { what: string; url: string }> = {
  headroom: { url: 'https://github.com/headroomlabs-ai/headroom',
    what: 'Local proxy that compresses the context of API requests (tool output, history) before they reach the model, so each request costs fewer tokens.' },
  rtk: { url: 'https://github.com/rtk-ai/rtk',
    what: 'Rust Token Killer: hooks shell commands the agent runs and returns their output condensed, so command output fills less of the context.' },
  serena: { url: 'https://github.com/oraios/serena',
    what: 'MCP server with language-server code tools: find symbols, references and edit by symbol, instead of reading whole files.' },
  context7: { url: 'https://context7.com',
    what: 'MCP server from Upstash that fetches current, version-specific documentation and code examples for libraries, so the agent does not rely on outdated training data.' },
  'codebase-memory': { url: 'https://github.com/DeusData/codebase-memory-mcp',
    what: 'MCP server that indexes the codebase into a local knowledge graph (code, config, infrastructure), so the agent can query call paths and impact instead of re-reading files.' },
  markitdown: { url: 'https://github.com/microsoft/markitdown',
    what: 'MCP server from Microsoft that converts PDF, Word, Excel, PowerPoint, HTML and more into Markdown the agent can read.' },
  Ponytail: { url: 'https://github.com/DietrichGebert/ponytail',
    what: 'Plugin that makes the agent work like a lazy senior developer: the smallest complete change, less code and shorter replies.' },
  Chisle: { url: 'https://github.com/JayPokale/Chisle',
    what: 'Plugin for terse, zero-fluff answers and YAGNI-first code; also trims oversized tool output.' }
}

/** Card title with its official page link; the whole card carries the description as a tooltip. */
function Title({ name, about }: { name: string; about?: { what: string; url: string } }): React.JSX.Element {
  return (
    <strong className="tool-title">
      {name}
      {about && <a href={about.url} target="_blank" rel="noreferrer" title={`Official page: ${about.url}`} aria-label={`${name} official page`}>↗</a>}
    </strong>
  )
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

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

export function Tools({ disabled, onBusy, onLogStart, headroom }: {
  disabled: boolean
  /** Live service state and savings for the headroom card. */
  headroom: { status: ComponentStatus; stats: CompressorStats | null }
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
    <article className="tool" key={name} title={ABOUT[name]?.what}>
      <div className="client-main">
        <Title name={name} about={ABOUT[name]} />
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
        {tools.filter((t) => ['headroom', 'rtk', 'serena', 'markitdown', 'context7', 'codebase-memory'].includes(t.id)).map((tool) => (
          <article className="tool" key={tool.id} title={ABOUT[tool.id]?.what}>
            <div className="client-main">
              <Title name={tool.name} about={ABOUT[tool.id]} />
              <span className={`badge ${tool.updateAvailable ? 'warn' : ''}`}>{version(tool)}</span>
            </div>
            <p className="detail">{tool.detail}</p>
            {tool.stats && <Stats stats={tool.stats} />}
            {tool.id === 'headroom' && <>
              <p className={`service ${headroom.status.health}`}><span className={`dot ${headroom.status.health}`} /> {headroom.status.detail}</p>
              {headroom.stats && <Stats stats={{
                source: 'headroom /stats-history; details on the Savings tab',
                facts: [
                  { label: 'tokens saved', value: compact.format(headroom.stats.lifetime.tokensSaved) },
                  { label: 'saved by compression', value: usd.format(headroom.stats.lifetime.compressionSavingsUsd) },
                  { label: 'saved by cache', value: usd.format(headroom.stats.lifetime.cacheSavingsUsd) },
                  { label: 'requests', value: compact.format(headroom.stats.lifetime.requests) }
                ],
                daily: headroom.stats.daily.slice(-14).map((d) => ({ day: d.day, value: d.tokensSaved }))
              }} />}
            </>}
            {tool.latest && <p className="detail">Latest: {tool.latest}{tool.updateAvailable ? ' · update available' : ''}</p>}
            {notes(tool)}
            <div className="actions">
              {tool.installed === false && ['headroom', 'rtk'].includes(tool.id) && <button className="primary" disabled={locked || !!tool.blocked} onClick={() => void act(tool.id, 'install')}>Install</button>}
              {updateButton(tool)}
            </div>
            {tool.installed === true && tool.connected && connectionRows(tool)}
            {tool.id !== 'headroom' && tool.installed === true && lifecycle(tool.id, { stop: ours(tool), remove: !['context7', 'codebase-memory'].includes(tool.id) })}
            {checked(tool)}
          </article>
        ))}
        {pluginCard('Ponytail', tools.filter((t) => t.id.startsWith('ponytail-')))}
        {pluginCard('Chisle', tools.filter((t) => t.id.startsWith('chisle-')))}
      </div>
    </section>
  )
}

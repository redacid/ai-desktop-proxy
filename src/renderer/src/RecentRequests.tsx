import { useState } from 'react'
import type { RecentRequest, RequestDetail } from '@shared/ipc'
import { changedIndexes, totalChars, viewMessage, type MessageView } from './messages'

const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const PREVIEW_CHARS = 600

function time(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString()
}

function shortModel(model: string | null): string {
  return model ? model.replace(/^claude-/, '') : '—'
}

function Message({ view, index, changed }: { view: MessageView; index: number; changed: boolean }): React.JSX.Element {
  const [full, setFull] = useState(false)
  const [raw, setRaw] = useState(false)
  const long = view.text.length > PREVIEW_CHARS
  const body = raw ? JSON.stringify(JSON.parse(view.json || 'null'), null, 2) : view.text
  return (
    <li className={changed ? 'msg changed' : 'msg'}>
      <div className="msg-head">
        <span className="msg-role">#{index + 1} {view.role}</span>
        <span className="msg-kinds">{view.kinds.join(', ')}</span>
        {changed && <span className="badge warn">changed</span>}
        <span className="msg-size">{int.format(view.chars)} chars</span>
        <button className="link" onClick={() => setRaw(!raw)}>{raw ? 'text' : 'JSON'}</button>
      </div>
      <pre className="msg-body">{full || !long ? body : `${body.slice(0, PREVIEW_CHARS)}…`}</pre>
      {long && !raw && (
        <button className="link" onClick={() => setFull(!full)}>
          {full ? 'Show less' : `Show all ${int.format(view.text.length)} characters`}
        </button>
      )}
    </li>
  )
}

function MessageList({ title, views, changed, note }: {
  title: string
  views: MessageView[]
  changed?: Set<number>
  note?: string
}): React.JSX.Element {
  return (
    <div className="msgs">
      <h3>
        {title} <small>{views.length} messages, {int.format(totalChars(views))} chars</small>
      </h3>
      {note && <p className="detail">{note}</p>}
      <ol>
        {views.map((v, i) => <Message key={i} view={v} index={i} changed={changed?.has(i) ?? false} />)}
      </ol>
    </div>
  )
}

function Detail({ detail }: { detail: RequestDetail }): React.JSX.Element {
  if (!detail.logged) {
    return (
      <p className="detail">
        headroom does not keep request bodies. Turn on "Keep request bodies" in Settings (headroom run by this app), or
        start your own headroom with <code>--log-messages</code>.
      </p>
    )
  }
  if (!detail.found || !detail.original) {
    return <p className="detail">This request is no longer in headroom's recent buffer.</p>
  }
  const original = detail.original.map(viewMessage)
  const sent = detail.compressed ? detail.compressed.map(viewMessage) : original
  const changed = detail.compressed ? changedIndexes(original, sent) : new Set<number>()
  return (
    <div className="req-detail">
      <MessageList title="From the client" views={original} />
      <MessageList
        title="To the provider"
        views={sent}
        changed={changed}
        note={detail.compressed ? `${changed.size} of ${sent.length} messages changed by headroom.` : 'Sent unchanged.'}
      />
      <div className="msgs">
        <h3>Response <small>{detail.response ? `${int.format(detail.response.length)} chars` : ''}</small></h3>
        <pre className="msg-body">{detail.response ?? 'Not recorded.'}</pre>
      </div>
    </div>
  )
}

function Row({ req }: { req: RecentRequest }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle(): Promise<void> {
    const next = !open
    setOpen(next)
    if (!next || detail || loading) return
    setLoading(true)
    setError(null)
    try {
      setDetail(await window.api.requestDetail(req.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <tr className={open ? 'req open' : 'req'} onClick={() => void toggle()}>
        <td><span className="caret">{open ? '▾' : '▸'}</span> {time(req.timestamp)}</td>
        <td title={req.model ?? undefined}>{shortModel(req.model)}</td>
        <td className="num">{int.format(req.inputTokensOriginal)} → {int.format(req.inputTokensOptimized)}</td>
        <td className="num saved-cell">{req.tokensSaved > 0 ? `${int.format(req.tokensSaved)} (${req.savingsPercent.toFixed(0)}%)` : '—'}</td>
        <td className="num" title="cache read / cache write / uncached input tokens">
          {int.format(req.cacheReadTokens)} / {int.format(req.cacheWriteTokens)} / {int.format(req.uncachedInputTokens)}
        </td>
        <td className="transforms">{req.transforms.length ? req.transforms.join(', ') : 'none'}</td>
      </tr>
      {open && (
        <tr className="req-expanded">
          <td colSpan={6}>
            {loading && <p className="detail">Loading…</p>}
            {error && <p className="error-inline">{error}</p>}
            {detail && <Detail detail={detail} />}
          </td>
        </tr>
      )}
    </>
  )
}

export function RecentRequests({ recent, messagesLogged }: {
  recent: RecentRequest[]
  messagesLogged: boolean | null
}): React.JSX.Element {
  return (
    <div className="recent">
      <h3>Recent requests</h3>
      {messagesLogged === false && (
        <p className="detail">
          Metrics only: headroom is not keeping request bodies, so expanding a request will not show messages.
        </p>
      )}
      {recent.length === 0 ? (
        <p className="detail">No requests through headroom yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th className="num">Input tokens</th>
                <th className="num">Saved</th>
                <th className="num">Cache r / w / new</th>
                <th>Transforms</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => <Row key={r.id} req={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

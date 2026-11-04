import { useEffect, useRef, useState } from 'react'
import type { AppStatus, CheckProgress, CheckStep, Health } from '@shared/ipc'

const STEPS: [CheckStep, string][] = [
  ['clients', 'Client configs: Claude Code, Codex'],
  ['proxy', 'Proxy: mitmproxy ports and service'],
  ['compressor', 'headroom: health check'],
  ['stats', 'headroom: savings statistics']
]
const HIDE_AFTER_MS = 8000

type Run = { steps: Partial<Record<CheckStep, CheckProgress>>; done: boolean; result?: AppStatus; error?: string }

function summary(status: AppStatus): string {
  const parts = [['Proxy', status.proxy.health], ['headroom', status.compressor.health], ['Clients', status.clients.health]] as const
  const bad = parts.filter(([, h]) => h !== 'ok')
  return bad.length ? `Needs attention: ${bad.map(([n, h]) => `${n} ${h}`).join(', ')}` : 'All good: proxy, headroom and clients are fine'
}

/** "Check now" with what it is checking while it runs, and what it found afterwards. */
export function CheckNow({ onStatus }: { onStatus: (status: AppStatus) => void }): React.JSX.Element {
  const [run, setRun] = useState<Run | null>(null)
  const hide = useRef<number | undefined>(undefined)

  useEffect(() => window.api.onCheckProgress((p) =>
    setRun((r) => r && !r.done ? { ...r, steps: { ...r.steps, [p.step]: p } } : r)), [])
  useEffect(() => () => window.clearTimeout(hide.current), [])

  async function check(): Promise<void> {
    window.clearTimeout(hide.current)
    setRun({ steps: {}, done: false })
    try {
      const status = await window.api.refreshStatus()
      onStatus(status)
      setRun((r) => ({ steps: r?.steps ?? {}, done: true, result: status }))
    } catch (e) {
      setRun((r) => ({ steps: r?.steps ?? {}, done: true, error: e instanceof Error ? e.message : String(e) }))
    }
    hide.current = window.setTimeout(() => setRun(null), HIDE_AFTER_MS)
  }

  const running = !!run && !run.done
  const icon = (p?: CheckProgress): React.JSX.Element => {
    if (!p || p.state === 'running') return running ? <span className="spinner" aria-label="checking" /> : <span className="step-icon">–</span>
    if (p.state === 'skipped') return <span className="step-icon">–</span>
    return <span className={`dot ${p.health as Health}`} />
  }
  return (
    <div className="check-now">
      <button onClick={() => void check()} disabled={running}
        title="Re-checks the client configs, the proxy, headroom and its statistics now. The app also does this every 5 s while the window is open and every 30 s in the tray.">
        {running ? <><span className="spinner" /> Checking…</> : '↻ Check now'}
      </button>
      {run && (
        <div className="check-panel" role="status" aria-live="polite">
          <ul>
            {STEPS.map(([id, label]) => {
              const p = run.steps[id]
              return (
                <li key={id} className={p?.state ?? (running ? 'running' : 'skipped')}>
                  {icon(p)}
                  <span className="step-label">{label}</span>
                  {p?.detail && <span className="step-detail">{p.detail}</span>}
                </li>
              )
            })}
          </ul>
          {run.done && (
            <p className={`check-result ${run.error || run.result?.overall !== 'ok' ? 'warn' : 'ok'}`}>
              {run.error ? `Check failed: ${run.error}` : `${summary(run.result!)} · ${new Date(run.result!.checkedAt ?? Date.now()).toLocaleTimeString()}`}
              <button className="link" onClick={() => setRun(null)} aria-label="Close">Close</button>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

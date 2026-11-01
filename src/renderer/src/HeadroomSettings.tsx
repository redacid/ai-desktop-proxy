import { HEADROOM_COMPRESSORS, type HeadroomOptions } from '@shared/ipc'

const compressorLabels: Record<string, string> = {
  smart_crusher: 'Smart crusher (JSON, repeated lines)',
  kompress: 'Kompress (ML, prose and code)',
  code_aware: 'Code-aware (AST)',
  search: 'Search results',
  log: 'Logs',
  tabular: 'Tables',
  config: 'Config files',
  html: 'HTML',
  image: 'Images'
}

/** A number input where empty means "not set" (null). */
function OptionalNumber({ value, onChange, min, max, step, placeholder }: {
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number | 'any'
  placeholder: string
}): React.JSX.Element {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

export function HeadroomSettings({ value, onChange, external }: {
  value: HeadroomOptions
  onChange: (v: HeadroomOptions) => void
  /** headroom answers but is not run by this app: these options do not reach it */
  external: boolean
}): React.JSX.Element {
  const set = <K extends keyof HeadroomOptions>(key: K, v: HeadroomOptions[K]): void => onChange({ ...value, [key]: v })
  const allCompressors = value.compressors.length === 0
  const isOn = (c: string): boolean => allCompressors || value.compressors.includes(c)
  function toggleCompressor(c: string, on: boolean): void {
    const current = allCompressors ? [...HEADROOM_COMPRESSORS] : value.compressors
    const next = on ? [...current, c] : current.filter((x) => x !== c)
    const ordered = HEADROOM_COMPRESSORS.filter((x) => next.includes(x))
    set('compressors', ordered.length === HEADROOM_COMPRESSORS.length ? [] : ordered)
  }
  const off = !value.optimize

  return (
    <fieldset className="hr-settings">
      <legend>headroom</legend>
      <p className={external ? 'note' : 'detail'}>
        {external
          ? 'headroom is running outside this app, so these options do not apply to it. Set them where it is started.'
          : 'Options for headroom run by this app. Saving a change restarts it.'}
      </p>

      <h3>Compression</h3>
      <label className="check">
        <input type="checkbox" checked={value.optimize} onChange={(e) => set('optimize', e.target.checked)} />
        <span>Compress requests (off = pass through unchanged and only count tokens)</span>
      </label>
      <div className="row">
        <label>
          <span>Mode</span>
          <select value={value.mode} disabled={off} onChange={(e) => set('mode', e.target.value as HeadroomOptions['mode'])}>
            <option value="cache">Cache: keep earlier turns stable for the prompt cache</option>
            <option value="token">Token: compress harder, earlier turns may change</option>
          </select>
        </label>
        <label>
          <span>Target ratio</span>
          <OptionalNumber value={value.targetRatio} onChange={(v) => set('targetRatio', v)} min={0.05} max={0.95} step={0.05} placeholder="auto" />
          <small>Share of text tokens to keep, e.g. 0.4. Empty: headroom decides.</small>
        </label>
      </div>
      <label>
        <span>Recovery of compressed content</span>
        <select value={value.ccr} disabled={off} onChange={(e) => set('ccr', e.target.value as HeadroomOptions['ccr'])}>
          <option value="retrieve">Retrievable: the model can fetch omitted parts back (default)</option>
          <option value="lossless">Lossless only: no markers, no retrieval tool</option>
          <option value="off">Off: lossy, nothing to fetch back (most savings)</option>
        </select>
      </label>
      <div className="compressors">
        <span>Compressors</span>
        {HEADROOM_COMPRESSORS.map((c) => (
          <label key={c} className="check">
            <input type="checkbox" disabled={off} checked={isOn(c)} onChange={(e) => toggleCompressor(c, e.target.checked)} />
            <span>{compressorLabels[c] ?? c}</span>
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" disabled={off} checked={value.codeAware} onChange={(e) => set('codeAware', e.target.checked)} />
        <span>Enable the AST-based code compressor (<code>--code-aware</code>, off in headroom by default)</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={off} checked={!value.kompress} onChange={(e) => set('kompress', !e.target.checked)} />
        <span>Turn off ML text compression, keep structural only (<code>--disable-kompress</code>)</span>
      </label>
      <label>
        <span>Never compress results of these tools</span>
        <input type="text" placeholder="e.g. Bash, WebFetch" value={value.protectToolResults} onChange={(e) => set('protectToolResults', e.target.value)} />
        <small>Comma separated, added to headroom's built-in list.</small>
      </label>

      <h3>Limits</h3>
      <label className="check">
        <input type="checkbox" checked={value.rateLimit} onChange={(e) => set('rateLimit', e.target.checked)} />
        <span>Rate limit requests</span>
      </label>
      <div className="row">
        <label>
          <span>Requests per minute</span>
          <OptionalNumber value={value.rpm} onChange={(v) => set('rpm', v)} min={1} step={1} placeholder="60" />
        </label>
        <label>
          <span>Tokens per minute</span>
          <OptionalNumber value={value.tpm} onChange={(v) => set('tpm', v)} min={1} step={1} placeholder="unlimited" />
        </label>
      </div>
      <div className="row">
        <label>
          <span>Budget, USD</span>
          <OptionalNumber value={value.budgetUsd} onChange={(v) => set('budgetUsd', v)} min={0.01} step="any" placeholder="none" />
          <small>Requests are refused with 429 once spent.</small>
        </label>
        <label>
          <span>Budget period</span>
          <select value={value.budgetPeriod} onChange={(e) => set('budgetPeriod', e.target.value as HeadroomOptions['budgetPeriod'])}>
            <option value="hourly">Hour</option>
            <option value="daily">Day</option>
            <option value="monthly">Month</option>
          </select>
        </label>
      </div>

      <h3>Other</h3>
      <label className="check">
        <input type="checkbox" checked={value.semanticCache} onChange={(e) => set('semanticCache', e.target.checked)} />
        <span>Semantic cache</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.http2} onChange={(e) => set('http2', e.target.checked)} />
        <span>HTTP/2 to providers (turn off if you see SSLV3_ALERT_BAD_RECORD_MAC errors)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.beacon} onChange={(e) => set('beacon', e.target.checked)} />
        <span>Let headroom send anonymous session summaries to Headroom Labs (headroom's default)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.logMessages} onChange={(e) => set('logMessages', e.target.checked)} />
        <span>Keep request bodies (<code>--log-messages</code>) to inspect recent requests</span>
      </label>
      <small className="hint">headroom then holds your prompts, code and replies in memory and in its logs.</small>
      <label>
        <span>Extra arguments</span>
        <input type="text" placeholder="e.g. --memory --memory-top-k 5" value={value.extraArgs} onChange={(e) => set('extraArgs', e.target.value)} />
        <small>Passed to <code>headroom proxy</code> as is (quotes work, no shell). Host and port come from the headroom URL.</small>
      </label>
    </fieldset>
  )
}

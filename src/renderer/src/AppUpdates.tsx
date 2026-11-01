import { useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/ipc'

/** Settings and the globally visible update notice share one subscription in App. */
export function useAppUpdates(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null)
  useEffect(() => {
    const off = window.api.onUpdate(setState)
    void window.api.getUpdate().then(setState).catch(() => {})
    return off
  }, [])
  return state
}

export function AppUpdates({ state, settings = false }: { state: AppUpdateState | null; settings?: boolean }): React.JSX.Element | null {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!state) return null
  const disabled = state.phase === 'disabled'
  const working = pending || ['checking', 'downloading', 'installing'].includes(state.phase)
  const act = async (action: 'check' | 'download' | 'install'): Promise<void> => {
    setError(null); setPending(true)
    try { await window.api.updateAction(action) }
    catch (e) { setError((e as Error).message) }
    finally { setPending(false) }
  }
  if (!settings && (!state.version || dismissed === state.version)) return null
  return (
    <section className={`card app-updates ${settings ? '' : 'update-notice'}`}>
      <header><h2>{settings ? `App updates · v${state.currentVersion}` : `New version ${state.version}`}</h2></header>
      <p className="detail">{disabled ? 'Development or unpacked build. Install a release package to enable updates.'
        : state.phase === 'ready' ? 'Ready to install. The app will restart; proxy services keep running.'
        : state.phase === 'downloading' ? `Downloading… ${Math.round(state.progress)}%`
        : state.phase === 'checking' ? 'Checking for updates…'
        : state.phase === 'installing' ? 'Installing…'
        : state.version ? `Version ${state.version} is available.` : 'Checks for new releases every 2 hours.'}</p>
      {state.phase === 'downloading' && <progress max="100" value={state.progress} aria-label="Update download" />}
      {settings && <>
        <label className="update-option"><input type="checkbox" disabled={disabled || pending} checked={state.autoCheck}
          onChange={(e) => void window.api.updatePreferences({ autoCheck: e.target.checked, autoDownload: state.autoDownload }).catch((e) => setError(String(e)))} /> Automatically check every 2 hours</label>
        <label className="update-option"><input type="checkbox" disabled={disabled || pending} checked={state.autoDownload}
          onChange={(e) => void window.api.updatePreferences({ autoCheck: state.autoCheck, autoDownload: e.target.checked }).catch((e) => setError(String(e)))} /> Automatically download updates</label>
        <p className="detail">Last check: {state.checkedAt ? new Date(state.checkedAt).toLocaleString() : 'not checked yet'}</p>
      </>}
      {state.notes && <details><summary>What's changed</summary><pre className="release-notes">{state.notes}</pre></details>}
      {(error || state.error) && <p className="error-inline" role="alert">{error ?? state.error}</p>}
      <div className="actions">
        {!settings && <button onClick={() => setDismissed(state.version)}>Later</button>}
        {settings && <button disabled={disabled || working || state.phase === 'ready'} onClick={() => void act('check')}>Check for updates</button>}
        {state.version && !['ready', 'installing', 'downloading'].includes(state.phase) && <button disabled={working} onClick={() => void act('download')}>Download update</button>}
        {state.phase === 'ready' && <button className="primary" disabled={pending} onClick={() => void act('install')}>Update and restart</button>}
      </div>
    </section>
  )
}

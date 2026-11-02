import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import type { AppUpdateState, UpdatePreferences } from '@shared/ipc'
import { writeJsonAtomic } from './fsutil'

export const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000
export interface UpdateBackend extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(silent?: boolean, restart?: boolean): void
  /** Set by electron-updater once the package is downloaded. */
  readonly installerPath?: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** GitHub sends release notes as HTML; the window shows them as text, never as markup. */
export function notesText(notes: string): string {
  return notes
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>|<\/(p|li|ul|ol|h[1-6]|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === 'x' ? 2 : 1), e[1].toLowerCase() === 'x' ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m)
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}

/** What to show when the package manager step of an install fails. */
export function installError(message: string, installerPath?: string | null): string {
  const manual = installerPath ? ` To install it by hand: sudo apt install ${installerPath} (deb) or sudo dnf install ${installerPath} (rpm).` : ''
  // pkexec exits with 126/127 when the password dialog is cancelled, fails or cannot be shown.
  if (/pkexec exited with code 12[67]/.test(message)) {
    return `The update was not installed: administrator authentication was cancelled or failed. Press Update and restart to try again.${manual}`
  }
  return `The update was not installed: ${message}.${manual}`
}

/** Only the app updates here; proxy/headroom services outlive its restart. */
export class AppUpdates extends EventEmitter {
  private timer?: NodeJS.Timeout
  private working = false
  private state: AppUpdateState

  constructor(private backend: UpdateBackend | null, currentVersion: string, private file: string,
    private busy: () => boolean, private now = Date.now) {
    super()
    this.state = { currentVersion, version: null, phase: backend ? 'idle' : 'disabled', progress: 0, notes: '', error: null,
      checkedAt: null, autoCheck: true, autoDownload: true }
    if (!backend) return
    backend.autoDownload = false // Managed here so every download has a handled rejection.
    backend.autoInstallOnAppQuit = false
    backend.allowPrerelease = false
    backend.allowDowngrade = false
    backend.on('error', (err: Error) => {
      // A failed install leaves the downloaded package in place, so offer the install again.
      if (this.state.phase === 'installing') this.patch({ phase: 'ready', error: installError(err.message, backend.installerPath) })
      else this.patch({ phase: 'error', error: err.message })
    })
    backend.on('update-available', (info: { version: string; releaseNotes?: string | { note: string | null }[] | null }) => {
      const notes = notesText(typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes ?? []).map((n) => n.note ?? '').join('\n'))
      this.patch({ phase: 'available', version: info.version, notes, progress: 0 })
    })
    backend.on('update-not-available', () => this.patch({ phase: 'idle', version: null, notes: '' }))
    backend.on('download-progress', (p: { percent: number }) => this.patch({ phase: 'downloading', progress: p.percent }))
    backend.on('update-downloaded', () => this.patch({ phase: 'ready', progress: 100 }))
  }

  get current(): AppUpdateState { return { ...this.state } }
  private patch(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.current)
  }
  private async persist(): Promise<void> {
    const { autoCheck, autoDownload, checkedAt } = this.state
    await writeJsonAtomic(this.file, { autoCheck, autoDownload, checkedAt })
  }
  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'))
      for (const key of ['autoCheck', 'autoDownload'] as const) if (typeof saved[key] === 'boolean') this.state[key] = saved[key]
      if (typeof saved.checkedAt === 'number' && saved.checkedAt <= this.now()) this.state.checkedAt = saved.checkedAt
    } catch { /* First launch or invalid settings: use defaults. */ }
    this.patch({})
    if (!this.backend) return
    this.stop()
    // Check the durable two-hour cadence every minute, also after sleep/resume.
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref()
    await this.tick()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async tick(): Promise<void> {
    if (this.state.autoCheck && (this.state.checkedAt === null || this.now() - this.state.checkedAt >= UPDATE_INTERVAL_MS)) await this.check()
  }
  async preferences(prefs: UpdatePreferences): Promise<AppUpdateState> {
    if (typeof prefs.autoCheck !== 'boolean' || typeof prefs.autoDownload !== 'boolean') throw new Error('Invalid update preferences')
    this.patch({ autoCheck: prefs.autoCheck, autoDownload: prefs.autoDownload })
    await this.persist()
    return this.current
  }
  async check(): Promise<AppUpdateState> {
    if (!this.backend || this.working || this.state.phase === 'ready' || this.state.phase === 'installing') return this.current
    this.working = true
    this.patch({ phase: 'checking', error: null, checkedAt: this.now() })
    try {
      await this.persist()
      await this.backend.checkForUpdates()
      if (this.state.autoDownload && this.state.phase === 'available') await this.downloadCore()
    } catch (err) { this.patch({ phase: 'error', error: (err as Error).message }) }
    finally { this.working = false }
    return this.current
  }
  private async downloadCore(): Promise<void> {
    this.patch({ phase: 'downloading', error: null })
    await this.backend!.downloadUpdate()
  }
  async download(): Promise<AppUpdateState> {
    if (!this.backend || this.working || !this.state.version || this.state.phase === 'ready') return this.current
    this.working = true
    try { await this.downloadCore() }
    catch (err) { this.patch({ phase: 'error', error: (err as Error).message }) }
    finally { this.working = false }
    return this.current
  }
  install(): AppUpdateState {
    if (this.busy()) throw new Error('Wait for the current service or tool operation to finish, then retry.')
    if (!this.backend || this.state.phase !== 'ready') throw new Error('Download the update first.')
    this.patch({ phase: 'installing', error: null })
    try { this.backend.quitAndInstall(false, true) }
    catch (err) { this.patch({ phase: 'ready', error: installError((err as Error).message, this.backend.installerPath) }) }
    return this.current
  }
}

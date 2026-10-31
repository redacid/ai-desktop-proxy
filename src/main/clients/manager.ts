import { watch, type FSWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { ClientInfo } from '@shared/ipc'
import { buildProxyEnv, isPortListening, type ProxyEnv } from '../proxy-env'
import type { AppStore } from '../store'
import { exists } from '../fsutil'
import { ClientConflictError, type ClientAdapter } from './types'

const DEBOUNCE_MS = 500

/**
 * Keeps client configs in the state the user asked for. Checks run at start,
 * when a watched config directory changes, and on a timer. A config that lost
 * our settings is repaired (if autoRepair is on and the proxy is up); a config
 * where someone else set the same variables is only reported, never overwritten.
 */
export class ClientManager extends EventEmitter {
  private infos = new Map<string, ClientInfo>()
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private running: Promise<ClientInfo[]> | null = null

  constructor(
    private readonly adapters: ClientAdapter[],
    private readonly store: AppStore,
    private readonly proxyUp: (port: number) => Promise<boolean> = isPortListening,
    private readonly caExists: (path: string) => Promise<boolean> = exists
  ) {
    super()
  }

  get list(): ClientInfo[] {
    return this.adapters.map((a) => this.infos.get(a.id)).filter((i): i is ClientInfo => !!i)
  }

  private env(): ProxyEnv {
    return buildProxyEnv(this.store.settings.proxyPort, this.store.settings.caFile)
  }

  /** Why turning a client on now would break it, or null when it is safe. */
  async proxyProblem(): Promise<string | null> {
    const { proxyPort, caFile } = this.store.settings
    if (!(await this.proxyUp(proxyPort))) return `proxy is not listening on 127.0.0.1:${proxyPort}`
    if (!(await this.caExists(caFile))) return `proxy CA certificate not found at ${caFile}`
    return null
  }

  start(): void {
    this.stop()
    for (const adapter of this.adapters) {
      for (const dir of adapter.watchPaths()) {
        try {
          // Watch the directory: editors and our own atomic writes replace the file.
          const w = watch(dir, () => this.scheduleCheck())
          w.on('error', () => w.close())
          this.watchers.push(w)
        } catch {
          // Directory missing (client not installed); the timer still checks it.
        }
      }
    }
    void this.checkNow()
    this.timer = setInterval(() => void this.checkNow(), this.store.settings.checkIntervalSec * 1000)
  }

  stop(): void {
    this.watchers.forEach((w) => w.close())
    this.watchers = []
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.timer = this.debounce = null
  }

  private scheduleCheck(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.checkNow(), DEBOUNCE_MS)
  }

  /** Runs one check; concurrent callers share it. */
  checkNow(): Promise<ClientInfo[]> {
    this.running ??= this.check().finally(() => (this.running = null))
    return this.running
  }

  private async check(): Promise<ClientInfo[]> {
    const env = this.env()
    for (const adapter of this.adapters) {
      const prefs = this.store.client(adapter.id)
      let { state, detail } = await adapter.inspect(env)

      const lost = state === 'absent' || state === 'partial'
      if (prefs.enabled && lost && this.store.settings.autoRepair) {
        const problem = await this.proxyProblem()
        if (problem) {
          detail = `settings missing, not restored: ${problem}`
        } else {
          try {
            const applied = await adapter.apply(env, prefs.applied)
            await this.store.updateClient(adapter.id, { applied })
            ;({ state, detail } = await adapter.inspect(env))
            detail = `restored: ${detail}`
          } catch (err) {
            detail = `restore failed: ${(err as Error).message}`
          }
        }
      }
      this.infos.set(adapter.id, this.info(adapter, prefs.enabled, state, detail))
    }
    this.emit('change', this.list)
    return this.list
  }

  private info(adapter: ClientAdapter, enabled: boolean, state: ClientInfo['state'], detail: string): ClientInfo {
    return {
      id: adapter.id,
      name: adapter.name,
      configPath: adapter.configPath,
      enabled,
      state,
      detail,
      checkedAt: new Date().toISOString()
    }
  }

  /**
   * Turns a client on or off. Turning on refuses while the proxy is down, since
   * the client would then fail every request. Returns an error message or null.
   */
  async setEnabled(id: string, enabled: boolean): Promise<string | null> {
    const adapter = this.adapters.find((a) => a.id === id)
    if (!adapter) return `unknown client ${id}`
    const env = this.env()
    const prefs = this.store.client(id)
    try {
      if (enabled) {
        const problem = await this.proxyProblem()
        if (problem) return `not enabled: ${problem}`
        const applied = await adapter.apply(env, prefs.applied)
        await this.store.updateClient(id, { enabled: true, applied })
      } else {
        await adapter.remove(prefs.applied, env)
        await this.store.updateClient(id, { enabled: false, applied: null })
      }
      return null
    } catch (err) {
      return err instanceof ClientConflictError ? err.message : `failed: ${(err as Error).message}`
    } finally {
      await this.running // a check that started before our write would report stale state
      await this.checkNow()
    }
  }
}

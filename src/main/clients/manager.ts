import { watch, type FSWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { ClientInfo } from '@shared/ipc'
import { buildProxyEnv, isPortListening, type ProxyEnv } from '../proxy-env'
import type { AppStore, ClientPrefs } from '../store'
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
  /** Set while the user has stopped the proxy: lost settings are not restored. */
  private held = false

  constructor(
    private readonly adapters: ClientAdapter[],
    private readonly store: AppStore,
    private readonly proxyUp: (port: number) => Promise<boolean> = isPortListening,
    private readonly caExists: (path: string) => Promise<boolean> = exists,
    /** How long the proxy must stay down before client settings are pulled. */
    private readonly confirmDownMs = 5000,
    /** Whether our proxy service holds a port; fails closed by default. */
    private readonly portOurs: (port: number) => Promise<boolean> = async () => false
  ) {
    super()
  }

  get list(): ClientInfo[] {
    return this.adapters.map((a) => this.infos.get(a.id)).filter((i): i is ClientInfo => !!i)
  }

  private env(): ProxyEnv {
    const { proxyPort, caFile, codexPort } = this.store.settings
    return buildProxyEnv(proxyPort, caFile, codexPort)
  }

  /** Why turning this client on now would break it or leak its credentials, or null when it is safe. */
  private async clientProblem(adapter: ClientAdapter): Promise<string | null> {
    const problem = await this.proxyProblem()
    if (problem || !adapter.plaintextPort) return problem
    return this.leakProblem(adapter, adapter.plaintextPort(this.env()))
  }

  private async leakProblem(adapter: ClientAdapter, port: number): Promise<string | null> {
    return (await this.portOurs(port))
      ? null
      : `127.0.0.1:${port} is not held by our proxy service, and ${adapter.name} would send its credentials there unencrypted`
  }

  /**
   * The plaintext port the client's config points at now: the one we last wrote,
   * which differs from the settings while a port change is being repaired.
   */
  private configuredPort(adapter: ClientAdapter, prefs: ClientPrefs): number | null {
    if (!adapter.plaintextPort) return null
    const port = prefs.applied ? Number(new URL(prefs.applied.proxyUrl).port) : NaN
    return Number.isInteger(port) && port > 0 ? port : adapter.plaintextPort(this.env())
  }

  /** Why turning a client on now would break it, or null when it is safe. */
  async proxyProblem(): Promise<string | null> {
    const { proxyPort, codexPort, caFile } = this.store.settings
    // One mitmdump serves both listeners, so either one missing means it is not ours or not ready.
    for (const port of [proxyPort, codexPort]) {
      if (!(await this.proxyUp(port))) return `proxy is not listening on 127.0.0.1:${port}`
    }
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

  /** True when the proxy is down now and still down after a short wait (not just restarting). */
  private async proxyDownConfirmed(): Promise<string | null> {
    if (!(await this.proxyProblem())) return null
    await new Promise((r) => setTimeout(r, this.confirmDownMs))
    return this.proxyProblem()
  }

  /**
   * Removes our settings from every enabled client but keeps it enabled, and
   * holds off restoring them until resume(). Used before the user stops or
   * removes the proxy, so no client points at a proxy that is gone.
   */
  async suspendAll(): Promise<void> {
    this.held = true
    await this.running // a check in flight could re-apply right after we remove
    const env = this.env()
    for (const adapter of this.adapters) {
      const prefs = this.store.client(adapter.id)
      if (!prefs.enabled) continue
      try {
        await adapter.remove(prefs.applied, env)
        await this.store.updateClient(adapter.id, { applied: null })
      } catch (err) {
        console.error(`suspending ${adapter.id}:`, err)
      }
    }
    await this.checkNow()
  }

  /** Lets checks restore enabled clients again (after the proxy is started). */
  async resume(): Promise<void> {
    this.held = false
    await this.running
    await this.checkNow()
  }

  private async check(): Promise<ClientInfo[]> {
    const env = this.env()
    let down: string | null | undefined // proxy state, probed at most once per check
    for (const adapter of this.adapters) {
      const prefs = this.store.client(adapter.id)
      let { state, detail } = await adapter.inspect(env, prefs.applied)
      let suspended = false

      // A plaintext client is pulled at once, without waiting out a restart: any
      // moment its port is not ours, someone else may be reading its credentials.
      const port = this.configuredPort(adapter, prefs)
      const leak = port !== null && (state === 'applied' || state === 'partial') ? await this.leakProblem(adapter, port) : null
      if (prefs.enabled && (leak || state === 'applied')) {
        if (!leak) down ??= await this.proxyDownConfirmed()
        const problem = leak ?? down
        if (problem) {
          try {
            await adapter.remove(prefs.applied, env)
            await this.store.updateClient(adapter.id, { applied: null })
            ;({ state } = await adapter.inspect(env, null))
            detail = `${leak ? 'unsafe' : 'proxy down'} (${problem}): settings removed until it is back`
            suspended = true
          } catch (err) {
            detail = `${leak ? 'unsafe' : 'proxy down'}, could not remove settings: ${(err as Error).message}`
          }
        }
      }

      const lost = state === 'absent' || state === 'partial'
      if (prefs.enabled && lost && !suspended && this.store.settings.autoRepair) {
        const problem = this.held ? 'proxy stopped from the app' : down ?? (await this.clientProblem(adapter))
        if (problem) {
          detail = `waiting for the proxy, settings will be restored: ${problem}`
        } else {
          try {
            const applied = await adapter.apply(env, prefs.applied)
            await this.store.updateClient(adapter.id, { applied })
            ;({ state, detail } = await adapter.inspect(env, applied))
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
        const problem = await this.clientProblem(adapter)
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

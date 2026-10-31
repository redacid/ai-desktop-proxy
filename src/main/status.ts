import { EventEmitter } from 'node:events'
import type { AppStatus, ComponentStatus, Health } from '@shared/ipc'

const unknown: ComponentStatus = { health: 'unknown', detail: 'not checked yet' }

/** Combines component health: any down -> down, any degraded/unknown -> degraded, else ok. */
export function overallHealth(parts: Health[]): Health {
  if (parts.includes('down')) return 'down'
  if (parts.every((p) => p === 'ok')) return 'ok'
  if (parts.every((p) => p === 'unknown')) return 'unknown'
  return 'degraded'
}

/**
 * Polls the proxy, the compressor and the client configs. Stage 1 has no real
 * checks yet; ProxyManager, CompressorBackend and ClientAdapter plug in here.
 */
export class StatusMonitor extends EventEmitter {
  private status: AppStatus = {
    overall: 'unknown',
    proxy: unknown,
    compressor: unknown,
    clients: unknown,
    checkedAt: null
  }
  private timer: NodeJS.Timeout | null = null

  get current(): AppStatus {
    return this.status
  }

  async refresh(): Promise<AppStatus> {
    const proxy: ComponentStatus = { health: 'unknown', detail: 'ProxyManager: stage 3' }
    const compressor: ComponentStatus = { health: 'unknown', detail: 'headroom: stage 4' }
    const clients: ComponentStatus = { health: 'unknown', detail: 'Claude Code: stage 2' }
    this.status = {
      overall: overallHealth([proxy.health, compressor.health, clients.health]),
      proxy,
      compressor,
      clients,
      checkedAt: new Date().toISOString()
    }
    this.emit('change', this.status)
    return this.status
  }

  /** Restarts polling with a new interval, e.g. faster while the window is visible. */
  start(intervalMs: number): void {
    this.stop()
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

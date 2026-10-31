import { EventEmitter } from 'node:events'
import type { AppStatus, ClientInfo, ComponentStatus, CompressorStats, Health, ProxyInfo } from '@shared/ipc'

/** Combines component health: any down -> down, all ok -> ok, all unknown -> unknown, else degraded. */
export function overallHealth(parts: Health[]): Health {
  if (parts.includes('down')) return 'down'
  if (parts.every((p) => p === 'ok')) return 'ok'
  if (parts.every((p) => p === 'unknown')) return 'unknown'
  return 'degraded'
}

/** One line for the Clients card: problems with enabled clients first. */
export function clientsStatus(list: ClientInfo[]): ComponentStatus {
  const enabled = list.filter((c) => c.enabled)
  if (!enabled.length) return { health: 'ok', detail: 'no client is routed through the proxy' }
  const broken = enabled.filter((c) => c.state !== 'applied')
  if (broken.length) {
    return { health: 'degraded', detail: broken.map((c) => `${c.name}: ${c.state}`).join(', ') }
  }
  return { health: 'ok', detail: `routed: ${enabled.map((c) => c.name).join(', ')}` }
}

/** One line for the Proxy card from what ProxyManager found. */
export function proxyStatus(info: ProxyInfo): ComponentStatus {
  const where = `127.0.0.1:${info.port}`
  if (info.listening) {
    if (info.unit === 'legacy') return { health: 'degraded', detail: `running from the cdp.sh unit; set it up here to switch` }
    if (info.unit === 'outdated') return { health: 'degraded', detail: `settings or app changed; apply to update the service` }
    if (!info.active) return { health: 'degraded', detail: `${where} is served by something other than our service` }
    if (!info.caExists) return { health: 'degraded', detail: 'CA certificate is missing' }
    return { health: 'ok', detail: `listening on ${where}` }
  }
  if (!info.mitmdump) return { health: 'down', detail: 'mitmproxy is not installed' }
  if (info.unit === 'missing') return { health: 'down', detail: 'service is not set up' }
  return { health: 'down', detail: `service is stopped; nothing listens on ${where}` }
}

export interface StatusSources {
  proxyInfo(): Promise<ProxyInfo>
  proxy(info: ProxyInfo): Promise<ComponentStatus>
  compressor(): Promise<ComponentStatus>
  stats(): Promise<CompressorStats>
  clients(): Promise<ClientInfo[]>
}

const unknown: ComponentStatus = { health: 'unknown', detail: 'not checked yet' }

/** Polls every component and emits 'change' with the combined status. */
export class StatusMonitor extends EventEmitter {
  private status: AppStatus = {
    overall: 'unknown',
    proxy: unknown,
    proxyInfo: null,
    compressor: unknown,
    clients: unknown,
    clientList: [],
    stats: null,
    checkedAt: null
  }
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly sources: StatusSources) {
    super()
  }

  get current(): AppStatus {
    return this.status
  }

  async refresh(): Promise<AppStatus> {
    const [proxyInfo, compressor, clientList] = await Promise.all([
      this.sources.proxyInfo(),
      this.sources.compressor(),
      this.sources.clients()
    ])
    const proxy = await this.sources.proxy(proxyInfo)
    let stats = this.status.stats // keep the last numbers if headroom blips
    if (compressor.health === 'ok') {
      try {
        stats = await this.sources.stats()
      } catch {
        // stats are optional; health already says headroom answers
      }
    }
    const clients = clientsStatus(clientList)
    this.status = {
      overall: overallHealth([proxy.health, compressor.health, clients.health]),
      proxy,
      proxyInfo,
      compressor,
      clients,
      clientList,
      stats,
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

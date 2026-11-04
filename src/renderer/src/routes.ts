/**
 * Which way requests travel right now, derived from the status: client → mitmproxy → headroom → provider, the
 * fallback straight from mitmproxy to the provider while headroom is down, and the direct path of clients that are
 * not routed (or whose settings the app removed because the proxy is down). Pure, so it is unit tested.
 */
import type { AppStatus, ClientInfo, ToolInfo } from '@shared/ipc'

export type Route = 'compressed' | 'uncompressed' | 'direct' | 'none'

export interface FlowState {
  /** client → proxy, proxy → headroom, headroom → provider */
  main: [boolean, boolean, boolean]
  /** proxy → provider while headroom does not answer */
  bypass: boolean
  /** client → provider without the proxy */
  direct: boolean
  routes: { id: string; name: string; route: Route; provider: string }[]
}

const PROVIDER: Record<string, string> = { 'claude-code': 'Anthropic', codex: 'OpenAI' }

export function routeOf(client: ClientInfo, proxyUp: boolean, headroomUp: boolean): Route {
  if (client.state === 'missing') return 'none'
  if (!client.enabled || client.state !== 'applied' || !proxyUp) return 'direct'
  return headroomUp ? 'compressed' : 'uncompressed'
}

export function flowState(status: AppStatus): FlowState {
  const proxyUp = !!status.proxyInfo?.listening
  // degraded still answers (e.g. slow); only down means mitmproxy falls back.
  const headroomUp = status.compressor.health === 'ok' || status.compressor.health === 'degraded'
  const routes = status.clientList.map((c) => ({
    id: c.id, name: c.name, route: routeOf(c, proxyUp, headroomUp), provider: PROVIDER[c.id] ?? 'provider'
  }))
  const has = (r: Route): boolean => routes.some((x) => x.route === r)
  const proxied = has('compressed') || has('uncompressed')
  return {
    main: [proxied, has('compressed'), has('compressed')],
    bypass: has('uncompressed'),
    direct: has('direct'),
    routes
  }
}

export const ROUTE_LABEL: Record<Route, string> = {
  compressed: 'compressed by headroom',
  uncompressed: 'through the proxy, uncompressed: headroom is down',
  direct: 'direct, not through the proxy',
  none: 'not installed'
}

export type ClientKey = 'claude' | 'codex'
export const clientKey = (id: string): ClientKey | null => id === 'claude-code' ? 'claude' : id === 'codex' ? 'codex' : null

/** Per-client tools. Plugins have one entry per client; the others report per client whether they are connected. */
const TOOLS: { name: string; id: (c: ClientKey) => string; plugin: boolean; clients: ClientKey[] }[] = [
  { name: 'RTK', id: () => 'rtk', plugin: false, clients: ['claude', 'codex'] },
  { name: 'Ponytail', id: (c) => `ponytail-${c}`, plugin: true, clients: ['claude', 'codex'] },
  { name: 'Chisle', id: () => 'chisle-claude', plugin: true, clients: ['claude'] },
  { name: 'Caveman', id: () => 'caveman-claude', plugin: true, clients: ['claude'] },
  { name: 'Serena', id: () => 'serena', plugin: false, clients: ['claude', 'codex'] },
  { name: 'MarkItDown', id: () => 'markitdown', plugin: false, clients: ['claude', 'codex'] },
  { name: 'Context7', id: () => 'context7', plugin: false, clients: ['claude', 'codex'] },
  { name: 'Codebase Memory', id: () => 'codebase-memory', plugin: false, clients: ['claude', 'codex'] }
]

export interface ToolChip { name: string; active: boolean | null; title: string }

/** The tools that can work in this client, and whether each is active there (null = could not tell). */
export function clientTools(tools: ToolInfo[], client: ClientKey): ToolChip[] {
  return TOOLS.filter((t) => t.clients.includes(client)).map((t): ToolChip => {
    const tool = tools.find((x) => x.id === t.id(client))
    if (!tool || tool.installed === null) return { name: t.name, active: null, title: `${t.name}: not checked yet` }
    if (t.plugin) {
      const active = tool.installed && tool.enabled !== false
      return { name: t.name, active, title: `${t.name}: ${!tool.installed ? 'not installed' : active ? 'enabled' : 'installed, disabled'}` }
    }
    if (tool.foreign?.[client]) return { name: t.name, active: true, title: `${t.name}: set up outside this app` }
    const connected = tool.installed ? tool.connected?.[client] ?? null : false
    return { name: t.name, active: connected, title: `${t.name}: ${connected === null ? 'unknown' : connected ? 'connected' : 'not connected'}` }
  })
}

/**
 * Which way requests travel right now, derived from the status: client → mitmproxy → headroom → provider, the
 * fallback straight from mitmproxy to the provider while headroom is down, and the direct path of clients that are
 * not routed (or whose settings the app removed because the proxy is down). Pure, so it is unit tested.
 */
import type { AppStatus, ClientInfo } from '@shared/ipc'

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

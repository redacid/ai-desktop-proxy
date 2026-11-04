import { describe, expect, it } from 'vitest'
import type { AppStatus, ClientInfo, ComponentStatus } from '@shared/ipc'
import { flowState } from './routes'

const client = (id: string, patch: Partial<ClientInfo> = {}): ClientInfo => ({
  id, name: id, configPath: '/x', enabled: true, state: 'applied', detail: '', checkedAt: '', ...patch
})
const status = (listening: boolean, headroom: ComponentStatus['health'], clientList: ClientInfo[]): AppStatus => ({
  overall: 'ok', proxy: { health: 'ok', detail: '' }, compressor: { health: headroom, detail: '' }, clients: { health: 'ok', detail: '' },
  proxyInfo: { listening } as AppStatus['proxyInfo'], compressorInfo: null, clientList, stats: null, checkedAt: null
})

describe('flowState', () => {
  it('goes through headroom when everything answers', () => {
    const f = flowState(status(true, 'ok', [client('claude-code'), client('codex')]))
    expect(f).toMatchObject({ main: [true, true, true], bypass: false, direct: false })
    expect(f.routes.map((r) => [r.route, r.provider])).toEqual([['compressed', 'Anthropic'], ['compressed', 'OpenAI']])
  })
  it('falls back from the proxy straight to the provider while headroom is down', () => {
    expect(flowState(status(true, 'down', [client('claude-code')]))).toMatchObject({ main: [true, false, false], bypass: true, direct: false })
  })
  it('shows clients going direct when they are not routed or the proxy is down', () => {
    const mixed = flowState(status(true, 'ok', [client('claude-code'), client('codex', { enabled: false, state: 'absent' })]))
    expect(mixed).toMatchObject({ main: [true, true, true], direct: true })
    expect(flowState(status(false, 'ok', [client('claude-code')]))).toMatchObject({ main: [false, false, false], bypass: false, direct: true })
  })
  it('ignores clients that are not installed', () => {
    const f = flowState(status(true, 'ok', [client('codex', { enabled: false, state: 'missing' })]))
    expect(f).toMatchObject({ main: [false, false, false], bypass: false, direct: false })
    expect(f.routes[0].route).toBe('none')
  })
})

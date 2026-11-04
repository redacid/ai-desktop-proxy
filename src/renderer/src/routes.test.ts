import { describe, expect, it } from 'vitest'
import type { AppStatus, ClientInfo, ComponentStatus, ToolInfo } from '@shared/ipc'
import { clientTools, flowState } from './routes'

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

describe('clientTools', () => {
  const tool = (id: string, patch: Partial<ToolInfo> = {}): ToolInfo => ({ id, name: id, installed: true, version: null, latest: null,
    updateAvailable: false, checkedAt: null, error: null, blocked: null, detail: '', stats: null, ...patch } as ToolInfo)
  const tools = [
    tool('rtk', { connected: { claude: true, codex: false } }),
    tool('ponytail-claude', { enabled: true }), tool('ponytail-codex', { enabled: false }),
    tool('chisle-claude', { installed: false }), tool('caveman-claude', { installed: null }),
    tool('serena', { connected: { claude: false, codex: false }, foreign: { claude: true, codex: false } }),
    tool('context7', { connected: { claude: true, codex: true } })
  ]
  it('marks what is active in each client', () => {
    const chips = (c: 'claude' | 'codex'): Record<string, boolean | null> => Object.fromEntries(clientTools(tools, c).map((t) => [t.name, t.active]))
    expect(chips('claude')).toEqual({ RTK: true, Ponytail: true, Chisle: false, Caveman: null, Serena: true, MarkItDown: null, Context7: true, 'Codebase Memory': null })
    expect(chips('codex')).toEqual({ RTK: false, Ponytail: false, Serena: false, MarkItDown: null, Context7: true, 'Codebase Memory': null })
    expect(clientTools(tools, 'codex').find((t) => t.name === 'Ponytail')?.title).toBe('Ponytail: installed, disabled')
  })
})

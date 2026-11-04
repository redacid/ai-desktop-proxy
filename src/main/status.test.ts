import { describe, expect, it } from 'vitest'
import type { CheckProgress, ClientInfo, CompressorStats, ProxyInfo } from '@shared/ipc'
import { clientsStatus, overallHealth, proxyStatus, StatusMonitor } from './status'

describe('overallHealth', () => {
  it('is down when any part is down', () => {
    expect(overallHealth(['ok', 'down', 'ok'])).toBe('down')
  })
  it('is ok only when every part is ok', () => {
    expect(overallHealth(['ok', 'ok'])).toBe('ok')
  })
  it('is degraded on a mix', () => {
    expect(overallHealth(['ok', 'unknown'])).toBe('degraded')
    expect(overallHealth(['ok', 'degraded'])).toBe('degraded')
  })
  it('is unknown before any check', () => {
    expect(overallHealth(['unknown', 'unknown'])).toBe('unknown')
  })
})

describe('clientsStatus', () => {
  const client = (patch: Partial<ClientInfo>): ClientInfo => ({
    id: 'c', name: 'Claude Code', configPath: '/x', enabled: true, state: 'applied', detail: '', checkedAt: '', ...patch
  })
  it('is ok when nothing is enabled', () => {
    expect(clientsStatus([client({ enabled: false, state: 'absent' })]).health).toBe('ok')
  })
  it('is degraded when an enabled client lost its settings', () => {
    expect(clientsStatus([client({ state: 'partial' })])).toEqual({ health: 'degraded', detail: 'Claude Code: partial' })
  })
})

describe('proxyStatus', () => {
  const info = { port: 8877, codexPort: 8878, mitmdump: '/m', uv: '/uv', unit: 'current' as const, active: true, listening: true, codexListening: true, caExists: true, owner: { pid: 7, name: 'mitmdump' }, ours: true }
  it('is ok when our service serves', () => {
    expect(proxyStatus(info).health).toBe('ok')
    expect(proxyStatus({ ...info, codexListening: false })).toMatchObject({ health: 'degraded' })
  })
  it('names a foreign process on the port', () => {
    expect(proxyStatus({ ...info, ours: false, owner: { pid: 42, name: 'mitmdump' } }).detail).toMatch(/held by mitmdump \(pid 42\)/)
  })
  it('asks to migrate a legacy unit', () => {
    expect(proxyStatus({ ...info, unit: 'legacy' })).toMatchObject({ health: 'degraded' })
  })
  it('explains why it is down', () => {
    expect(proxyStatus({ ...info, listening: false, mitmdump: null }).detail).toMatch(/not installed/)
    expect(proxyStatus({ ...info, listening: false, unit: 'missing' }).detail).toMatch(/not set up/)
    expect(proxyStatus({ ...info, listening: false, active: false }).detail).toMatch(/stopped/)
  })
})

describe('StatusMonitor.refresh progress', () => {
  const sources = (headroom: 'ok' | 'down', stats: () => Promise<CompressorStats>) => new StatusMonitor({
    proxyInfo: async () => ({ listening: true } as ProxyInfo),
    proxy: async () => ({ health: 'ok', detail: 'listening' }),
    compressorInfo: async () => ({ local: true } as never),
    compressor: async () => ({ health: headroom, detail: headroom }),
    stats,
    clients: async () => []
  })
  it('reports each component as it is checked', async () => {
    const steps: CheckProgress[] = []
    await sources('ok', async () => ({ recent: [1, 2] } as unknown as CompressorStats)).refresh((p) => steps.push(p))
    expect(steps.filter((p) => p.state === 'done').map((p) => [p.step, p.health])).toEqual(expect.arrayContaining([
      ['proxy', 'ok'], ['compressor', 'ok'], ['stats', 'ok']]))
    expect(steps.find((p) => p.step === 'stats' && p.state === 'done')?.detail).toBe('2 recent requests')
  })
  it('skips statistics while headroom is down, and says why stats failed', async () => {
    const steps: CheckProgress[] = []
    await sources('down', async () => { throw new Error('x') }).refresh((p) => steps.push(p))
    expect(steps.at(-1)).toEqual({ step: 'stats', state: 'skipped', detail: 'headroom is not answering' })
    const failed: CheckProgress[] = []
    await sources('ok', async () => { throw new Error('x') }).refresh((p) => failed.push(p))
    expect(failed.at(-1)).toMatchObject({ step: 'stats', health: 'degraded' })
  })
})

import { describe, expect, it } from 'vitest'
import type { ClientInfo } from '@shared/ipc'
import { clientsStatus, overallHealth, proxyStatus } from './status'

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
  const info = { port: 8877, mitmdump: '/m', uv: '/uv', unit: 'current' as const, active: true, listening: true, caExists: true, owner: { pid: 7, name: 'mitmdump' }, ours: true }
  it('is ok when our service serves', () => {
    expect(proxyStatus(info).health).toBe('ok')
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

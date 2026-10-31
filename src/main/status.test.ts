import { describe, expect, it } from 'vitest'
import type { ClientInfo } from '@shared/ipc'
import { clientsStatus, overallHealth } from './status'

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

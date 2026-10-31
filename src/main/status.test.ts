import { describe, expect, it } from 'vitest'
import { overallHealth } from './status'

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

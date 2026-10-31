import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseStatsHistory } from './headroom'

const example = JSON.parse(readFileSync(join(__dirname, '../../../examples/headroom-stats.json'), 'utf8'))

describe('parseStatsHistory', () => {
  it('reads the example response', () => {
    const stats = parseStatsHistory(example)
    expect(stats.lifetime).toEqual({
      requests: 920,
      tokensSaved: 609757,
      totalInputTokens: 105036600,
      compressionSavingsUsd: 4.188456,
      cacheSavingsUsd: 196.097084,
      totalInputCostUsd: 18.720418
    })
    expect(stats.session).toMatchObject({ requests: 36, tokensSaved: 29332, startedAt: '2026-10-31T07:52:02Z' })
    expect(stats.daily).toHaveLength(14)
    expect(stats.daily[0]).toEqual({ day: '2026-10-09', tokensSaved: 32317, compressionSavingsUsd: 0.063816 })
  })

  it('tolerates missing optional parts', () => {
    const stats = parseStatsHistory({ lifetime: { requests: 'x' } })
    expect(stats.lifetime.requests).toBe(0)
    expect(stats.session).toBeNull()
    expect(stats.daily).toEqual([])
  })

  it('rejects something that is not stats', () => {
    expect(() => parseStatsHistory({ status: 'ok' })).toThrow()
  })
})

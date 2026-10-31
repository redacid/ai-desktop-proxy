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

const feedExample = JSON.parse(readFileSync(join(__dirname, '../../../examples/headroom-feed.json'), 'utf8'))

describe('parseFeed / detailFromFeed', () => {
  it('reads metrics newest first', async () => {
    const { parseFeed } = await import('./headroom')
    const feed = parseFeed(feedExample)
    expect(feed.logged).toBe(true)
    expect(feed.items.map((i) => i.id)).toEqual(['hr_req_0002', 'hr_req_0001'])
    expect(feed.items[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      inputTokensOriginal: 5210,
      inputTokensOptimized: 1180,
      tokensSaved: 4030,
      transforms: ['smart_crusher:tool_result', 'cache_align'],
      cacheReadTokens: 18240
    })
  })

  it('returns bodies for one request, and says when it is gone', async () => {
    const { detailFromFeed, parseFeed } = await import('./headroom')
    const feed = parseFeed(feedExample)
    const d = detailFromFeed(feed, 'hr_req_0002')
    expect(d).toMatchObject({ found: true, logged: true })
    expect(d.original).toHaveLength(3)
    expect(JSON.stringify(d.compressed)).toContain('omitted by headroom')
    expect(d.response).toMatch(/test_settings/)
    expect(detailFromFeed(feed, 'hr_req_0001').compressed).toBeNull()
    expect(detailFromFeed(feed, 'nope')).toMatchObject({ found: false, original: null })
  })

  it('reports when headroom does not keep bodies', async () => {
    const { parseFeed } = await import('./headroom')
    expect(parseFeed({ transformations: [], log_full_messages: false }).logged).toBe(false)
    expect(() => parseFeed({ nope: 1 })).toThrow()
  })
})

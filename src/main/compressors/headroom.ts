import type { ComponentStatus, CompressorStats, RecentRequest, RequestDetail, SavingsTotals } from '@shared/ipc'

type Json = Record<string, unknown>

const num = (o: Json | undefined, key: string): number => {
  const v = o?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
const str = (o: Json | undefined, key: string): string | null => {
  const v = o?.[key]
  return typeof v === 'string' ? v : null
}
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined

function totals(o: Json | undefined): SavingsTotals {
  return {
    requests: num(o, 'requests'),
    tokensSaved: num(o, 'tokens_saved'),
    totalInputTokens: num(o, 'total_input_tokens'),
    compressionSavingsUsd: num(o, 'compression_savings_usd'),
    cacheSavingsUsd: num(o, 'cache_savings_usd'),
    totalInputCostUsd: num(o, 'total_input_cost_usd')
  }
}

/**
 * Maps headroom's /stats-history (schema_version 6, see examples/headroom-stats.json)
 * to the few numbers the UI shows. Unknown or missing fields become 0 / null
 * rather than errors, so a headroom upgrade degrades the view instead of breaking it.
 */
export function parseStatsHistory(raw: unknown): Omit<CompressorStats, 'recent' | 'messagesLogged'> {
  const root = obj(raw)
  if (!root || !obj(root.lifetime)) throw new Error('not a headroom stats-history response')
  const session = obj(root.display_session)
  const daily = Array.isArray(obj(root.series)?.daily) ? (obj(root.series)!.daily as unknown[]) : []
  return {
    lifetime: totals(obj(root.lifetime)),
    session: session
      ? { ...totals(session), startedAt: str(session, 'started_at'), lastActivityAt: str(session, 'last_activity_at') }
      : null,
    daily: daily
      .map(obj)
      .filter((d): d is Json => !!d && typeof d.timestamp === 'string')
      .map((d) => ({
        day: (d.timestamp as string).slice(0, 10),
        tokensSaved: num(d, 'tokens_saved'),
        compressionSavingsUsd: num(d, 'compression_savings_usd_delta')
      })),
    generatedAt: str(root, 'generated_at')
  }
}

export interface Feed {
  logged: boolean
  items: RecentRequest[]
  /** request id -> raw feed entry; only filled when bodies were requested */
  raw: Map<string, Json>
}

/** Maps /transformations/feed (headroom 0.42) to RecentRequest, newest first. */
export function parseFeed(raw: unknown): Feed {
  const root = obj(raw)
  if (!root || !Array.isArray(root.transformations)) throw new Error('not a headroom transformations feed')
  const entries = (root.transformations as unknown[]).map(obj).filter((e): e is Json => !!e && typeof e.request_id === 'string')
  const items = entries.map((e) => ({
    id: e.request_id as string,
    timestamp: str(e, 'timestamp'),
    provider: str(e, 'provider'),
    model: str(e, 'model'),
    inputTokensOriginal: num(e, 'input_tokens_original'),
    inputTokensOptimized: num(e, 'input_tokens_optimized'),
    tokensSaved: num(e, 'tokens_saved'),
    savingsPercent: num(e, 'savings_percent'),
    transforms: Array.isArray(e.transforms_applied) ? e.transforms_applied.filter((t): t is string => typeof t === 'string') : [],
    cacheReadTokens: num(e, 'cache_read_tokens'),
    cacheWriteTokens: num(e, 'cache_write_tokens'),
    uncachedInputTokens: num(e, 'uncached_input_tokens')
  }))
  items.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  return { logged: root.log_full_messages === true, items, raw: new Map(entries.map((e) => [e.request_id as string, e])) }
}

/** Picks one request's bodies out of a feed fetched with messages. */
export function detailFromFeed(feed: Feed, id: string): RequestDetail {
  const e = feed.raw.get(id)
  const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
  if (!e) return { id, logged: feed.logged, found: false, original: null, compressed: null, response: null }
  return {
    id,
    logged: feed.logged,
    found: true,
    original: list(e.request_messages),
    compressed: list(e.compressed_messages),
    response: typeof e.response_content === 'string' ? e.response_content : null
  }
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const RECENT_LIMIT = 20

/** headroom running as a local HTTP proxy (by Headroom Desktop or `headroom proxy`). */
export class HeadroomBackend {
  readonly name = 'headroom'

  constructor(private readonly baseUrl: string) {}

  async health(): Promise<ComponentStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return { health: 'degraded', detail: `${this.baseUrl}/health returned HTTP ${res.status}` }
      const body = obj(await res.json().catch(() => null))
      const version = str(body, 'version')
      return { health: 'ok', detail: `answering at ${this.baseUrl}${version ? ` (v${version})` : ''}` }
    } catch {
      return { health: 'down', detail: `not answering at ${this.baseUrl}` }
    }
  }

  /** True when /health answers at all; used to wait for a starting service. */
  async answering(): Promise<boolean> {
    return (await this.health()).health !== 'down'
  }

  async stats(): Promise<CompressorStats> {
    const [history, feed] = await Promise.all([
      getJson(`${this.baseUrl}/stats-history`, 5000),
      // Numbers only: with bodies a full feed can be tens of MB.
      this.feed(RECENT_LIMIT, false).catch(() => null)
    ])
    return { ...parseStatsHistory(history), recent: feed?.items ?? [], messagesLogged: feed ? feed.logged : null }
  }

  feed(limit: number, withMessages: boolean): Promise<Feed> {
    const q = `limit=${limit}&include_messages=${withMessages ? 1 : 0}`
    return getJson(`${this.baseUrl}/transformations/feed?${q}`, withMessages ? 20000 : 5000).then(parseFeed)
  }

  /** Bodies of one recent request. headroom has no per-id lookup, so this reads the recent window. */
  async detail(id: string): Promise<RequestDetail> {
    return detailFromFeed(await this.feed(RECENT_LIMIT, true), id)
  }
}

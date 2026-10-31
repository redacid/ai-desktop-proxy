import type { ComponentStatus, CompressorStats, SavingsTotals } from '@shared/ipc'

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
export function parseStatsHistory(raw: unknown): CompressorStats {
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

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** headroom running as a local HTTP proxy (by Headroom Desktop or `headroom proxy`). */
export class HeadroomBackend {
  readonly name = 'headroom'

  constructor(private readonly baseUrl: string) {}

  async health(): Promise<ComponentStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      return res.ok
        ? { health: 'ok', detail: `answering at ${this.baseUrl}` }
        : { health: 'degraded', detail: `${this.baseUrl}/health returned HTTP ${res.status}` }
    } catch {
      return { health: 'down', detail: `not answering at ${this.baseUrl}` }
    }
  }

  async stats(): Promise<CompressorStats> {
    return parseStatsHistory(await getJson(`${this.baseUrl}/stats-history`, 5000))
  }
}

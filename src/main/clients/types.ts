import type { ClientState } from '@shared/ipc'
import type { ProxyEnv } from '../proxy-env'

/**
 * Exactly what we wrote into a client config, so removal undoes only our part.
 * A base-URL client (Codex) keeps its URL in proxyUrl and leaves the rest empty.
 */
export interface AppliedRecord {
  proxyUrl: string
  caFile: string
  noProxyAdded: string[]
}

export interface Inspection {
  state: ClientState
  detail: string
}

/** One AI client (Claude Code, Codex; Cursor later). */
export interface ClientAdapter {
  readonly id: string
  readonly name: string
  readonly configPath: string
  /** Paths whose changes should trigger a re-check (watched as directories). */
  watchPaths(): string[]
  /** `record` = what we wrote before; values matching it are ours (e.g. an old port), not a conflict. */
  inspect(env: ProxyEnv, record?: AppliedRecord | null): Promise<Inspection>
  /** Writes our settings; throws ClientConflictError instead of overwriting foreign values. */
  apply(env: ProxyEnv, previous: AppliedRecord | null): Promise<AppliedRecord>
  /** Removes only what `record` says we wrote (falls back to `env` when there is no record). */
  remove(record: AppliedRecord | null, env: ProxyEnv): Promise<void>
}

export class ClientConflictError extends Error {}

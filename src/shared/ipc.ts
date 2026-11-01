// Contract between the main process and the UI. Every IPC channel is listed here.

export type Health = 'ok' | 'degraded' | 'down' | 'unknown'

export interface ComponentStatus {
  health: Health
  detail: string
}

/**
 * What a client config looks like relative to our proxy settings.
 * - applied:  every variable we manage is set to our value
 * - absent:   none of them are set (client runs without the proxy)
 * - partial:  some are set, some are missing (someone edited the file)
 * - conflict: a variable we need is set to someone else's value; we never overwrite it
 * - missing:  the client does not appear to be installed
 * - error:    the config could not be read (broken JSON, permissions)
 */
export type ClientState = 'applied' | 'absent' | 'partial' | 'conflict' | 'missing' | 'error'

export interface ClientInfo {
  id: string
  name: string
  configPath: string
  enabled: boolean // what the user wants
  state: ClientState // what the config actually has
  detail: string
  checkedAt: string
}

/** Lifetime / session totals reported by headroom's /stats-history. */
export interface SavingsTotals {
  requests: number
  tokensSaved: number
  totalInputTokens: number
  compressionSavingsUsd: number
  cacheSavingsUsd: number
  totalInputCostUsd: number
}

/** One request from headroom's /transformations/feed, without message bodies. */
export interface RecentRequest {
  id: string
  timestamp: string | null
  provider: string | null
  model: string | null
  inputTokensOriginal: number
  inputTokensOptimized: number
  tokensSaved: number
  savingsPercent: number
  transforms: string[]
  cacheReadTokens: number
  cacheWriteTokens: number
  uncachedInputTokens: number
}

/** Message bodies of one request: as the client sent it, as sent to the provider, and the reply. */
export interface RequestDetail {
  id: string
  /** false when headroom runs without --log-messages, so bodies are not kept */
  logged: boolean
  /** null = request no longer in headroom's recent buffer */
  found: boolean
  original: unknown[] | null
  compressed: unknown[] | null // null when headroom did not keep a separate compressed copy
  response: string | null
}

export interface CompressorStats {
  lifetime: SavingsTotals
  session: (SavingsTotals & { startedAt: string | null; lastActivityAt: string | null }) | null
  daily: { day: string; tokensSaved: number; compressionSavingsUsd: number }[]
  generatedAt: string | null
  /** Newest first. Empty when headroom has no feed endpoint. */
  recent: RecentRequest[]
  /** Whether headroom keeps message bodies (started with --log-messages). null = unknown. */
  messagesLogged: boolean | null
}

export interface ProxyInfo {
  port: number
  codexPort: number
  mitmdump: string | null // path, or null when mitmproxy is not installed
  uv: string | null
  /** current = written by this app version; legacy = written by cdp.sh; outdated = settings or app changed */
  unit: 'missing' | 'legacy' | 'outdated' | 'current'
  active: boolean
  listening: boolean
  codexListening: boolean
  /** Process listening on the port, when it can be identified. */
  owner: { pid: number; name: string } | null
  /** owner is our service's main process */
  ours: boolean
  caExists: boolean
}

export interface CompressorInfo {
  binary: string | null // headroom command, or null when not installed
  uv: string | null
  unit: 'missing' | 'outdated' | 'current'
  active: boolean // our service runs
  answering: boolean // the configured URL answers /health
  /** ours = our service serves it; external = something else (e.g. Headroom Desktop); none = nothing */
  managed: 'ours' | 'external' | 'none'
  local: boolean // URL is on this machine, so it can be run here
}

export type CompressorAction = 'install' | 'setup' | 'start' | 'stop' | 'restart' | 'remove'

export type ToolId = 'headroom' | 'rtk' | 'ponytail-claude' | 'ponytail-codex' | 'chisle-claude' | 'serena' | 'markitdown'
/** remove = one client's plugin; stop/start/uninstall = the whole tool on this machine. */
export type ToolAction = 'install' | 'update' | 'connect-claude' | 'connect-codex' | 'disconnect-claude' | 'disconnect-codex' | 'remove'
  | 'stop' | 'start' | 'uninstall'

export interface ToolInfo {
  id: ToolId
  name: string
  installed: boolean | null // null = detection failed, not proof of absence
  version: string | null
  latest: string | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
  blocked: string | null
  detail: string
  /** RTK and MCP servers: per-client connection. RTK: whether `rtk init --show` reports its global hooks in place per client (null = unknown). */
  connected?: { claude: boolean | null; codex: boolean | null }
  /** Plugins: whether the client has it enabled (false = installed but disabled). */
  enabled?: boolean
  /** MCP servers: a client has a server of that name the app did not add (shown, never changed). */
  foreign?: { claude: boolean; codex: boolean }
  /** What the tool reports it achieved; null when it reports nothing readable. */
  stats: ToolStats | null
}

export interface ToolStats {
  /** Where the figures come from, e.g. "rtk gain (this machine)" or "published benchmark". */
  source: string
  facts: { label: string; value: string }[]
  /** Tokens saved per day, oldest first (RTK only). */
  daily: { day: string; value: number }[]
}

export interface ToolActionResult {
  ok: boolean
  error?: string
  tools: ToolInfo[]
}

/** Built-in headroom compressors that `--compressor` can select (headroom 0.42). */
export const HEADROOM_COMPRESSORS = [
  'smart_crusher', 'kompress', 'code_aware', 'search', 'log', 'tabular', 'config', 'html', 'image'
] as const

/**
 * Options for the headroom service this app runs; each maps to a `headroom proxy` flag.
 * Defaults equal headroom's own defaults, so a default value adds no flag.
 */
export interface HeadroomOptions {
  /** false = --no-optimize (passthrough, only stats) */
  optimize: boolean
  /** cache = keep earlier turns stable for the provider's prompt cache; token = compress harder */
  mode: 'cache' | 'token'
  /** --target-ratio for text compression, 0.05–0.95; null = headroom decides */
  targetRatio: number | null
  /** retrieve = compressed parts can be fetched back by the model (CCR); lossless = --lossless; off = --no-ccr */
  ccr: 'retrieve' | 'lossless' | 'off'
  /** Tool names whose results are never lossy-compressed (--protect-tool-results), comma separated */
  protectToolResults: string
  /** Enabled compressors (--compressor); empty = all */
  compressors: string[]
  /** --code-aware (AST-based code compression) */
  codeAware: boolean
  /** false = --disable-kompress (no ML text compression, structural only) */
  kompress: boolean
  /** false = --no-cache (semantic cache) */
  semanticCache: boolean
  /** false = --no-rate-limit */
  rateLimit: boolean
  /** --rpm / --tpm; null = headroom default (60 rpm, unlimited tpm) */
  rpm: number | null
  tpm: number | null
  /** --budget in USD per budgetPeriod; null = no budget */
  budgetUsd: number | null
  budgetPeriod: 'hourly' | 'daily' | 'monthly'
  /** false = --no-http2 */
  http2: boolean
  /** headroom's anonymous upload of session summaries to Headroom Labs; false = HEADROOM_BEACON=off */
  beacon: boolean
  /** --log-messages: keep request bodies so recent requests can be inspected */
  logMessages: boolean
  /** More arguments, split like a shell would but never run through one */
  extraArgs: string
}

export interface UserSettings {
  proxyPort: number
  /** Reverse listener for clients that only take a base URL (Codex). */
  codexPort: number
  headroomUrl: string
  headroom: HeadroomOptions
  autoRepair: boolean
  checkIntervalSec: number
  autostart: boolean
}

export type ProxyAction = 'install' | 'setup' | 'start' | 'stop' | 'restart' | 'remove'

export interface AppStatus {
  overall: Health
  proxy: ComponentStatus
  proxyInfo: ProxyInfo | null
  compressor: ComponentStatus
  compressorInfo: CompressorInfo | null
  clients: ComponentStatus
  clientList: ClientInfo[]
  stats: CompressorStats | null
  checkedAt: string | null
}

/** Result of a user action; `error` is shown in the UI when the action was refused. */
export interface ActionResult {
  ok: boolean
  error?: string
  status: AppStatus
}

export const IPC = {
  getStatus: 'status:get',
  refreshStatus: 'status:refresh',
  statusChanged: 'status:changed',
  setClientEnabled: 'client:set-enabled',
  proxyAction: 'proxy:action',
  proxyLogs: 'proxy:logs',
  installLog: 'proxy:install-log',
  compressorAction: 'compressor:action',
  compressorLogs: 'compressor:logs',
  requestDetail: 'compressor:request-detail',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getTools: 'tools:get',
  checkTools: 'tools:check',
  toolAction: 'tools:action',
  toolsChanged: 'tools:changed'
} as const

export interface Api {
  getStatus(): Promise<AppStatus>
  refreshStatus(): Promise<AppStatus>
  setClientEnabled(id: string, enabled: boolean): Promise<ActionResult>
  proxyAction(action: ProxyAction): Promise<ActionResult>
  proxyLogs(): Promise<string>
  compressorAction(action: CompressorAction): Promise<ActionResult>
  compressorLogs(): Promise<string>
  requestDetail(id: string): Promise<RequestDetail>
  getSettings(): Promise<UserSettings>
  saveSettings(settings: UserSettings): Promise<ActionResult>
  getTools(): Promise<ToolInfo[]>
  checkTools(): Promise<ToolInfo[]>
  toolAction(id: ToolId, action: ToolAction): Promise<ToolActionResult>
  onTools(listener: (tools: ToolInfo[]) => void): () => void
  onStatus(listener: (status: AppStatus) => void): () => void
  onInstallLog(listener: (line: string) => void): () => void
}

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

export interface CompressorStats {
  lifetime: SavingsTotals
  session: (SavingsTotals & { startedAt: string | null; lastActivityAt: string | null }) | null
  daily: { day: string; tokensSaved: number; compressionSavingsUsd: number }[]
  generatedAt: string | null
}

export interface ProxyInfo {
  port: number
  mitmdump: string | null // path, or null when mitmproxy is not installed
  uv: string | null
  /** current = written by this app version; legacy = written by cdp.sh; outdated = settings or app changed */
  unit: 'missing' | 'legacy' | 'outdated' | 'current'
  active: boolean
  listening: boolean
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

export interface UserSettings {
  proxyPort: number
  headroomUrl: string
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
  getSettings: 'settings:get',
  saveSettings: 'settings:save'
} as const

export interface Api {
  getStatus(): Promise<AppStatus>
  refreshStatus(): Promise<AppStatus>
  setClientEnabled(id: string, enabled: boolean): Promise<ActionResult>
  proxyAction(action: ProxyAction): Promise<ActionResult>
  proxyLogs(): Promise<string>
  compressorAction(action: CompressorAction): Promise<ActionResult>
  compressorLogs(): Promise<string>
  getSettings(): Promise<UserSettings>
  saveSettings(settings: UserSettings): Promise<ActionResult>
  onStatus(listener: (status: AppStatus) => void): () => void
  onInstallLog(listener: (line: string) => void): () => void
}

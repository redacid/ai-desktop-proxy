// Contract between the main process and the UI. Every IPC channel is listed here.

export type Health = 'ok' | 'degraded' | 'down' | 'unknown'

export interface ComponentStatus {
  health: Health
  detail: string
}

export interface AppStatus {
  overall: Health
  proxy: ComponentStatus
  compressor: ComponentStatus
  clients: ComponentStatus
  checkedAt: string | null
}

export const IPC = {
  getStatus: 'status:get',
  refreshStatus: 'status:refresh',
  statusChanged: 'status:changed'
} as const

export interface Api {
  getStatus(): Promise<AppStatus>
  refreshStatus(): Promise<AppStatus>
  onStatus(listener: (status: AppStatus) => void): () => void
}

import { promises as fs } from 'node:fs'
import type { HeadroomOptions } from '@shared/ipc'
import type { AppliedRecord } from './clients/types'
import { DEFAULT_HEADROOM_OPTIONS, normalizeHeadroomOptions } from './compressors/headroom-options'
import { writeJsonAtomic } from './fsutil'
import { DEFAULT_CA_FILE, DEFAULT_CODEX_PORT, DEFAULT_PORT } from './proxy-env'

export interface ClientPrefs {
  enabled: boolean
  applied: AppliedRecord | null // what we last wrote into its config
}

export interface Settings {
  proxyPort: number
  /** mitmdump's reverse listener for Codex (upstream api.openai.com). */
  codexPort: number
  caFile: string
  headroomUrl: string
  /** Flags for the headroom service we run. */
  headroom: HeadroomOptions
  /** Re-apply our settings when they disappear from a config we manage. */
  autoRepair: boolean
  checkIntervalSec: number
  clients: Record<string, ClientPrefs>
}

export const DEFAULT_SETTINGS: Settings = {
  proxyPort: DEFAULT_PORT,
  codexPort: DEFAULT_CODEX_PORT,
  caFile: DEFAULT_CA_FILE,
  headroomUrl: 'http://127.0.0.1:6767',
  headroom: DEFAULT_HEADROOM_OPTIONS,
  autoRepair: true,
  checkIntervalSec: 60,
  clients: {}
}

/** App settings and per-client state in one JSON file under the app's userData dir. */
export class AppStore {
  private data: Settings = structuredClone(DEFAULT_SETTINGS)

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.path, 'utf8')) as Partial<Settings> & { headroomLogMessages?: boolean }
      const { headroomLogMessages, ...rest } = raw
      const headroom = normalizeHeadroomOptions(raw.headroom)
      // 0.1 kept only this one flag at the top level
      if (raw.headroom === undefined && typeof headroomLogMessages === 'boolean') headroom.logMessages = headroomLogMessages
      this.data = { ...structuredClone(DEFAULT_SETTINGS), ...rest, headroom, clients: { ...(raw.clients ?? {}) } }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`ignoring unreadable ${this.path}:`, err)
      }
    }
    return this.data
  }

  get settings(): Settings {
    return this.data
  }

  client(id: string): ClientPrefs {
    return this.data.clients[id] ?? { enabled: false, applied: null }
  }

  async update(patch: Partial<Omit<Settings, 'clients'>>): Promise<void> {
    this.data = { ...this.data, ...patch }
    await writeJsonAtomic(this.path, this.data)
  }

  async updateClient(id: string, patch: Partial<ClientPrefs>): Promise<void> {
    this.data.clients[id] = { ...this.client(id), ...patch }
    await writeJsonAtomic(this.path, this.data)
  }
}

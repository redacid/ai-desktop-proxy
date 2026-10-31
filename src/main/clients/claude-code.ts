import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { backupOnce, exists, writeJsonAtomic } from '../fsutil'
import { LOCAL_HOSTS, type ProxyEnv } from '../proxy-env'
import { ClientConflictError, type AppliedRecord, type ClientAdapter, type Inspection } from './types'

type Env = Record<string, unknown>
type Settings = Record<string, unknown> & { env?: Env }

const HTTPS_PROXY = 'HTTPS_PROXY'
const CA = 'NODE_EXTRA_CA_CERTS'
const NO_PROXY = 'NO_PROXY'
// What the shell version (legacy/cdp.sh) wrote; removed when there is no record.
const LEGACY_NO_PROXY = LOCAL_HOSTS.join(',')

export const BACKUP_SUFFIX = '.bak-claude-desktop-proxy'

function splitHosts(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(',').map((h) => h.trim()).filter(Boolean)
    : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Claude Code reads `env` from ~/.claude/settings.json and passes it to the CLI,
 * including the one Claude Code Desktop starts. HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 * route its API calls through mitmproxy; NO_PROXY keeps local services direct.
 */
export class ClaudeCodeAdapter implements ClientAdapter {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly configPath: string
  private readonly claudeDir: string

  constructor(configPath = join(homedir(), '.claude', 'settings.json')) {
    this.configPath = configPath
    this.claudeDir = dirname(configPath)
  }

  watchPaths(): string[] {
    return [this.claudeDir]
  }

  /** null = file does not exist. Throws on unreadable or malformed JSON. */
  private async read(): Promise<Settings | null> {
    let text: string
    try {
      text = await fs.readFile(this.configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed)) throw new Error('settings.json is not a JSON object')
    if (parsed.env !== undefined && !isObject(parsed.env)) throw new Error('"env" in settings.json is not an object')
    return parsed as Settings
  }

  private async write(settings: Settings): Promise<void> {
    await backupOnce(this.configPath, this.configPath + BACKUP_SUFFIX)
    await writeJsonAtomic(this.configPath, settings)
  }

  async inspect(env: ProxyEnv, record: AppliedRecord | null = null): Promise<Inspection> {
    let settings: Settings | null
    try {
      settings = await this.read()
    } catch (err) {
      return { state: 'error', detail: `cannot read ${this.configPath}: ${(err as Error).message}` }
    }
    if (!settings) {
      return (await exists(this.claudeDir))
        ? { state: 'absent', detail: 'settings.json does not exist yet' }
        : { state: 'missing', detail: `${this.claudeDir} not found; is Claude Code installed?` }
    }
    const e = settings.env ?? {}
    const foreign = (key: string, ours: string, previous: string | undefined): boolean =>
      e[key] !== undefined && e[key] !== ours && e[key] !== previous
    const conflicts = [
      foreign(HTTPS_PROXY, env.proxyUrl, record?.proxyUrl) ? `${HTTPS_PROXY}=${String(e[HTTPS_PROXY])}` : null,
      foreign(CA, env.caFile, record?.caFile) ? `${CA}=${String(e[CA])}` : null
    ].filter((c): c is string => c !== null)
    if (conflicts.length) return { state: 'conflict', detail: `already set by someone else: ${conflicts.join(', ')}` }

    const stale = (e[HTTPS_PROXY] !== undefined && e[HTTPS_PROXY] !== env.proxyUrl) || (e[CA] !== undefined && e[CA] !== env.caFile)
    if (stale) return { state: 'partial', detail: `points at our old settings (${String(e[HTTPS_PROXY])}); needs an update` }

    const hosts = splitHosts(e[NO_PROXY])
    const have = {
      proxy: e[HTTPS_PROXY] === env.proxyUrl,
      ca: e[CA] === env.caFile,
      noProxy: env.noProxyHosts.every((h) => hosts.includes(h))
    }
    if (have.proxy && have.ca && have.noProxy) return { state: 'applied', detail: `routed through ${env.proxyUrl}` }
    if (!have.proxy && !have.ca) return { state: 'absent', detail: 'proxy settings are not present' }
    const missing = [
      have.proxy ? null : HTTPS_PROXY,
      have.ca ? null : CA,
      have.noProxy ? null : NO_PROXY
    ].filter(Boolean)
    return { state: 'partial', detail: `missing ${missing.join(', ')}` }
  }

  async apply(env: ProxyEnv, previous: AppliedRecord | null): Promise<AppliedRecord> {
    const settings: Settings = (await this.read()) ?? {}
    const e: Env = { ...(settings.env ?? {}) }

    const foreign = [
      e[HTTPS_PROXY] !== undefined && e[HTTPS_PROXY] !== env.proxyUrl && e[HTTPS_PROXY] !== previous?.proxyUrl ? HTTPS_PROXY : null,
      e[CA] !== undefined && e[CA] !== env.caFile && e[CA] !== previous?.caFile ? CA : null
    ].filter(Boolean)
    if (foreign.length) {
      throw new ClientConflictError(
        `${this.configPath} already sets ${foreign.join(' and ')} to other values; remove them by hand or change them to ours`
      )
    }

    const hosts = splitHosts(e[NO_PROXY])
    const added = env.noProxyHosts.filter((h) => !hosts.includes(h))
    const noProxyAdded = [...new Set([...(previous?.noProxyAdded ?? []).filter((h) => hosts.includes(h)), ...added])]

    e[HTTPS_PROXY] = env.proxyUrl
    e[CA] = env.caFile
    if (added.length) e[NO_PROXY] = [...hosts, ...added].join(',')

    if (JSON.stringify(e) !== JSON.stringify(settings.env ?? {})) {
      await this.write({ ...settings, env: e })
    }
    return { proxyUrl: env.proxyUrl, caFile: env.caFile, noProxyAdded }
  }

  async remove(record: AppliedRecord | null, env: ProxyEnv): Promise<void> {
    const settings = await this.read()
    if (!settings?.env) return
    const e: Env = { ...settings.env }
    const ours = record ?? { proxyUrl: env.proxyUrl, caFile: env.caFile, noProxyAdded: [] }

    if (e[HTTPS_PROXY] === ours.proxyUrl) delete e[HTTPS_PROXY]
    if (e[CA] === ours.caFile) delete e[CA]
    if (record) {
      const left = splitHosts(e[NO_PROXY]).filter((h) => !record.noProxyAdded.includes(h))
      if (left.length) e[NO_PROXY] = left.join(',')
      else delete e[NO_PROXY]
    } else if (e[NO_PROXY] === LEGACY_NO_PROXY) {
      delete e[NO_PROXY]
    }

    if (JSON.stringify(e) === JSON.stringify(settings.env)) return
    const next: Settings = { ...settings, env: e }
    if (Object.keys(e).length === 0) delete next.env
    await this.write(next)
  }
}

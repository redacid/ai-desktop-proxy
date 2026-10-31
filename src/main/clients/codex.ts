import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import { backupOnce, exists, writeTextAtomic } from '../fsutil'
import type { ProxyEnv } from '../proxy-env'
import { ClientConflictError, type AppliedRecord, type ClientAdapter, type Inspection } from './types'

const KEY = 'openai_base_url'
const MARKER = '# Added by Claude Desktop Proxy; turn Codex off in the app to remove it.'
export const BACKUP_SUFFIX = '.bak-claude-desktop-proxy'

type Config = Record<string, unknown>

/** The exact line we write, so remove() can find it again without a TOML writer. */
export const keyLine = (url: string): string => `${KEY} = ${JSON.stringify(url)}`

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function parseConfig(text: string): Config {
  return parse(text) as Config
}

const invalid = Symbol('invalid')

/** Our key's value in an edited text, or `invalid` when the edit broke the file. */
function keyAfterEdit(text: string): unknown {
  try {
    return parseConfig(text)[KEY]
  } catch {
    return invalid
  }
}

/**
 * Codex (CLI and desktop app) cannot use an HTTPS proxy with our CA, but its
 * built-in `openai` provider takes a base URL from `openai_base_url` in
 * config.toml, for API-key and ChatGPT logins alike. We point it at mitmdump's
 * reverse listener, which forwards to headroom or, when headroom is down, to
 * the API Codex would use itself.
 *
 * The file is edited as text so comments and layout survive: our key goes on
 * the first line with a marker comment above it, and every result is parsed
 * before it is written.
 */
export class CodexAdapter implements ClientAdapter {
  readonly id = 'codex'
  readonly name = 'Codex'
  readonly configPath: string
  private readonly codexDir: string

  constructor(configPath = join(codexHome(), 'config.toml')) {
    this.configPath = configPath
    this.codexDir = dirname(configPath)
  }

  watchPaths(): string[] {
    return [this.codexDir]
  }

  /** null = file does not exist. Throws on unreadable or malformed TOML. */
  private async read(): Promise<{ text: string; config: Config } | null> {
    let text: string
    try {
      text = await fs.readFile(this.configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return { text, config: parseConfig(text) }
  }

  private async write(text: string): Promise<void> {
    await backupOnce(this.configPath, this.configPath + BACKUP_SUFFIX)
    await writeTextAtomic(this.configPath, text)
  }

  /** Another provider sends traffic elsewhere; openai_base_url would not touch it. */
  private static providerProblem(config: Config): string | null {
    const provider = config.model_provider
    return provider !== undefined && provider !== 'openai'
      ? `model_provider is "${String(provider)}"; only the built-in openai provider can be routed`
      : null
  }

  async inspect(env: ProxyEnv, record: AppliedRecord | null = null): Promise<Inspection> {
    let file: Awaited<ReturnType<CodexAdapter['read']>>
    try {
      file = await this.read()
    } catch (err) {
      return { state: 'error', detail: `cannot read ${this.configPath}: ${(err as Error).message}` }
    }
    if (!file) {
      return (await exists(this.codexDir))
        ? { state: 'absent', detail: 'config.toml does not exist yet' }
        : { state: 'missing', detail: `${this.codexDir} not found; is Codex installed?` }
    }
    const value = file.config[KEY]
    if (value !== undefined && value !== env.openaiBaseUrl && value !== record?.proxyUrl) {
      return { state: 'conflict', detail: `already set by someone else: ${KEY}=${String(value)}` }
    }
    const provider = CodexAdapter.providerProblem(file.config)
    if (provider) return { state: value === undefined ? 'absent' : 'conflict', detail: provider }
    if (value === undefined) return { state: 'absent', detail: 'proxy settings are not present' }
    if (value !== env.openaiBaseUrl) return { state: 'partial', detail: `points at our old settings (${String(value)}); needs an update` }
    return { state: 'applied', detail: `routed through ${env.openaiBaseUrl}` }
  }

  async apply(env: ProxyEnv, previous: AppliedRecord | null): Promise<AppliedRecord> {
    const file = await this.read()
    const config = file?.config ?? {}
    const value = config[KEY]
    if (value !== undefined && value !== env.openaiBaseUrl && value !== previous?.proxyUrl) {
      throw new ClientConflictError(`${this.configPath} already sets ${KEY} to ${String(value)}; remove it by hand first`)
    }
    const provider = CodexAdapter.providerProblem(config)
    if (provider) throw new ClientConflictError(`${this.configPath}: ${provider}`)

    const record = { proxyUrl: env.openaiBaseUrl, caFile: '', noProxyAdded: [] }
    if (value === env.openaiBaseUrl) return record

    const base = file ? stripOurs(file.text, String(value ?? '')) : ''
    const next = `${MARKER}\n${keyLine(env.openaiBaseUrl)}\n${base}`
    if (keyAfterEdit(next) !== env.openaiBaseUrl) {
      throw new Error(`could not update ${KEY} in ${this.configPath}; change it by hand`)
    }
    await this.write(next)
    return record
  }

  async remove(record: AppliedRecord | null, env: ProxyEnv): Promise<void> {
    const file = await this.read()
    if (!file) return
    const value = file.config[KEY]
    if (value === undefined || value !== (record?.proxyUrl ?? env.openaiBaseUrl)) return
    const next = stripOurs(file.text, value)
    if (keyAfterEdit(next) !== undefined) {
      throw new Error(`${KEY} in ${this.configPath} was edited by hand; remove it there`)
    }
    await this.write(next)
  }
}

/** The text without our key line (and the marker above it); unchanged when the line is not there. */
export function stripOurs(text: string, url: string): string {
  if (!url) return text
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trimEnd() === keyLine(url))
  if (at < 0) return text
  const from = at > 0 && lines[at - 1].trimEnd() === MARKER ? at - 1 : at
  lines.splice(from, at - from + 1)
  return lines.join('\n')
}

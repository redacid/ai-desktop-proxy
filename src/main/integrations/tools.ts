import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { CompressorInfo, ToolAction, ToolId, ToolInfo, ToolStats } from '@shared/ipc'
import { run, runStreaming, type Runner } from '../proxy/exec'
import { which } from '../proxy/tools'
import { parse as parseToml } from 'smol-toml'
import { writeJsonAtomic } from '../fsutil'
import { HEADROOM_PACKAGE, HEADROOM_PYTHON } from '../compressors/headroom-service'

const IDS: ToolId[] = ['headroom', 'rtk', 'ponytail-claude', 'ponytail-codex', 'chisle-claude', 'serena', 'markitdown']
const NAMES: Record<ToolId, string> = {
  headroom: 'headroom', rtk: 'RTK', 'ponytail-claude': 'Ponytail · Claude Code', 'ponytail-codex': 'Ponytail · Codex',
  'chisle-claude': 'Chisle · Claude Code', serena: 'Serena', markitdown: 'MarkItDown'
}
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const PRESENCE_INTERVAL_MS = 60_000

/** Client plugins installed from their official marketplace (one ToolId per client). */
export const PLUGINS = {
  ponytail: { name: 'Ponytail', plugin: 'ponytail@ponytail', marketplace: 'ponytail', repo: 'DietrichGebert/ponytail' },
  chisle: { name: 'Chisle', plugin: 'chisle@chisle', marketplace: 'chisle', repo: 'JayPokale/Chisle' }
} as const
type PluginKey = keyof typeof PLUGINS
export const pluginKey = (id: ToolId): PluginKey | null => id.startsWith('ponytail-') ? 'ponytail' : id.startsWith('chisle-') ? 'chisle' : null

/**
 * MCP servers run by uvx from a pinned PyPI release, registered per client at user scope.
 * The pin in the registration is the installed version; nothing else is installed.
 */
export const MCP_SERVERS = {
  serena: { pkg: 'serena-agent', uv: [], args: (codex: boolean) => ['serena', 'start-mcp-server', '--context', codex ? 'codex' : 'claude-code', '--project-from-cwd'] },
  // markitdown[all] 0.1.9 needs a beta that uv skips by default; allow pre-releases only where named.
  markitdown: { pkg: 'markitdown-mcp', uv: ['--prerelease', 'if-necessary-or-explicit', '--with', 'azure-ai-contentunderstanding>=1.2.0b1'], args: () => ['markitdown-mcp'] }
} as const
type McpKey = keyof typeof MCP_SERVERS
const mcpKey = (id: ToolId): McpKey | null => id === 'serena' || id === 'markitdown' ? id : null
const MCP_PYTHON = '3.13'
// PyPI versions incl. pre-releases (markitdown-mcp has only alphas); never anything an argument could abuse.
const pypiVersion = (v: unknown): string | null => typeof v === 'string' && /^\d+(\.\d+)*([a-z]+\d+)?$/.test(v) ? v : null
type UpdateKey = 'headroom' | 'rtk' | PluginKey | McpKey
const UPDATE_KEYS: UpdateKey[] = ['headroom', 'rtk', 'ponytail', 'chisle', 'serena', 'markitdown']
const updateKey = (id: ToolId): UpdateKey => pluginKey(id) ?? id as UpdateKey

type Json = Record<string, unknown>
const object = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
export function releaseVersion(v: unknown): string | null {
  return typeof v === 'string' && /^v?\d+\.\d+\.\d+$/.test(v) ? v.replace(/^v/, '') : null
}
export function newerVersion(latest: string | null, current: string | null): boolean {
  const a = releaseVersion(latest), b = releaseVersion(current)
  if (!a || !b) return false
  const av = a.split('.').map(Number), bv = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i]
  return false
}
export function binaryVersion(output: string): string | null {
  return releaseVersion(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/.exec(output)?.[1])
}

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** Parse only native installed-plugin lists; an unknown schema is never "missing". */
export function pluginInfo(raw: unknown, codex: boolean, plugin: string): { installed: boolean; version: string | null; enabled: boolean } {
  const entries = codex ? object(raw).installed : raw
  if (!Array.isArray(entries)) throw new Error('Unrecognized installed-plugin list')
  const candidates = entries.map(object).filter((e) => (codex ? e.pluginId : e.id) === plugin && (!e.scope || e.scope === 'user'))
  const entry = candidates[0]
  return { installed: !!entry, version: releaseVersion(entry?.version), enabled: entry?.enabled === true }
}

/** Whether a marketplace entry points at `repo` (owner/name) on GitHub and nowhere else. */
export function officialSource(entry: unknown, repo: string): boolean {
  const e = object(entry)
  const source = object(e.marketplaceSource)
  const nested = object(e.source)
  const r = repo.replace('/', '\\/')
  const official = new RegExp(`^(?:${r}|https:\\/\\/github\\.com\\/${r}(?:\\.git)?\\/?|git@github\\.com:${r}(?:\\.git)?)$`, 'i')
  return [e.repo, e.url, e.source, source.source, source.url, source.repoUrl, nested.repo, nested.url].some((v) =>
    typeof v === 'string' && official.test(v))
}

/** An MCP server entry ({command, args}) registered by this app: uvx with `--from <pkg>==<version>`. */
export function mcpPin(entry: unknown, pkg: string): string | null {
  const e = object(entry)
  const args = Array.isArray(e.args) ? e.args : []
  const from = args.indexOf('--from')
  const spec = from >= 0 ? args[from + 1] : null
  if (typeof e.command !== 'string' || !/(^|\/)uvx$/.test(e.command) || typeof spec !== 'string' || !spec.startsWith(`${pkg}==`)) return null
  return pypiVersion(spec.slice(pkg.length + 2))
}

/** chisle's compress-output hook ledger: characters it elided from tool output. */
export function parseChisleStats(raw: unknown): ToolStats | null {
  const s = object(raw)
  if (typeof s.savedChars !== 'number' || typeof s.events !== 'number') return null
  return {
    source: 'chisle compress-output hook, this machine',
    facts: [
      { label: 'characters elided', value: int.format(s.savedChars) },
      { label: '≈ tokens saved', value: int.format(s.savedChars / 4) },
      { label: 'outputs compressed', value: int.format(s.events) }
    ],
    daily: []
  }
}

const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** `rtk gain --daily --format json`: local savings recorded by RTK's hooks. */
export function parseRtkGain(raw: unknown): ToolStats | null {
  const s = object(object(raw).summary)
  if (s.total_commands === undefined) return null
  const daily = (Array.isArray(object(raw).daily) ? object(raw).daily as unknown[] : []).map(object)
    .filter((d) => typeof d.date === 'string').map((d) => ({ day: d.date as string, value: num(d.saved_tokens) }))
  return {
    source: 'rtk gain, this machine',
    facts: [
      { label: 'tokens saved', value: int.format(num(s.total_saved)) },
      { label: 'average saving', value: `${num(s.avg_savings_pct).toFixed(0)}%` },
      { label: 'commands filtered', value: int.format(num(s.total_commands)) }
    ],
    daily: daily.slice(-14)
  }
}

/**
 * `rtk init -g [--codex] --show`: connected when every global item is [ok]. Project-local
 * lines depend on the app's cwd and are ignored.
 */
export function rtkConnected(output: string, codex: boolean): boolean | null {
  const lines = output.split('\n').map((l) => /^\[(ok|--|!!|\w+)\]\s+(.+?):/.exec(l.trim())).filter((m) => m !== null)
  const global = lines.filter(([, , name]) => codex ? name.startsWith('Global ') : ['Hook', 'RTK.md', 'settings.json'].includes(name) || name.startsWith('Global ('))
  return global.length ? global.every(([, status]) => status === 'ok') : null
}

/** The scoreboard in Ponytail's own ponytail-gain skill: published benchmark figures, not local ones. */
export function parsePonytailGain(markdown: string): ToolStats | null {
  const facts = [...markdown.matchAll(/^\s+(\S.*?\S)\s{2,}[█·]+\s+\d+%\s+▼\s*(\d+%)\s*$/gm)]
    .map((m) => ({ label: `less ${m[1].toLowerCase()}`, value: m[2] }))
  const bench = /^\s+ponytail gain\s+(.+?)\s*$/m.exec(markdown)?.[1]
  return facts.length ? { source: `published benchmark${bench ? ` (${bench})` : ''}; no local band ledger yet`, facts, daily: [] } : null
}

/** One CSV line: comma separated, double-quoted fields with "" escapes. */
export function csvFields(line: string): string[] {
  return [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) => m[1]?.replace(/""/g, '"') ?? m[2])
}

/** Ponytail band's per-project session ledgers (cost, tokens, turns, agent time per Claude Code session). */
export function parsePonytailBand(csvs: string[]): ToolStats | null {
  let sessions = 0, cost = 0, tokens = 0, turns = 0, minutes = 0
  for (const text of csvs) {
    const [header, ...rows] = text.split('\n').filter(Boolean).map(csvFields)
    const col = (row: string[], name: string): number => Number(row[header.indexOf(name)]) || 0
    for (const row of rows) {
      sessions++
      cost += col(row, 'cost_usd'); tokens += col(row, 'tokens_total'); turns += col(row, 'turns'); minutes += col(row, 'agent_minutes')
    }
  }
  if (!sessions) return null
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
  return {
    source: `Ponytail band ledger, ${sessions} Claude Code session${sessions === 1 ? '' : 's'} on this machine`,
    facts: [
      { label: 'cost', value: `$${cost.toFixed(2)}` },
      { label: 'tokens', value: compact.format(tokens) },
      { label: 'turns', value: int.format(turns) },
      { label: 'agent time', value: `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` }
    ],
    daily: []
  }
}

export interface Command { cmd: string; args: string[] }
export interface ToolPlan {
  id: ToolId
  action: ToolAction
  detail: string
  commands: Command[]
  version: string | null
  restartHeadroom?: boolean
}

interface UpdateEntry { latest: string | null; checkedAt: string | null; error: string | null }
type UpdateCache = Record<UpdateKey, UpdateEntry>
const emptyUpdate = (): UpdateEntry => ({ latest: null, checkedAt: null, error: null })

export interface ToolDependencies {
  root: string
  home: string
  /** XDG config dir, where Ponytail band keeps its ledger; defaults to ~/.config. */
  configHome?: string
  /** CODEX_HOME; defaults to ~/.codex. */
  codexHome?: string
  arch?: string
  runner?: Runner
  stream?: typeof runStreaming
  find?: (name: string) => Promise<string | null>
  request?: typeof fetch
  now?: () => number
  headroomInfo: () => Promise<CompressorInfo>
  setupHeadroom: () => Promise<void>
}

/** Reads registries only on the six-hour cadence; mutations require an approved plan. */
export class ToolManager extends EventEmitter {
  private readonly runner: Runner
  private readonly stream: typeof runStreaming
  private readonly find: (name: string) => Promise<string | null>
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly binary: string
  private readonly rtkLink: string
  private readonly cacheFile: string
  private updates = Object.fromEntries(UPDATE_KEYS.map((k) => [k, emptyUpdate()])) as UpdateCache
  private tools: ToolInfo[] = IDS.map((id) => ({ id, name: NAMES[id], installed: null, version: null, latest: null,
    updateAvailable: false, checkedAt: null, error: null, blocked: 'Checking installation…', detail: 'Not checked yet.', stats: null }))
  private timer: NodeJS.Timeout | null = null
  private pending: Promise<ToolInfo[]> | null = null
  private mutation = false

  constructor(private readonly deps: ToolDependencies) {
    super()
    this.runner = deps.runner ?? run
    this.stream = deps.stream ?? runStreaming
    this.find = deps.find ?? ((name) => which(name, [join(deps.home, '.local/bin'), join(deps.home, '.cargo/bin')]))
    this.request = deps.request ?? fetch
    this.now = deps.now ?? Date.now
    this.binary = join(deps.root, 'tools', 'rtk')
    this.rtkLink = join(deps.home, '.local', 'bin', 'rtk')
    this.cacheFile = join(deps.root, 'tool-updates.json')
  }

  get current(): ToolInfo[] { return structuredClone(this.tools) }

  async start(): Promise<void> {
    try {
      const raw = object(JSON.parse(await fs.readFile(this.cacheFile, 'utf8')))
      for (const key of UPDATE_KEYS) {
        const e = object(raw[key])
        this.updates[key] = { latest: mcpKey(key as ToolId) ? pypiVersion(e.latest) : releaseVersion(e.latest), checkedAt: typeof e.checkedAt === 'string' ? e.checkedAt : null, error: null }
      }
    } catch { /* No cache yet or invalid cache: check registries again. */ }
    this.stop()
    this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, PRESENCE_INTERVAL_MS)
    this.timer.unref()
    await this.refresh()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  refresh(force = false): Promise<ToolInfo[]> {
    if (this.mutation) return Promise.resolve(this.current)
    if (this.pending) return force ? this.pending.then(() => this.refresh(true)) : this.pending
    this.pending = this.check(force).finally(() => { this.pending = null })
    return this.pending
  }

  private async response(url: string, maxBytes = 1024 * 1024): Promise<Buffer> {
    const response = await this.request(url, { signal: AbortSignal.timeout(maxBytes > 8 * 1024 * 1024 ? 60_000 : 15_000), headers: { 'User-Agent': 'claude-desktop-proxy' } })
    if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}`)
    const chunks: Uint8Array[] = []
    let length = 0
    if (!response.body) throw new Error('Empty update response')
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > maxBytes) throw new Error('Update response is too large')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return Buffer.concat(chunks)
  }

  private async latest(key: UpdateKey): Promise<string> {
    const mcp = key === 'serena' || key === 'markitdown' ? MCP_SERVERS[key] : null
    const url = key === 'headroom' ? 'https://pypi.org/pypi/headroom-ai/json'
      : key === 'rtk' ? 'https://api.github.com/repos/rtk-ai/rtk/releases/latest'
      : mcp ? `https://pypi.org/pypi/${mcp.pkg}/json`
      : `https://raw.githubusercontent.com/${PLUGINS[key as PluginKey].repo}/main/.claude-plugin/plugin.json`
    const raw = object(JSON.parse((await this.response(url, 8 * 1024 * 1024)).toString('utf8')))
    const version = mcp ? pypiVersion(object(raw.info).version)
      : releaseVersion(key === 'headroom' ? object(raw.info).version : key === 'rtk' ? raw.tag_name : raw.version)
    if (!version || (key === 'rtk' && (raw.draft === true || raw.prerelease === true))) throw new Error('No stable version in update source')
    return version
  }

  private async check(force: boolean): Promise<ToolInfo[]> {
    await Promise.all(UPDATE_KEYS.map(async (key) => {
      const previous = this.updates[key]
      const elapsed = this.now() - Date.parse(previous.checkedAt ?? '')
      if (!force && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < UPDATE_INTERVAL_MS) return
      const checkedAt = new Date(this.now()).toISOString()
      try { this.updates[key] = { latest: await this.latest(key), checkedAt, error: null } }
      catch (err) { this.updates[key] = { ...previous, checkedAt, error: `Update check failed: ${(err as Error).message}` } }
    }))
    try { await writeJsonAtomic(this.cacheFile, this.updates) }
    catch (err) { for (const e of Object.values(this.updates)) e.error ??= `Cannot save update cache: ${(err as Error).message}` }
    this.tools = await Promise.all(IDS.map(async (id): Promise<ToolInfo> => {
      const update = this.updates[updateKey(id)]
      const info: ToolInfo = { id, name: NAMES[id], installed: null, version: null, latest: update.latest,
        updateAvailable: false, checkedAt: update.checkedAt, error: update.error, blocked: null, detail: '', stats: null }
      try {
        if (id === 'headroom') {
          const service = await this.deps.headroomInfo()
          info.installed = !!service.binary
          if (service.binary) info.version = await this.readVersion(service.binary)
          if (!service.local || service.managed === 'external') info.blocked = 'Managed outside this app; install or update it with its owner.'
          else if (!service.uv) info.blocked = 'Install uv first: https://docs.astral.sh/uv/'
          info.detail = service.managed === 'ours' ? 'Run by this app; updates restart the active service.' : 'Local headroom package.'
        } else if (id === 'rtk') {
          const binary = await this.rtkBinary()
          info.installed = !!binary
          if (binary) info.version = await this.readVersion(binary)
          if (binary) info.stats = await this.rtkStats(binary)
          if (binary) info.connected = { claude: await this.rtkShow(binary, false), codex: await this.rtkShow(binary, true) }
          if (!['x64', 'arm64'].includes(this.deps.arch ?? process.arch)) info.blocked = 'RTK binary installation supports Linux x64 and arm64.'
          info.detail = binary === this.binary ? 'App-managed binary. Connect it to each client below.'
            : binary ? `Found at ${binary}. Updates install a separate app-managed copy.` : 'Reduces command output before the agent reads it.'
        } else if (mcpKey(id)) {
          await this.detectMcp(info, MCP_SERVERS[mcpKey(id)!].pkg)
        } else {
          const key = pluginKey(id)!
          const codex = id.endsWith('-codex')
          const cli = await this.find(codex ? 'codex' : 'claude')
          if (!cli) { info.installed = false; info.blocked = `Install ${codex ? 'Codex' : 'Claude Code'} first.` }
          else {
            const r = await this.runner(cli, ['plugin', 'list', '--json'])
            if (r.code !== 0) throw new Error(r.stderr || 'Cannot list installed plugins')
            const plugin = pluginInfo(JSON.parse(r.stdout), codex, PLUGINS[key].plugin)
            info.installed = plugin.installed
            info.version = plugin.version
            if (plugin.installed) info.enabled = plugin.enabled
            if (plugin.installed && !codex) info.stats = key === 'ponytail' ? await this.ponytailStats(plugin.version) : await this.chisleStats()
            info.detail = plugin.installed ? `${plugin.enabled ? 'Enabled' : 'Installed but disabled'}. Restart the client after changes.`
              : `Install the official ${PLUGINS[key].name} plugin for this client.`
          }
        }
        info.updateAvailable = info.installed === true && (mcpKey(id)
          ? !!info.version && !!info.latest && info.version !== info.latest
          : newerVersion(info.latest, info.version))
      } catch (err) { info.error = [info.error, `Detection failed: ${(err as Error).message}`].filter(Boolean).join('\n'); info.blocked = 'Resolve the detection error before changing this tool.' }
      return info
    }))
    this.emit('change', this.current)
    return this.current
  }

  private async readVersion(binary: string): Promise<string> {
    const r = await this.runner(binary, ['--version'])
    const version = r.code === 0 ? binaryVersion(r.stdout) : null
    if (!version) throw new Error(`Cannot determine version of ${binary}: ${r.stderr || r.stdout}`)
    return version
  }

  /** Stats are extra information: a failure leaves them out instead of failing detection. */
  private async rtkStats(binary: string): Promise<ToolStats | null> {
    const r = await this.runner(binary, ['gain', '--daily', '--format', 'json'])
    try { return r.code === 0 ? parseRtkGain(JSON.parse(r.stdout)) : null } catch { return null }
  }

  private async rtkShow(binary: string, codex: boolean): Promise<boolean | null> {
    const r = await this.runner(binary, ['init', '-g', ...(codex ? ['--codex'] : []), '--show'])
    return r.code === 0 ? rtkConnected(r.stdout, codex) : null
  }

  /** Our registrations in Claude Code's user config and Codex's config.toml; a foreign entry of that name is reported, never changed. */
  private async detectMcp(info: ToolInfo, pkg: string): Promise<void> {
    const uvx = await this.find('uvx')
    info.installed = !!uvx
    if (!uvx) { info.blocked = 'Install uv first: https://docs.astral.sh/uv/'; info.detail = 'Runs with uvx from PyPI.'; return }
    const claudeJson = join(this.deps.home, '.claude.json')
    const codexToml = join(this.deps.codexHome ?? join(this.deps.home, '.codex'), 'config.toml')
    const read = async (file: string, parse: (text: string) => unknown, key: string): Promise<unknown> => {
      const text = await fs.readFile(file, 'utf8').catch((err) => { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err })
      return text === null ? undefined : object(object(parse(text))[key])[info.id]
    }
    const entries = { claude: await read(claudeJson, JSON.parse, 'mcpServers'), codex: await read(codexToml, parseToml, 'mcp_servers') }
    const pins = { claude: mcpPin(entries.claude, pkg), codex: mcpPin(entries.codex, pkg) }
    info.connected = { claude: entries.claude !== undefined, codex: entries.codex !== undefined }
    info.foreign = { claude: entries.claude !== undefined && !pins.claude, codex: entries.codex !== undefined && !pins.codex }
    info.version = pins.claude ?? pins.codex
    info.detail = `MCP server, run with uvx from PyPI ${pkg}${info.version ? `==${info.version}` : ''} at user scope. Restart the client after changes.`
    if (info.foreign.claude || info.foreign.codex) info.detail += ' A server with this name set up outside the app is left as it is.'
  }

  private async chisleStats(): Promise<ToolStats | null> {
    const file = join(this.deps.home, '.claude', '.chisle-compress-stats.json')
    try { return parseChisleStats(JSON.parse(await fs.readFile(file, 'utf8'))) } catch { return null }
  }

  /** The band ledger when Ponytail has recorded sessions, otherwise its published benchmark. */
  private async ponytailStats(version: string | null): Promise<ToolStats | null> {
    const band = join(this.deps.configHome ?? join(this.deps.home, '.config'), 'ponytail', 'band')
    const files = await fs.readdir(band).catch(() => [] as string[])
    const ledger = parsePonytailBand(await Promise.all(files.filter((f) => f.endsWith('.csv')).map((f) => fs.readFile(join(band, f), 'utf8').catch(() => ''))))
    if (ledger) return ledger
    if (!version) return null
    const skill = join(this.deps.home, '.claude', 'plugins', 'cache', 'ponytail', 'ponytail', version, 'skills', 'ponytail-gain', 'SKILL.md')
    try { return parsePonytailGain(await fs.readFile(skill, 'utf8')) } catch { return null }
  }

  private async rtkBinary(): Promise<string | null> {
    try { await fs.access(this.binary, fs.constants.X_OK); return this.binary } catch { return this.find('rtk') }
  }

  /** Build reviewable commands before the confirmation dialog; this never installs anything. */
  async plan(id: ToolId, action: ToolAction): Promise<ToolPlan> {
    if (!IDS.includes(id) || !['install', 'update', 'connect-claude', 'connect-codex', 'disconnect-claude', 'disconnect-codex', 'remove', 'stop', 'start', 'uninstall'].includes(action)) throw new Error('Unknown tool action')
    await this.refresh()
    const info = this.tools.find((e) => e.id === id)!
    if (info.blocked) throw new Error(info.blocked)
    if (action === 'install' && info.installed !== false) throw new Error('Tool is already installed; use Update or Connect instead')
    if (action === 'update' && !info.updateAvailable) throw new Error('No newer stable version is available')
    const commands: Command[] = []
    const plan: ToolPlan = { id, action, commands, version: info.latest, detail: '' }
    if (action === 'stop' || action === 'start' || action === 'uninstall') return this.lifecyclePlan(info, action, plan)
    const mcp = mcpKey(id)
    if (mcp) return this.mcpPlan(info, mcp, action, plan)
    if (action.startsWith('disconnect-')) {
      if (id !== 'rtk') throw new Error('Only RTK supports this connection action')
      const binary = await this.rtkBinary()
      if (!binary) throw new Error('RTK is not installed')
      const codex = action === 'disconnect-codex'
      const args = ['init', '-g', ...(codex ? ['--codex'] : []), '--uninstall']
      const preview = await this.runner(binary, [...args, '--dry-run'])
      if (preview.code !== 0) throw new Error(preview.stderr || preview.stdout)
      commands.push({ cmd: binary, args })
      plan.detail = `Removes RTK's global hooks and instructions from ${codex ? 'Codex' : 'Claude Code'}. RTK stays installed and can be connected again. Restart the client afterward.\n\n${preview.stdout}\n${preview.stderr}`
    } else if (action === 'remove') {
      const key = pluginKey(id)
      if (!key) throw new Error('Only client plugins can be removed here')
      const { name, plugin } = PLUGINS[key]
      if (info.installed !== true) throw new Error(`${name} is not installed for this client`)
      const codex = id.endsWith('-codex')
      const cli = await this.find(codex ? 'codex' : 'claude')
      if (!cli) throw new Error('Client CLI not found')
      commands.push({ cmd: cli, args: codex ? ['plugin', 'remove', plugin] : ['plugin', 'uninstall', plugin, '--scope', 'user'] })
      plan.detail = `Uninstalls the ${name} plugin from ${codex ? 'Codex' : 'Claude Code'} with the client's own command. Install brings it back. Restart the client afterward.`
    } else if (action.startsWith('connect-')) {
      if (id !== 'rtk') throw new Error('Only RTK supports this connection action')
      const binary = await this.rtkBinary()
      if (!binary) throw new Error('Install RTK first')
      if (binary === this.binary) {
        const onPath = await this.find('rtk')
        const resolved = onPath ? await fs.realpath(onPath).catch(() => onPath) : null
        if (resolved !== await fs.realpath(binary)) {
          throw new Error(`Client hooks invoke rtk through PATH, which currently resolves to ${onPath ?? 'nothing'}. Put ${join(this.deps.home, '.local', 'bin')} before other RTK installations on PATH and restart the app and client before connecting.`)
        }
      }
      const codex = action === 'connect-codex'
      if (!(await this.find(codex ? 'codex' : 'claude'))) throw new Error(`Install ${codex ? 'Codex' : 'Claude Code'} first`)
      // rtk refuses --auto-patch with --codex; Codex's hooks.json is patched without it.
      const args = ['init', '-g', ...(codex ? ['--codex'] : ['--auto-patch']), '--no-trust-filters']
      const preview = await this.runner(binary, [...args, '--dry-run'])
      if (preview.code !== 0) throw new Error(preview.stderr || preview.stdout)
      commands.push({ cmd: binary, args })
      plan.detail = `Registers RTK hooks and instructions for ${codex ? 'Codex' : 'Claude Code'}. Existing client permissions still apply. Restart the client afterward.\n\n${preview.stdout}\n${preview.stderr}`
    } else if (id === 'rtk') {
      if (!plan.version) throw new Error('Check for updates successfully before installing RTK')
      await this.checkRtkLink()
      const urls = rtkUrls(plan.version, this.deps.arch ?? process.arch)
      plan.detail = `Download ${urls.archive}\nand ${urls.checksums}.\nVerify SHA-256, extract only the regular rtk file, and atomically install it at ${this.binary}. Create ${this.rtkLink} as a symlink to it if absent. No existing external binary is overwritten. The client must have ~/.local/bin before other RTK installations on PATH; restart it after installation.\n\nVerification command: ${this.binary}.staging --version`
    } else if (id === 'headroom') {
      if (!plan.version) throw new Error('Check for updates successfully before installing headroom')
      const uv = await this.find('uv')
      if (!uv) throw new Error('Install uv first')
      const service = await this.deps.headroomInfo()
      if (!service.local || service.managed === 'external') throw new Error('Cannot change externally managed headroom')
      commands.push({ cmd: uv, args: ['tool', 'install', '--upgrade', '--python', HEADROOM_PYTHON, `${HEADROOM_PACKAGE}==${plan.version}`] })
      plan.restartHeadroom = service.active
      plan.detail = `Install headroom ${plan.version} with uv (a few hundred MB). ${service.active ? 'The app-managed service will be restarted; requests use the direct API fallback while it restarts.' : 'The service stays stopped; use Set up & start on its card when ready.'}`
    } else {
      const { name, plugin, marketplace, repo } = PLUGINS[pluginKey(id)!]
      const codex = id.endsWith('-codex')
      const cli = await this.find(codex ? 'codex' : 'claude')
      if (!cli) throw new Error('Client CLI not found')
      // Refresh only this plugin's marketplace, never all of the user's plugins.
      const list = await this.runner(cli, ['plugin', 'marketplace', 'list', '--json'])
      if (list.code !== 0) throw new Error(list.stderr || list.stdout)
      const marketplaces: unknown = JSON.parse(list.stdout)
      const entries = Array.isArray(marketplaces) ? marketplaces : object(marketplaces).marketplaces
      if (!Array.isArray(entries)) throw new Error('Unrecognized marketplace list')
      const existing = entries.map(object).find((e) => e.name === marketplace)
      if (existing) {
        if (!officialSource(existing, repo)) throw new Error(`A different marketplace named ${marketplace} already exists; resolve it in the client first`)
        commands.push({ cmd: cli, args: ['plugin', 'marketplace', codex ? 'upgrade' : 'update', marketplace] })
      } else commands.push({ cmd: cli, args: ['plugin', 'marketplace', 'add', repo] })
      commands.push({ cmd: cli, args: ['plugin', codex ? 'add' : info.installed ? 'update' : 'install', plugin, ...(!codex ? ['--scope', 'user'] : [])] })
      plan.detail = `Use the official ${repo} marketplace and install the latest ${name} plugin${info.latest ? ` (currently ${info.latest})` : ''} for this client. Restart the client afterward.${codex ? ` Review and trust ${name} lifecycle hooks in the client’s /hooks screen; the app does not approve them for you.` : ''}`
    }
    if (commands.length) plan.detail += `\n\nCommands (executed without a shell):\n${commands.map(formatCommand).join('\n')}`
    return plan
  }

  /**
   * Machine-wide actions on a whole tool. stop: take it out of every client but keep it installed
   * (RTK hooks, MCP registrations; plugins are disabled, which only Claude Code supports).
   * start: re-enable disabled plugins. uninstall: stop, then remove what the app installed.
   */
  private async lifecyclePlan(info: ToolInfo, action: 'stop' | 'start' | 'uninstall', plan: ToolPlan): Promise<ToolPlan> {
    const clients = ['claude', 'codex'] as const
    const label = (c: 'claude' | 'codex'): string => c === 'codex' ? 'Codex' : 'Claude Code'
    const cli = async (c: 'claude' | 'codex'): Promise<string> => {
      const found = await this.find(c)
      if (!found) throw new Error(`${label(c)} CLI not found`)
      return found
    }
    const notes: string[] = []
    const key = pluginKey(info.id)
    const mcp = mcpKey(info.id)
    if (info.id === 'rtk') {
      if (action === 'start') throw new Error('Connect RTK to a client with its switch')
      const binary = await this.rtkBinary()
      if (!binary) throw new Error('RTK is not installed')
      if (action === 'uninstall' && binary !== this.binary) throw new Error(`RTK at ${binary} was installed outside this app; remove it with its package manager`)
      for (const c of clients.filter((c) => info.connected?.[c])) {
        plan.commands.push({ cmd: binary, args: ['init', '-g', ...(c === 'codex' ? ['--codex'] : []), '--uninstall'] })
      }
      notes.push(action === 'stop' ? 'Removes RTK hooks and instructions from every client; the binary stays.'
        : `Removes RTK hooks and instructions from every client, then deletes ${this.binary}${await this.ownsRtkLink() ? ` and the ${this.rtkLink} symlink` : ''}. RTK's savings history stays.`)
    } else if (key) {
      const { name, plugin, marketplace, repo } = PLUGINS[key]
      const group = this.tools.filter((t) => pluginKey(t.id) === key)
      const claude = group.find((t) => t.id.endsWith('-claude'))
      if (action === 'stop' || action === 'start') {
        const want = action === 'start'
        if (claude?.installed && claude.enabled !== want) {
          plan.commands.push({ cmd: await cli('claude'), args: ['plugin', want ? 'enable' : 'disable', plugin, '--scope', 'user'] })
        }
        notes.push(`${want ? 'Enables' : 'Disables'} ${name} in Claude Code; it stays installed.`)
        if (group.some((t) => t.id.endsWith('-codex') && t.installed)) notes.push('Codex has no plugin disable; use the Codex switch to uninstall it there.')
      } else {
        for (const t of group.filter((t) => t.installed)) {
          const c = t.id.endsWith('-codex') ? 'codex' : 'claude'
          plan.commands.push({ cmd: await cli(c), args: c === 'codex' ? ['plugin', 'remove', plugin] : ['plugin', 'uninstall', plugin, '--scope', 'user'] })
        }
        for (const c of clients) {
          const found = await this.find(c)
          if (!found) continue
          const list = await this.runner(found, ['plugin', 'marketplace', 'list', '--json'])
          const raw: unknown = list.code === 0 ? JSON.parse(list.stdout) : []
          const entries = Array.isArray(raw) ? raw : object(raw).marketplaces
          const existing = Array.isArray(entries) ? entries.map(object).find((e) => e.name === marketplace) : undefined
          // A marketplace of that name from elsewhere is not ours to remove.
          if (existing && officialSource(existing, repo)) plan.commands.push({ cmd: found, args: ['plugin', 'marketplace', 'remove', marketplace] })
        }
        notes.push(`Uninstalls ${name} from every client and removes its ${repo} marketplace.`)
      }
    } else if (mcp) {
      if (action === 'start') throw new Error(`Connect ${info.name} to a client with its switch`)
      for (const c of clients.filter((c) => info.connected?.[c] && !info.foreign?.[c])) {
        plan.commands.push({ cmd: await cli(c), args: c === 'codex' ? ['mcp', 'remove', info.id] : ['mcp', 'remove', '--scope', 'user', info.id] })
      }
      if (clients.some((c) => info.foreign?.[c])) notes.push(`${info.name} set up outside this app is left alone.`)
      if (action === 'uninstall') {
        const uv = await this.find('uv')
        if (uv) plan.commands.push({ cmd: uv, args: ['cache', 'clean', MCP_SERVERS[mcp].pkg] })
        notes.unshift(`Removes ${info.name} from every client and clears its packages from the uv cache.`)
      } else notes.unshift(`Removes the ${info.name} registration from every client; nothing is deleted.`)
    } else throw new Error(`${info.name} is managed on its own card`)
    if (!plan.commands.length && !(info.id === 'rtk' && action === 'uninstall')) throw new Error(`Nothing to ${action}: ${info.name} is not active in any client`)
    plan.detail = `${notes.join(' ')} Restart client sessions afterward.`
    if (plan.commands.length) plan.detail += `\n\nCommands (executed without a shell):\n${plan.commands.map(formatCommand).join('\n')}`
    return plan
  }

  private async ownsRtkLink(): Promise<boolean> {
    try { return (await fs.lstat(this.rtkLink)).isSymbolicLink() && await fs.readlink(this.rtkLink) === this.binary } catch { return false }
  }

  /** Connect, disconnect or re-pin an MCP server with the clients' own `mcp add/remove` commands. */
  private async mcpPlan(info: ToolInfo, key: McpKey, action: ToolAction, plan: ToolPlan): Promise<ToolPlan> {
    const { pkg, uv, args } = MCP_SERVERS[key]
    const name = info.id
    const uvx = (await this.find('uvx'))!
    const cli = async (codex: boolean): Promise<string> => {
      const found = await this.find(codex ? 'codex' : 'claude')
      if (!found) throw new Error(`Install ${codex ? 'Codex' : 'Claude Code'} first`)
      return found
    }
    const add = async (codex: boolean, version: string): Promise<Command> => {
      const server = [uvx, '--python', MCP_PYTHON, ...uv, '--from', `${pkg}==${version}`, ...args(codex)]
      return { cmd: await cli(codex), args: codex ? ['mcp', 'add', name, '--', ...server] : ['mcp', 'add', '--scope', 'user', name, '--', ...server] }
    }
    const remove = async (codex: boolean): Promise<Command> =>
      ({ cmd: await cli(codex), args: codex ? ['mcp', 'remove', name] : ['mcp', 'remove', '--scope', 'user', name] })
    const clients = (['claude', 'codex'] as const)
    if (action === 'update') {
      const ours = clients.filter((c) => info.connected?.[c] && !info.foreign?.[c])
      for (const c of ours) plan.commands.push(await remove(c === 'codex'), await add(c === 'codex', plan.version!))
      plan.detail = `Re-registers ${info.name} with ${pkg}==${plan.version} in ${ours.join(' and ')}; uvx downloads it on the next client start.`
    } else if (action.startsWith('connect-') || action.startsWith('disconnect-')) {
      const client = action.endsWith('-codex') ? 'codex' : 'claude'
      if (info.foreign?.[client]) throw new Error(`${client === 'codex' ? 'Codex' : 'Claude Code'} already has an MCP server named ${name} that this app did not add; change it there`)
      const version = info.version ?? plan.version
      if (action.startsWith('connect-')) {
        if (!version) throw new Error(`Check for updates successfully before adding ${info.name}`)
        plan.version = version
        plan.commands.push(await add(client === 'codex', version))
        plan.detail = `Registers the ${info.name} MCP server (${pkg}==${version}, run by uvx) at user scope. uvx downloads it on the client's next start.`
      } else {
        plan.commands.push(await remove(client === 'codex'))
        plan.detail = `Removes the ${info.name} MCP server registration. Packages cached by uvx stay until \`uv cache clean\`.`
      }
    } else throw new Error(`${info.name} is switched per client; it has nothing to install or remove`)
    plan.detail += ` Restart the client afterward.\n\nCommands (executed without a shell):\n${plan.commands.map(formatCommand).join('\n')}`
    return plan
  }

  async execute(plan: ToolPlan, log: (line: string) => void): Promise<void> {
    if (this.mutation) throw new Error('Another tool action is running')
    if (this.pending) await this.pending
    this.mutation = true
    try {
      if (plan.id === 'headroom') {
        const service = await this.deps.headroomInfo()
        if (!service.local || service.managed === 'external') throw new Error('headroom is now managed outside this app; nothing changed')
      }
      if (plan.id === 'rtk' && (plan.action === 'install' || plan.action === 'update')) await this.installRtk(plan.version!, log)
      for (const command of plan.commands) {
        log(`$ ${formatCommand(command)}`)
        const code = await this.stream(command.cmd, command.args, log)
        if (code !== 0) throw new Error(`${command.cmd} exited with ${code}. Earlier commands may have completed; check the log before retrying.`)
      }
      if (plan.id === 'rtk' && plan.action === 'uninstall') {
        if (await this.ownsRtkLink()) await fs.rm(this.rtkLink)
        await fs.rm(this.binary, { force: true })
        log(`Removed ${this.binary}`)
      }
      if (plan.id === 'headroom' && plan.restartHeadroom) {
        const service = await this.deps.headroomInfo()
        if (service.managed === 'external') throw new Error('Package installed, but the service is now external and was not restarted')
        if (service.active) await this.deps.setupHeadroom()
        else log('The headroom service was stopped while the update was pending; leaving it stopped.')
      }
    } finally { this.mutation = false; await this.refresh() }
    const info = this.tools.find((e) => e.id === plan.id)!
    const client = plan.action.endsWith('-codex') ? 'codex' : 'claude'
    const group = pluginKey(plan.id) ? this.tools.filter((t) => pluginKey(t.id) === pluginKey(plan.id)) : [info]
    const ours = (t: ToolInfo): boolean => (['claude', 'codex'] as const).some((c) => t.connected?.[c] && !t.foreign?.[c])
    if (plan.action === 'stop' && (pluginKey(plan.id) ? group.some((t) => t.id.endsWith('-claude') && t.enabled) : ours(info))) throw new Error(`Commands completed, but ${info.name} is still active.`)
    if (plan.action === 'start' && group.some((t) => t.id.endsWith('-claude') && t.installed && !t.enabled)) throw new Error(`Commands completed, but ${info.name} is still disabled.`)
    if (plan.action === 'uninstall' && (pluginKey(plan.id) ? group.some((t) => t.installed) : plan.id === 'rtk' ? await this.rtkBinary() === this.binary || ours(info) : ours(info))) throw new Error(`Commands completed, but ${info.name} is still present.`)
    if (plan.action === 'remove' && info.installed !== false) throw new Error(`Command completed, but ${info.name} is still listed as installed. ${info.error ?? 'Check the client plugin manager.'}`)
    if (plan.action.startsWith('disconnect-') && info.connected?.[client] !== false) throw new Error(`Command completed, but ${info.name} still shows as connected to ${client === 'codex' ? 'Codex' : 'Claude Code'}.`)
    if (mcpKey(plan.id) && plan.action.startsWith('connect-') && info.version !== plan.version) throw new Error(`Command completed, but ${info.name} ${plan.version} is not registered in ${client === 'codex' ? 'Codex' : 'Claude Code'}.`)
    if ((plan.action === 'install' || plan.action === 'update') && (info.installed !== true || !info.version || (plan.version && (mcpKey(plan.id) ? info.version !== plan.version : newerVersion(plan.version, info.version))))) {
      throw new Error(`Command completed, but ${info.name} ${plan.version ?? ''} could not be verified. ${info.error ?? 'Check the client plugin manager.'}`)
    }
    log('Done. Restart client sessions to apply hook or plugin changes.')
  }

  private async installRtk(version: string, log: (line: string) => void): Promise<void> {
    await this.checkRtkLink()
    const urls = rtkUrls(version, this.deps.arch ?? process.arch)
    log(`Downloading ${urls.archive}`)
    const [archive, checksums] = await Promise.all([this.response(urls.archive, 64 * 1024 * 1024), this.response(urls.checksums)])
    const expected = checksums.toString('utf8').split(/\r?\n/).map((s) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(s))
      .find((m) => m?.[2] === urls.asset)?.[1].toLowerCase()
    if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('RTK SHA-256 verification failed; nothing installed')
    const binary = extractRtk(archive)
    await fs.mkdir(join(this.deps.root, 'tools'), { recursive: true, mode: 0o700 })
    const staging = `${this.binary}.staging`
    // Exclusive create also refuses a pre-existing symlink or interrupted staging file.
    await fs.writeFile(staging, binary, { mode: 0o700, flag: 'wx' })
    try {
      const installed = await this.readVersion(staging)
      if (installed !== version) throw new Error(`Expected RTK ${version}, downloaded binary reports ${installed}`)
      await fs.mkdir(join(this.deps.home, '.local', 'bin'), { recursive: true })
      try { await fs.symlink(this.binary, this.rtkLink) }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; await this.checkRtkLink() }
      await fs.rename(staging, this.binary)
      log(`Installed RTK ${version} at ${this.binary}`)
    } finally { await fs.rm(staging, { force: true }) }
  }

  private async checkRtkLink(): Promise<void> {
    try {
      const entry = await fs.lstat(this.rtkLink)
      if (!entry.isSymbolicLink() || await fs.readlink(this.rtkLink) !== this.binary) {
        throw new Error(`${this.rtkLink} belongs to another installation. Update it with its package manager or move it yourself before installing the app-managed RTK.`)
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  }
}

export function formatCommand(command: Command): string {
  return [command.cmd, ...command.args].map((s) => /^[\w/.:=@+-]+$/.test(s) ? s : JSON.stringify(s)).join(' ')
}

export async function approveToolAction(
  manager: ToolManager, id: ToolId, action: ToolAction,
  approve: (plan: ToolPlan) => Promise<boolean>, log: (line: string) => void
): Promise<boolean> {
  const plan = await manager.plan(id, action)
  if (!(await approve(plan))) return false
  await manager.execute(plan, log)
  return true
}

export function rtkUrls(version: string, arch: string): { archive: string; checksums: string; asset: string } {
  if (!releaseVersion(version)) throw new Error('Invalid RTK release version')
  const target = arch === 'x64' ? 'x86_64-unknown-linux-musl' : arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : null
  if (!target) throw new Error('Unsupported RTK architecture')
  const asset = `rtk-${target}.tar.gz`
  const base = `https://github.com/rtk-ai/rtk/releases/download/v${version}`
  return { archive: `${base}/${asset}`, checksums: `${base}/checksums.txt`, asset }
}

/** Read one regular file from a bounded tar.gz; never extract archive paths to disk. */
export function extractRtk(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString().split('\0')[0]
    const rawSize = header.subarray(124, 136).toString().replace(/\0/g, '').trim()
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid RTK archive size')
    const size = parseInt(rawSize, 8)
    const start = offset + 512
    if (start + size > tar.length) throw new Error('Truncated RTK archive')
    if (name === 'rtk' || name === './rtk') {
      if (![0, 48].includes(header[156]) || header.subarray(345, 500).some((b) => b !== 0)) throw new Error('RTK archive entry is not a regular root file')
      if (!size) throw new Error('Empty RTK executable')
      return tar.subarray(start, start + size)
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  throw new Error('RTK executable is missing from archive')
}

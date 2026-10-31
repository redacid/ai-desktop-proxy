import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { CompressorInfo, ToolAction, ToolId, ToolInfo, ToolStats } from '@shared/ipc'
import { run, runStreaming, type Runner } from '../proxy/exec'
import { which } from '../proxy/tools'
import { writeJsonAtomic } from '../fsutil'
import { HEADROOM_PACKAGE, HEADROOM_PYTHON } from '../compressors/headroom-service'

const IDS: ToolId[] = ['headroom', 'rtk', 'ponytail-claude', 'ponytail-codex']
const NAMES: Record<ToolId, string> = {
  headroom: 'headroom', rtk: 'RTK', 'ponytail-claude': 'Ponytail · Claude Code', 'ponytail-codex': 'Ponytail · Codex'
}
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const PRESENCE_INTERVAL_MS = 60_000
const PONYTAIL = 'ponytail@ponytail'
const PONYTAIL_SOURCE = 'DietrichGebert/ponytail'

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

/** Parse only native installed-plugin lists; an unknown schema is never "missing". */
export function ponytailInfo(raw: unknown, codex: boolean): { installed: boolean; version: string | null; enabled: boolean } {
  const entries = codex ? object(raw).installed : raw
  if (!Array.isArray(entries)) throw new Error('Unrecognized installed-plugin list')
  const candidates = entries.map(object).filter((e) => (codex ? e.pluginId : e.id) === PONYTAIL && (!e.scope || e.scope === 'user'))
  const entry = candidates[0]
  return { installed: !!entry, version: releaseVersion(entry?.version), enabled: entry?.enabled === true }
}

export function officialPonytailSource(entry: unknown): boolean {
  const e = object(entry)
  const source = object(e.marketplaceSource)
  const nested = object(e.source)
  return [e.repo, e.url, e.source, source.source, source.url, source.repoUrl, nested.repo, nested.url].some((v) =>
    typeof v === 'string' && /^(?:DietrichGebert\/ponytail|https:\/\/github\.com\/DietrichGebert\/ponytail(?:\.git)?\/?|git@github\.com:DietrichGebert\/ponytail(?:\.git)?)$/i.test(v))
}

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
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
  return facts.length ? { source: `published benchmark${bench ? ` (${bench})` : ''}; Ponytail records nothing locally`, facts, daily: [] } : null
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
type UpdateCache = Record<'headroom' | 'rtk' | 'ponytail', UpdateEntry>
const emptyUpdate = (): UpdateEntry => ({ latest: null, checkedAt: null, error: null })

export interface ToolDependencies {
  root: string
  home: string
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
  private updates: UpdateCache = { headroom: emptyUpdate(), rtk: emptyUpdate(), ponytail: emptyUpdate() }
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
      for (const key of ['headroom', 'rtk', 'ponytail'] as const) {
        const e = object(raw[key])
        this.updates[key] = { latest: releaseVersion(e.latest), checkedAt: typeof e.checkedAt === 'string' ? e.checkedAt : null, error: null }
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

  private async latest(key: keyof UpdateCache): Promise<string> {
    const url = key === 'headroom' ? 'https://pypi.org/pypi/headroom-ai/json'
      : key === 'rtk' ? 'https://api.github.com/repos/rtk-ai/rtk/releases/latest'
      : 'https://raw.githubusercontent.com/DietrichGebert/ponytail/main/.claude-plugin/plugin.json'
    const raw = object(JSON.parse((await this.response(url, 8 * 1024 * 1024)).toString('utf8')))
    const version = releaseVersion(key === 'headroom' ? object(raw.info).version : key === 'rtk' ? raw.tag_name : raw.version)
    if (!version || (key === 'rtk' && (raw.draft === true || raw.prerelease === true))) throw new Error('No stable version in update source')
    return version
  }

  private async check(force: boolean): Promise<ToolInfo[]> {
    await Promise.all((['headroom', 'rtk', 'ponytail'] as const).map(async (key) => {
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
      const key = id.startsWith('ponytail') ? 'ponytail' : id as 'rtk' | 'headroom'
      const update = this.updates[key]
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
        } else {
          const codex = id === 'ponytail-codex'
          const cli = await this.find(codex ? 'codex' : 'claude')
          if (!cli) { info.installed = false; info.blocked = `Install ${codex ? 'Codex' : 'Claude Code'} first.` }
          else {
            const r = await this.runner(cli, ['plugin', 'list', '--json'])
            if (r.code !== 0) throw new Error(r.stderr || 'Cannot list installed plugins')
            const plugin = ponytailInfo(JSON.parse(r.stdout), codex)
            info.installed = plugin.installed
            info.version = plugin.version
            if (plugin.installed && !codex) info.stats = await this.ponytailStats(plugin.version)
            info.detail = plugin.installed ? `${plugin.enabled ? 'Enabled' : 'Installed but disabled'}. Restart the client after changes.`
              : 'Install the official Ponytail plugin for this client.'
          }
        }
        info.updateAvailable = info.installed === true && newerVersion(info.latest, info.version)
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

  private async ponytailStats(version: string | null): Promise<ToolStats | null> {
    if (!version) return null
    const skill = join(this.deps.home, '.claude', 'plugins', 'cache', 'ponytail', 'ponytail', version, 'skills', 'ponytail-gain', 'SKILL.md')
    try { return parsePonytailGain(await fs.readFile(skill, 'utf8')) } catch { return null }
  }

  private async rtkBinary(): Promise<string | null> {
    try { await fs.access(this.binary, fs.constants.X_OK); return this.binary } catch { return this.find('rtk') }
  }

  /** Build reviewable commands before the confirmation dialog; this never installs anything. */
  async plan(id: ToolId, action: ToolAction): Promise<ToolPlan> {
    if (!IDS.includes(id) || !['install', 'update', 'connect-claude', 'connect-codex'].includes(action)) throw new Error('Unknown tool action')
    await this.refresh()
    const info = this.tools.find((e) => e.id === id)!
    if (info.blocked) throw new Error(info.blocked)
    if (action === 'install' && info.installed !== false) throw new Error('Tool is already installed; use Update or Connect instead')
    if (action === 'update' && !info.updateAvailable) throw new Error('No newer stable version is available')
    const commands: Command[] = []
    const plan: ToolPlan = { id, action, commands, version: info.latest, detail: '' }
    if (action.startsWith('connect-')) {
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
      const codex = id === 'ponytail-codex'
      const cli = await this.find(codex ? 'codex' : 'claude')
      if (!cli) throw new Error('Client CLI not found')
      // Refresh only Ponytail's marketplace, never all of the user's plugins.
      const list = await this.runner(cli, ['plugin', 'marketplace', 'list', '--json'])
      if (list.code !== 0) throw new Error(list.stderr || list.stdout)
      const marketplaces: unknown = JSON.parse(list.stdout)
      const entries = Array.isArray(marketplaces) ? marketplaces : object(marketplaces).marketplaces
      if (!Array.isArray(entries)) throw new Error('Unrecognized marketplace list')
      const existing = entries.map(object).find((e) => e.name === 'ponytail')
      if (existing) {
        if (!officialPonytailSource(existing)) throw new Error('A different marketplace named ponytail already exists; resolve it in the client first')
        commands.push({ cmd: cli, args: ['plugin', 'marketplace', codex ? 'upgrade' : 'update', 'ponytail'] })
      } else commands.push({ cmd: cli, args: ['plugin', 'marketplace', 'add', PONYTAIL_SOURCE] })
      commands.push({ cmd: cli, args: ['plugin', codex ? 'add' : info.installed ? 'update' : 'install', PONYTAIL, ...(!codex ? ['--scope', 'user'] : [])] })
      plan.detail = `Use the official ${PONYTAIL_SOURCE} marketplace and install the latest Ponytail plugin${info.latest ? ` (currently ${info.latest})` : ''} for this client. Restart the client afterward.${codex ? ' Review and trust Ponytail lifecycle hooks in the client’s /hooks screen; the app does not approve them for you.' : ''}`
    }
    if (commands.length) plan.detail += `\n\nCommands (executed without a shell):\n${commands.map(formatCommand).join('\n')}`
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
      if (plan.id === 'rtk' && !plan.action.startsWith('connect-')) await this.installRtk(plan.version!, log)
      for (const command of plan.commands) {
        log(`$ ${formatCommand(command)}`)
        const code = await this.stream(command.cmd, command.args, log)
        if (code !== 0) throw new Error(`${command.cmd} exited with ${code}. Earlier commands may have completed; check the log before retrying.`)
      }
      if (plan.id === 'headroom' && plan.restartHeadroom) {
        const service = await this.deps.headroomInfo()
        if (service.managed === 'external') throw new Error('Package installed, but the service is now external and was not restarted')
        if (service.active) await this.deps.setupHeadroom()
        else log('The headroom service was stopped while the update was pending; leaving it stopped.')
      }
    } finally { this.mutation = false; await this.refresh() }
    const info = this.tools.find((e) => e.id === plan.id)!
    if (!plan.action.startsWith('connect-') && (info.installed !== true || !info.version || (plan.version && newerVersion(plan.version, info.version)))) {
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

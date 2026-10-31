import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { ProxyInfo } from '@shared/ipc'
import { exists } from '../fsutil'
import { isPortListening } from '../proxy-env'
import type { Settings } from '../store'
import { run as defaultRun, runStreaming, type Runner } from './exec'
import { renderUnit, SystemdUser } from './systemd'

export const UNIT = 'claude-desktop-proxy.service' // same name as legacy/cdp.sh, so setup migrates it
export const API_HOSTS_REGEX = '^api[.]anthropic[.]com:443$'

export interface ProxyPaths {
  unitFile: string
  addonSource: string // shipped with the app
  addonTarget: string // stable copy the unit points at (AppImage paths change every run)
}

export function defaultUnitFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'systemd', 'user', UNIT)
}

/** mitmdump arguments; everything not about routing stays at mitmproxy defaults. */
export function mitmdumpArgs(s: Pick<Settings, 'proxyPort' | 'headroomUrl'>, addon: string): string[] {
  return [
    '--listen-host', '127.0.0.1',
    '--listen-port', String(s.proxyPort),
    // Only the API is decrypted; every other host is a plain CONNECT tunnel.
    '--allow-hosts', API_HOSTS_REGEX,
    '-s', addon,
    '--set', `cdp_upstream=${s.headroomUrl}`,
    // Forward SSE replies as they arrive instead of buffering them.
    '--set', 'stream_large_bodies=1',
    // Connect upstream only once the request is known, so routed requests never open
    // a connection to the API they will not use.
    '--set', 'connection_strategy=lazy',
    '--set', 'flow_detail=1'
  ]
}

async function which(name: string, extraDirs: string[] = []): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraDirs].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

const userBinDirs = (): string[] => [join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')]

/** Installs, configures and runs mitmdump as a systemd user service. */
export class ProxyManager {
  private readonly systemd: SystemdUser

  constructor(
    private readonly settings: () => Settings,
    private readonly paths: ProxyPaths,
    private readonly runner: Runner = defaultRun,
    private readonly listening: (port: number) => Promise<boolean> = isPortListening
  ) {
    this.systemd = new SystemdUser(UNIT, runner)
  }

  async findUv(): Promise<string | null> {
    return which('uv', userBinDirs())
  }

  async findMitmdump(): Promise<string | null> {
    const uv = await this.findUv()
    const dirs = userBinDirs()
    if (uv) {
      // uv's tool bin dir can be moved with UV_TOOL_BIN_DIR / XDG_BIN_HOME.
      const r = await this.runner(uv, ['tool', 'dir', '--bin'])
      const dir = r.code === 0 ? r.stdout.trim().split('\n').pop() : undefined
      if (dir) dirs.unshift(dir)
    }
    for (const dir of dirs) {
      const candidate = join(dir, 'mitmdump')
      if (await exists(candidate)) return candidate
    }
    return which('mitmdump')
  }

  private async expectedUnit(mitmdump: string): Promise<string> {
    return renderUnit({
      description: 'Claude Desktop Proxy (mitmdump)',
      exec: mitmdump,
      args: mitmdumpArgs(this.settings(), this.paths.addonTarget)
    })
  }

  async info(): Promise<ProxyInfo> {
    const s = this.settings()
    const [mitmdump, uv, listening, caExists, active] = await Promise.all([
      this.findMitmdump(),
      this.findUv(),
      this.listening(s.proxyPort),
      exists(s.caFile),
      this.systemd.isActive()
    ])
    let unit: ProxyInfo['unit'] = 'missing'
    try {
      const current = await fs.readFile(this.paths.unitFile, 'utf8')
      const addonCurrent = await this.addonIsCurrent()
      if (current.includes('--map-remote')) unit = 'legacy'
      else if (mitmdump && current === (await this.expectedUnit(mitmdump)) && addonCurrent) unit = 'current'
      else unit = 'outdated'
    } catch {
      // no unit file
    }
    return { port: s.proxyPort, mitmdump, uv, unit, active, listening, caExists }
  }

  private async addonIsCurrent(): Promise<boolean> {
    try {
      const [a, b] = await Promise.all([
        fs.readFile(this.paths.addonSource, 'utf8'),
        fs.readFile(this.paths.addonTarget, 'utf8')
      ])
      return a === b
    } catch {
      return false
    }
  }

  /** `uv tool install mitmproxy`, reporting output line by line. */
  async install(onLine: (line: string) => void): Promise<void> {
    const uv = await this.findUv()
    if (!uv) throw new Error('uv is not installed; see https://docs.astral.sh/uv/getting-started/installation/')
    onLine(`$ ${uv} tool install mitmproxy`)
    const code = await runStreaming(uv, ['tool', 'install', 'mitmproxy'], onLine)
    if (code !== 0) throw new Error(`uv tool install mitmproxy exited with ${code}`)
    if (!(await this.findMitmdump())) throw new Error('mitmproxy installed, but mitmdump was not found')
  }

  /** Writes the addon and the unit, then (re)starts the service and waits until it serves. */
  async setup(): Promise<void> {
    const mitmdump = await this.findMitmdump()
    if (!mitmdump) throw new Error('mitmdump not found; install mitmproxy first')
    await fs.mkdir(dirname(this.paths.addonTarget), { recursive: true })
    await fs.copyFile(this.paths.addonSource, this.paths.addonTarget)
    await fs.mkdir(dirname(this.paths.unitFile), { recursive: true })
    await fs.writeFile(this.paths.unitFile, await this.expectedUnit(mitmdump))
    await this.systemd.daemonReload()
    await this.systemd.enable()
    await this.systemd.restart()
    await this.waitUntilServing()
  }

  async start(): Promise<void> {
    await this.systemd.start()
    await this.waitUntilServing()
  }

  stop(): Promise<void> {
    return this.systemd.stop()
  }

  async remove(): Promise<void> {
    await this.systemd.disableNow()
    await fs.rm(this.paths.unitFile, { force: true })
    await this.systemd.daemonReload()
  }

  logs(lines = 80): Promise<string> {
    return this.systemd.logs(lines)
  }

  /** mitmdump creates its CA on first start; both port and CA must be there. */
  private async waitUntilServing(timeoutMs = 15_000): Promise<void> {
    const s = this.settings()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.listening(s.proxyPort)) && (await exists(s.caFile))) return
      await new Promise((r) => setTimeout(r, 500))
    }
    const tail = await this.logs(15)
    throw new Error(`proxy did not start on 127.0.0.1:${s.proxyPort} within ${timeoutMs / 1000}s\n${tail}`)
  }
}

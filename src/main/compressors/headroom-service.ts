import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { CompressorInfo } from '@shared/ipc'
import { run as defaultRun, runStreaming, type Runner } from '../proxy/exec'
import { renderUnit, SystemdUser } from '../proxy/systemd'
import { findUv, findUvTool, portOwner, PortTakenError, userUnitFile } from '../proxy/tools'
import type { Settings } from '../store'

export const HEADROOM_UNIT = 'claude-desktop-proxy-headroom.service'
export const HEADROOM_PACKAGE = 'headroom-ai[all]'
// headroom needs Python 3.10+; uv fetches this one if the system has none.
export const HEADROOM_PYTHON = '3.13'
// headroom must reach the API directly; a proxy here would loop back through mitmproxy.
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/** Host and port of a local headroom URL, or null when it points elsewhere (then it cannot be run here). */
export function localEndpoint(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null
    return { host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 80) }
  } catch {
    return null
  }
}

/**
 * Installs headroom with uv and runs `headroom proxy` as a systemd user service.
 * When headroom already answers but our service is not the one serving it (for
 * example Headroom Desktop runs it), it is reported as external and left alone.
 */
export class HeadroomService {
  private readonly systemd: SystemdUser

  constructor(
    private readonly settings: () => Settings,
    private readonly answering: () => Promise<boolean>,
    private readonly unitFile = userUnitFile(HEADROOM_UNIT),
    private readonly runner: Runner = defaultRun
  ) {
    this.systemd = new SystemdUser(HEADROOM_UNIT, runner)
  }

  findBinary(): Promise<string | null> {
    return findUvTool('headroom', this.runner)
  }

  private unit(binary: string, ep: { host: string; port: number }): string {
    return renderUnit({
      description: 'headroom proxy (Claude Desktop Proxy)',
      exec: binary,
      args: [
        'proxy', '--host', ep.host, '--port', String(ep.port),
        // Keeps request/response bodies in memory (loopback-only feed) so the app can show them.
        ...(this.settings().headroomLogMessages ? ['--log-messages'] : [])
      ],
      unsetEnv: PROXY_VARS
    })
  }

  async info(): Promise<CompressorInfo> {
    const ep = localEndpoint(this.settings().headroomUrl)
    const [binary, uv, answering, active] = await Promise.all([
      this.findBinary(),
      findUv(),
      this.answering(),
      this.systemd.isActive()
    ])
    let unit: CompressorInfo['unit'] = 'missing'
    try {
      const text = await fs.readFile(this.unitFile, 'utf8')
      unit = binary && ep && text === this.unit(binary, ep) ? 'current' : 'outdated'
    } catch {
      // no unit
    }
    const managed: CompressorInfo['managed'] = active ? 'ours' : answering ? 'external' : 'none'
    return { binary, uv, unit, active, answering, managed, local: ep !== null }
  }

  async install(onLine: (line: string) => void): Promise<void> {
    const uv = await findUv()
    if (!uv) throw new Error('uv is not installed; see https://docs.astral.sh/uv/getting-started/installation/')
    const args = ['tool', 'install', '--python', HEADROOM_PYTHON, HEADROOM_PACKAGE]
    onLine(`$ ${uv} ${args.join(' ')}`)
    const code = await runStreaming(uv, args, onLine)
    if (code !== 0) throw new Error(`uv tool install exited with ${code}`)
    if (!(await this.findBinary())) throw new Error('headroom installed, but the headroom command was not found')
  }

  async setup(): Promise<void> {
    const binary = await this.findBinary()
    if (!binary) throw new Error('headroom is not installed')
    const ep = localEndpoint(this.settings().headroomUrl)
    if (!ep) throw new Error(`${this.settings().headroomUrl} is not a local http URL; headroom can only be run here on 127.0.0.1`)
    const owner = await portOwner(ep.port, this.runner)
    if (owner && owner.pid !== (await this.systemd.mainPid())) throw new PortTakenError(ep.port, owner, 'headroom')
    await fs.mkdir(dirname(this.unitFile), { recursive: true })
    await fs.writeFile(this.unitFile, this.unit(binary, ep))
    await this.systemd.daemonReload()
    await this.systemd.enable()
    await this.systemd.restart()
    await this.waitUntilAnswering()
  }

  async start(): Promise<void> {
    await this.systemd.start()
    await this.waitUntilAnswering()
  }

  stop(): Promise<void> {
    return this.systemd.stop()
  }

  async remove(): Promise<void> {
    await this.systemd.disableNow()
    await fs.rm(this.unitFile, { force: true })
    await this.systemd.daemonReload()
  }

  logs(lines = 80): Promise<string> {
    return this.systemd.logs(lines)
  }

  /** headroom loads models on start; give it a while. */
  private async waitUntilAnswering(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.answering()) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`headroom did not answer within ${timeoutMs / 1000}s\n${await this.logs(15)}`)
  }
}

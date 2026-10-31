import type { Runner } from './exec'

/**
 * Quotes one ExecStart argument for systemd: double quotes, with backslash and
 * quote escaped, `$` doubled (no variable expansion) and `%` doubled (no specifiers).
 */
export function quoteArg(arg: string): string {
  const escaped = arg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')
  return `"${escaped}"`
}

export interface UnitSpec {
  description: string
  exec: string
  args: string[]
}

export function renderUnit(spec: UnitSpec): string {
  const execStart = [spec.exec, ...spec.args].map(quoteArg).join(' ')
  return `# Managed by Claude Desktop Proxy; edits are overwritten.
[Unit]
Description=${spec.description}
After=network-online.target

[Service]
ExecStart=${execStart}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

/** `systemctl --user` / `journalctl --user` for one unit. */
export class SystemdUser {
  constructor(
    readonly unit: string,
    private readonly runner: Runner
  ) {}

  private async ctl(...args: string[]): Promise<void> {
    const r = await this.runner('systemctl', ['--user', ...args])
    if (r.code !== 0) throw new Error(`systemctl --user ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  }

  daemonReload(): Promise<void> {
    return this.ctl('daemon-reload')
  }
  enable(): Promise<void> {
    return this.ctl('enable', this.unit)
  }
  restart(): Promise<void> {
    return this.ctl('restart', this.unit)
  }
  start(): Promise<void> {
    return this.ctl('start', this.unit)
  }
  stop(): Promise<void> {
    return this.ctl('stop', this.unit)
  }
  async disableNow(): Promise<void> {
    await this.runner('systemctl', ['--user', 'disable', '--now', this.unit]) // fine if already gone
  }

  async isActive(): Promise<boolean> {
    return (await this.runner('systemctl', ['--user', 'is-active', '--quiet', this.unit])).code === 0
  }

  /** PID of the service's main process, or 0 when it is not running. */
  async mainPid(): Promise<number> {
    const r = await this.runner('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', this.unit])
    return Number.parseInt(r.stdout.trim(), 10) || 0
  }

  async logs(lines: number): Promise<string> {
    const r = await this.runner('journalctl', ['--user', '-u', this.unit, '-n', String(lines), '--no-pager', '-o', 'short-iso'])
    return (r.stdout || r.stderr).trim()
  }
}

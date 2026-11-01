import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { exists } from './fsutil'

const FILE = 'ai-desktop-proxy.desktop'

export function autostartFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'autostart', FILE)
}

/** Quotes one Exec= argument per the Desktop Entry spec. */
export function desktopArg(arg: string): string {
  if (!/[\s"'\\`$<>|;&*?#()]/.test(arg)) return arg
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`
}

export function desktopEntry(command: string[]): string {
  return `[Desktop Entry]
Type=Application
Name=AI Desktop Proxy
Comment=Routes AI coding clients through a local compression proxy
Exec=${command.map(desktopArg).join(' ')}
Icon=ai-desktop-proxy
Terminal=false
X-GNOME-Autostart-enabled=true
`
}

/** Starts the app hidden in the tray at login, via the XDG autostart directory. */
export class Autostart {
  constructor(
    private readonly command: () => string[],
    private readonly file = autostartFile()
  ) {}

  /** Replaces an entry written under an older file name (e.g. before the app was renamed). */
  async migrateFrom(oldName: string): Promise<void> {
    const old = join(dirname(this.file), oldName)
    if (!(await exists(old))) return
    await this.set(true)
    await fs.rm(old, { force: true })
  }

  isEnabled(): Promise<boolean> {
    return exists(this.file)
  }

  async set(enabled: boolean): Promise<void> {
    if (!enabled) {
      await fs.rm(this.file, { force: true })
      return
    }
    await fs.mkdir(dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, desktopEntry([...this.command(), '--hidden']))
  }
}

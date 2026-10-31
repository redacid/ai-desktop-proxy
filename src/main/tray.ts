import { join } from 'node:path'
import { app, Menu, Tray, nativeImage } from 'electron'
import type { AppStatus, Health } from '@shared/ipc'

const labels: Record<Health, string> = {
  ok: 'All good',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown'
}

function icon(health: Health): Electron.NativeImage {
  // resources/ is shipped next to the app (extraResources) and lives at the repo root in dev.
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources')
  return nativeImage.createFromPath(join(base, `tray-${health}.png`))
}

export interface TrayActions {
  show(): void
  toggleWindow(): void
  refresh(): void
  setClientEnabled(id: string, enabled: boolean): void
  quit(): void
}

export class AppTray {
  private tray: Tray
  private lastKey = ''

  constructor(private actions: TrayActions) {
    this.tray = new Tray(icon('unknown'))
    this.tray.on('click', () => actions.toggleWindow())
    this.update(null)
  }

  update(status: AppStatus | null): void {
    const health = status?.overall ?? 'unknown'
    const clients = status?.clientList ?? []
    // Rebuilding the menu on every poll makes some Linux trays flicker; only do it on change.
    const key = JSON.stringify([health, status?.proxy.health, status?.compressor.health,
      clients.map((c) => [c.id, c.enabled, c.state])])
    if (key === this.lastKey) return
    this.lastKey = key

    this.tray.setImage(icon(health))
    this.tray.setToolTip(`Claude Desktop Proxy: ${labels[health]}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show', click: () => this.actions.show() },
        { type: 'separator' },
        { label: `Proxy: ${status?.proxy.health ?? 'unknown'}`, enabled: false },
        { label: `Compressor: ${status?.compressor.health ?? 'unknown'}`, enabled: false },
        { type: 'separator' },
        ...clients.map((c): Electron.MenuItemConstructorOptions => ({
          label: `Route ${c.name}${c.enabled && c.state !== 'applied' ? ` (${c.state})` : ''}`,
          type: 'checkbox',
          checked: c.enabled,
          click: () => this.actions.setClientEnabled(c.id, !c.enabled)
        })),
        { label: 'Check now', click: () => this.actions.refresh() },
        { type: 'separator' },
        { label: 'Quit', click: () => this.actions.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}

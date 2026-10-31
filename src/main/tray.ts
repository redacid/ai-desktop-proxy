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
  quit(): void
}

export class AppTray {
  private tray: Tray

  constructor(private actions: TrayActions) {
    this.tray = new Tray(icon('unknown'))
    this.tray.on('click', () => actions.toggleWindow())
    this.update(null)
  }

  update(status: AppStatus | null): void {
    const health = status?.overall ?? 'unknown'
    this.tray.setImage(icon(health))
    this.tray.setToolTip(`Claude Desktop Proxy: ${labels[health]}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show', click: () => this.actions.show() },
        { type: 'separator' },
        { label: `Proxy: ${status?.proxy.health ?? 'unknown'}`, enabled: false },
        { label: `Compressor: ${status?.compressor.health ?? 'unknown'}`, enabled: false },
        { label: `Clients: ${status?.clients.health ?? 'unknown'}`, enabled: false },
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

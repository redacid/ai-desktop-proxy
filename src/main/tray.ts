import { app, Menu, Tray, nativeImage } from 'electron'
import type { AppStatus, Health, ProxyAction } from '@shared/ipc'
import { resourcePath } from './paths'

const labels: Record<Health, string> = {
  ok: 'All good',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown'
}

const BUSY_FRAMES = 8
const BUSY_FRAME_MS = 150

// nativeImage loads the matching @2x file next to each PNG on HiDPI screens.
function icon(name: string): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath('tray', `${name}.png`))
}

export interface TrayActions {
  show(): void
  toggleWindow(): void
  refresh(): void
  setClientEnabled(id: string, enabled: boolean): void
  proxyAction(action: ProxyAction): void
  quit(): void
}

export class AppTray {
  private tray: Tray
  private lastKey = ''
  private health: Health = 'unknown'
  private busyTimer: NodeJS.Timeout | null = null
  private busyFrames: Electron.NativeImage[] = []

  constructor(private actions: TrayActions) {
    this.tray = new Tray(icon('unknown'))
    this.tray.on('click', () => actions.toggleWindow())
    this.update(null)
  }

  update(status: AppStatus | null): void {
    const health = status?.overall ?? 'unknown'
    const clients = status?.clientList ?? []
    // Rebuilding the menu on every poll makes some Linux trays flicker; only do it on change.
    const proxyUp = !!status?.proxyInfo?.listening
    const canStart = !!status?.proxyInfo?.mitmdump && status.proxyInfo.unit !== 'missing'
    const key = JSON.stringify([health, status?.proxy.health, status?.compressor.health, proxyUp, canStart,
      clients.map((c) => [c.id, c.enabled, c.state])])
    if (key === this.lastKey) return
    this.lastKey = key

    this.health = health
    if (!this.busyTimer) this.tray.setImage(icon(health))
    this.tray.setToolTip(`AI Desktop Proxy ${app.getVersion()}: ${labels[health]}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `AI Desktop Proxy v${app.getVersion()}`, enabled: false },
        { label: 'Show', click: () => this.actions.show() },
        { type: 'separator' },
        { label: `Proxy: ${status?.proxy.health ?? 'unknown'}`, enabled: false },
        proxyUp
          ? { label: 'Stop proxy', click: () => this.actions.proxyAction('stop') }
          : { label: 'Start proxy', enabled: canStart, click: () => this.actions.proxyAction('start') },
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

  /** Plays the squeeze animation while a service action runs; back to the health icon after. */
  setBusy(busy: boolean): void {
    if (busy === !!this.busyTimer) return
    if (busy) {
      if (!this.busyFrames.length) {
        this.busyFrames = Array.from({ length: BUSY_FRAMES }, (_, i) => icon(`busy-${i}`))
      }
      let frame = 0
      this.tray.setImage(this.busyFrames[0])
      this.busyTimer = setInterval(() => {
        frame = (frame + 1) % BUSY_FRAMES
        this.tray.setImage(this.busyFrames[frame])
      }, BUSY_FRAME_MS)
    } else {
      clearInterval(this.busyTimer!)
      this.busyTimer = null
      this.tray.setImage(icon(this.health))
    }
  }

  destroy(): void {
    this.setBusy(false)
    this.tray.destroy()
  }
}

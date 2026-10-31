import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC, type ActionResult } from '@shared/ipc'
import { ClaudeCodeAdapter } from './clients/claude-code'
import { ClientManager } from './clients/manager'
import { HeadroomBackend } from './compressors/headroom'
import { isPortListening } from './proxy-env'
import { StatusMonitor } from './status'
import { AppStore } from './store'
import { AppTray } from './tray'
import { createMainWindow } from './window'

const FAST_POLL_MS = 5_000 // window visible
const SLOW_POLL_MS = 30_000 // window hidden in the tray

let win: BrowserWindow | null = null
let tray: AppTray | null = null
let quitting = false

const store = new AppStore(join(app.getPath('userData'), 'state.json'))
const clients = new ClientManager([new ClaudeCodeAdapter()], store)
const headroom = (): HeadroomBackend => new HeadroomBackend(store.settings.headroomUrl)

const monitor = new StatusMonitor({
  proxy: async () => {
    const port = store.settings.proxyPort
    return (await isPortListening(port))
      ? { health: 'ok', detail: `listening on 127.0.0.1:${port}` }
      : { health: 'down', detail: `nothing listens on 127.0.0.1:${port}` }
  },
  compressor: () => headroom().health(),
  stats: () => headroom().stats(),
  clients: async () => clients.list
})

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = createMainWindow(() => quitting)
    // Poll fast while the user is looking, slowly while the app sits in the tray.
    win.on('show', () => monitor.start(FAST_POLL_MS))
    win.on('hide', () => monitor.start(SLOW_POLL_MS))
  }
  win.show()
  win.focus()
}

function toggleWindow(): void {
  if (win?.isVisible()) win.hide()
  else showWindow()
}

async function setClientEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  const error = await clients.setEnabled(id, enabled)
  const status = await monitor.refresh()
  return error ? { ok: false, error, status } : { ok: true, status }
}

// One instance only: a second launch brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    await store.load()

    ipcMain.handle(IPC.getStatus, () => monitor.current)
    ipcMain.handle(IPC.refreshStatus, async () => {
      await clients.checkNow()
      return monitor.refresh()
    })
    ipcMain.handle(IPC.setClientEnabled, (_e, id: string, enabled: boolean) => setClientEnabled(id, enabled))

    tray = new AppTray({
      show: showWindow,
      toggleWindow,
      refresh: () => void clients.checkNow().then(() => monitor.refresh()),
      setClientEnabled: (id, enabled) => void setClientEnabled(id, enabled),
      quit: () => {
        quitting = true
        app.quit()
      }
    })

    monitor.on('change', (status) => {
      tray?.update(status)
      win?.webContents.send(IPC.statusChanged, status)
    })
    // A config change found by the watcher shows up without waiting for the next poll.
    clients.on('change', () => void monitor.refresh())

    clients.start()
    monitor.start(SLOW_POLL_MS)
    // --hidden starts straight into the tray (used for autostart on login).
    if (!process.argv.includes('--hidden')) showWindow()
  })

  // Keep running in the tray when every window is closed.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
    clients.stop()
    monitor.stop()
    tray?.destroy()
  })
}

import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { StatusMonitor } from './status'
import { AppTray } from './tray'
import { createMainWindow } from './window'

const FAST_POLL_MS = 5_000 // window visible
const SLOW_POLL_MS = 30_000 // window hidden in the tray

let win: BrowserWindow | null = null
let tray: AppTray | null = null
let quitting = false
const monitor = new StatusMonitor()

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

// One instance only: a second launch brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    ipcMain.handle(IPC.getStatus, () => monitor.current)
    ipcMain.handle(IPC.refreshStatus, () => monitor.refresh())

    tray = new AppTray({
      show: showWindow,
      toggleWindow,
      refresh: () => void monitor.refresh(),
      quit: () => {
        quitting = true
        app.quit()
      }
    })

    monitor.on('change', (status) => {
      tray?.update(status)
      win?.webContents.send(IPC.statusChanged, status)
    })

    monitor.start(SLOW_POLL_MS)
    // --hidden starts straight into the tray (used for autostart on login).
    if (!process.argv.includes('--hidden')) showWindow()
  })

  // Keep running in the tray when every window is closed.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
    monitor.stop()
    tray?.destroy()
  })
}

import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { resourcePath } from './paths'

export function createMainWindow(isQuitting: () => boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'AI Desktop Proxy',
    icon: resourcePath('icon.png'), // taskbar/alt-tab; packaged builds also get it from the .desktop entry
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Closing the window hides it to the tray; only Quit from the tray exits.
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only web pages; never file: or custom schemes that would launch local programs.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

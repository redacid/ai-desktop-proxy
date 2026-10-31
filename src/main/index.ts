import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, type ActionResult, type ProxyAction } from '@shared/ipc'
import { ClaudeCodeAdapter } from './clients/claude-code'
import { ClientManager } from './clients/manager'
import { HeadroomBackend } from './compressors/headroom'
import { resourcePath } from './paths'
import { defaultUnitFile, PortTakenError, ProxyManager } from './proxy/manager'
import { isPortListening } from './proxy-env'
import { proxyStatus, StatusMonitor } from './status'
import { AppStore } from './store'
import { AppTray } from './tray'
import { createMainWindow } from './window'

const FAST_POLL_MS = 5_000 // window visible
const SLOW_POLL_MS = 30_000 // window hidden in the tray

let win: BrowserWindow | null = null
let tray: AppTray | null = null
let quitting = false
let busy = false // one proxy action at a time
let wasListening: boolean | null = null

const store = new AppStore(join(app.getPath('userData'), 'state.json'))
const clients = new ClientManager([new ClaudeCodeAdapter()], store)
const headroom = (): HeadroomBackend => new HeadroomBackend(store.settings.headroomUrl)
const proxy = new ProxyManager(() => store.settings, {
  unitFile: defaultUnitFile(),
  addonSource: resourcePath('mitmproxy', 'cdp_addon.py'),
  addonTarget: join(app.getPath('userData'), 'cdp_addon.py')
})

const monitor = new StatusMonitor({
  proxyInfo: () => proxy.info(),
  proxy: async (info) => {
    // When the proxy comes or goes, re-check clients now instead of on their timer.
    // Coming up (even when started outside the app) also ends a hold from Stop.
    if (wasListening !== null && wasListening !== info.listening) {
      void (info.listening ? clients.resume() : clients.checkNow())
    }
    wasListening = info.listening
    return proxyStatus(info)
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

async function confirm(message: string, detail: string, ok: string): Promise<boolean> {
  const options = { type: 'question' as const, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1, message, detail }
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

const installLog = (line: string): void => win?.webContents.send(IPC.installLog, line)

/** Runs a proxy action; returns an error message, '' when the user cancelled, or null. */
async function runProxyAction(action: ProxyAction): Promise<string | null> {
  switch (action) {
    case 'install': {
      if (!(await proxy.findUv())) {
        const open = await confirm(
          'uv is needed to install mitmproxy',
          'Install uv, then try again. Open the installation guide?',
          'Open guide'
        )
        if (open) void shell.openExternal('https://docs.astral.sh/uv/getting-started/installation/')
        return 'uv is not installed'
      }
      const ok = await confirm(
        'Install mitmproxy and start the proxy?',
        'Runs "uv tool install mitmproxy", then creates and starts the systemd user service ' +
          `claude-desktop-proxy.service on 127.0.0.1:${store.settings.proxyPort}. ` +
          'Only api.anthropic.com is decrypted; the mitmproxy CA is trusted only by clients you turn on here.',
        'Install'
      )
      if (!ok) return ''
      await proxy.install(installLog)
      installLog('Setting up the service…')
      await proxy.setup()
      installLog('Proxy is running.')
      break
    }
    case 'setup':
      await proxy.setup()
      break
    case 'start':
      await proxy.start()
      break
    case 'restart':
      await proxy.setup() // rewrites the unit too, so a restart also applies changed settings
      break
    case 'stop':
    case 'remove': {
      const enabled = clients.list.filter((c) => c.enabled).map((c) => c.name)
      if (action === 'remove') {
        const ok = await confirm(
          'Remove the proxy service?',
          'Stops and deletes claude-desktop-proxy.service. mitmproxy itself stays installed.' +
            (enabled.length ? ` Proxy settings are removed from ${enabled.join(', ')} first.` : ''),
          'Remove'
        )
        if (!ok) return ''
      }
      // Clients first, so none of them points at a proxy that is gone.
      await clients.suspendAll()
      await (action === 'stop' ? proxy.stop() : proxy.remove())
      break
    }
  }
  // Stop/remove keep clients held; everything else serves again, so restore them.
  await (action === 'stop' || action === 'remove' ? clients.checkNow() : clients.resume())
  return null
}

/**
 * Asks to stop the process that holds the proxy port (typically a mitmdump left
 * from an earlier manual run), then waits for the port to free up.
 */
async function offerToFreePort(err: PortTakenError): Promise<boolean> {
  const ok = await confirm(
    `Port ${err.port} is held by ${err.owner.name} (pid ${err.owner.pid})`,
    'It is not the proxy service, so the service cannot start. Stop that process and continue?',
    'Stop it'
  )
  if (!ok) return false
  try {
    process.kill(err.owner.pid, 'SIGTERM')
  } catch (e) {
    throw new Error(`could not stop pid ${err.owner.pid}: ${(e as Error).message}`)
  }
  for (let i = 0; i < 20 && (await isPortListening(err.port)); i++) await new Promise((r) => setTimeout(r, 250))
  return true
}

async function runWithPortCheck(action: ProxyAction): Promise<string | null> {
  try {
    return await runProxyAction(action)
  } catch (err) {
    if (!(err instanceof PortTakenError)) throw err
    if (!(await offerToFreePort(err))) return err.message
    // An install already got this far; only the service step is left.
    return runProxyAction(action === 'install' ? 'setup' : action)
  }
}

async function proxyAction(action: ProxyAction): Promise<ActionResult> {
  if (busy) return { ok: false, error: 'another proxy action is still running', status: monitor.current }
  busy = true
  try {
    const error = await runWithPortCheck(action)
    const status = await monitor.refresh()
    return error === null || error === '' ? { ok: error === null, status } : { ok: false, error, status }
  } catch (err) {
    return { ok: false, error: (err as Error).message, status: await monitor.refresh() }
  } finally {
    busy = false
  }
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
    ipcMain.handle(IPC.proxyAction, (_e, action: ProxyAction) => proxyAction(action))
    ipcMain.handle(IPC.proxyLogs, () => proxy.logs(80))

    tray = new AppTray({
      show: showWindow,
      toggleWindow,
      refresh: () => void clients.checkNow().then(() => monitor.refresh()),
      setClientEnabled: (id, enabled) => void setClientEnabled(id, enabled),
      proxyAction: (action) =>
        void proxyAction(action).then((r) => {
          if (r.error) dialog.showErrorBox('Claude Desktop Proxy', r.error)
        }),
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

import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IPC,
  type ActionResult,
  type CompressorAction,
  type ProxyAction,
  type UserSettings
} from '@shared/ipc'
import { Autostart } from './autostart'
import { ClaudeCodeAdapter } from './clients/claude-code'
import { CodexAdapter } from './clients/codex'
import { ClientManager } from './clients/manager'
import { HeadroomBackend } from './compressors/headroom'
import { HEADROOM_PACKAGE, HEADROOM_PYTHON, HeadroomService, localEndpoint } from './compressors/headroom-service'
import { headroomArgs, headroomEnv, normalizeHeadroomOptions, validateHeadroomOptions } from './compressors/headroom-options'
import { resourcePath } from './paths'
import { defaultUnitFile, ProxyManager } from './proxy/manager'
import { findUv, PortTakenError } from './proxy/tools'
import { isPortListening } from './proxy-env'
import { normalizeUrl, validateSettings } from './settings'
import { compressorStatus, proxyStatus, StatusMonitor } from './status'
import { AppStore } from './store'
import { AppTray } from './tray'
import { createMainWindow } from './window'

const FAST_POLL_MS = 5_000 // window visible
const SLOW_POLL_MS = 30_000 // window hidden in the tray
const UV_GUIDE = 'https://docs.astral.sh/uv/getting-started/installation/'

let win: BrowserWindow | null = null
let tray: AppTray | null = null
let quitting = false
let busy = false // one service action at a time
let wasListening: boolean | null = null

const store = new AppStore(join(app.getPath('userData'), 'state.json'))
const headroom = (): HeadroomBackend => new HeadroomBackend(store.settings.headroomUrl)
const headroomService = new HeadroomService(() => store.settings, () => headroom().answering())
const proxy = new ProxyManager(() => store.settings, {
  unitFile: defaultUnitFile(),
  addonSource: resourcePath('mitmproxy', 'cdp_addon.py'),
  addonTarget: join(app.getPath('userData'), 'cdp_addon.py')
})
const clients = new ClientManager([new ClaudeCodeAdapter(), new CodexAdapter()], store, undefined, undefined, undefined, (port) =>
  proxy.ownsPort(port)
)
// AppImage: the stable .AppImage path; unpacked: the binary; dev: electron + app dir.
const autostart = new Autostart(() =>
  process.env.APPIMAGE ? [process.env.APPIMAGE] : app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()]
)

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
  compressorInfo: () => headroomService.info(),
  compressor: async (info) => compressorStatus(info, await headroom().health()),
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

/** Null when uv is there; otherwise offers the install guide and returns an error. */
async function requireUv(what: string): Promise<string | null> {
  if (await findUv()) return null
  if (await confirm(`uv is needed to install ${what}`, 'Install uv, then try again. Open the installation guide?', 'Open guide')) {
    void shell.openExternal(UV_GUIDE)
  }
  return 'uv is not installed'
}

/**
 * Asks to stop the process that holds a service port (e.g. a mitmdump or headroom
 * started by hand), then waits for the port to free up.
 */
async function offerToFreePort(err: PortTakenError): Promise<boolean> {
  const ok = await confirm(
    `Port ${err.port} is held by ${err.owner.name} (pid ${err.owner.pid})`,
    `It is not the ${err.service} service, so the service cannot start. Stop that process and continue?`,
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

/** Runs `step`; on a taken port, offers to free it and runs `retry` once. Returns an error, '' if cancelled, or null. */
async function withPortCheck(step: () => Promise<string | null>, retry = step): Promise<string | null> {
  try {
    return await step()
  } catch (err) {
    if (!(err instanceof PortTakenError)) throw err
    if (!(await offerToFreePort(err))) return err.message
    return retry()
  }
}

/** Serialises service actions and turns their outcome into an ActionResult for the UI. */
async function exclusive(fn: () => Promise<string | null>): Promise<ActionResult> {
  if (busy) return { ok: false, error: 'another action is still running', status: monitor.current }
  busy = true
  tray?.setBusy(true)
  try {
    const error = await fn()
    const status = await monitor.refresh()
    return error ? { ok: false, error, status } : { ok: error === null, status }
  } catch (err) {
    return { ok: false, error: (err as Error).message, status: await monitor.refresh() }
  } finally {
    busy = false
    tray?.setBusy(false)
  }
}

/** Returns an error message, '' when the user cancelled, or null. */
async function runProxyAction(action: ProxyAction): Promise<string | null> {
  switch (action) {
    case 'install': {
      const noUv = await requireUv('mitmproxy')
      if (noUv) return noUv
      const ok = await confirm(
        'Install mitmproxy and start the proxy?',
        'Runs "uv tool install mitmproxy", then creates and starts the systemd user service ' +
          `claude-desktop-proxy.service on 127.0.0.1:${store.settings.proxyPort} (and :${store.settings.codexPort} for Codex). ` +
          'Only api.anthropic.com and api.openai.com are decrypted; the mitmproxy CA is trusted only by clients you turn on here.',
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
    case 'restart': // setup rewrites the unit too, so a restart also applies changed settings
      await proxy.setup()
      break
    case 'start':
      await proxy.start()
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

const proxyAction = (action: ProxyAction): Promise<ActionResult> =>
  exclusive(() =>
    withPortCheck(
      () => runProxyAction(action),
      // An install already got this far; only the service step is left.
      () => runProxyAction(action === 'install' ? 'setup' : action)
    )
  )

/** headroom actions. Stopping it needs no client changes: the proxy falls back to the API. */
async function runCompressorAction(action: CompressorAction): Promise<string | null> {
  const { headroomUrl } = store.settings
  const ep = localEndpoint(headroomUrl)
  switch (action) {
    case 'install': {
      const noUv = await requireUv('headroom')
      if (noUv) return noUv
      if (!ep) return `${headroomUrl} is not a local http URL; change it in Settings to run headroom here`
      const ok = await confirm(
        'Install headroom and start it?',
        `Runs "uv tool install --python ${HEADROOM_PYTHON} ${HEADROOM_PACKAGE}" (a few hundred MB), then creates ` +
          `and starts the systemd user service claude-desktop-proxy-headroom.service on ${ep.host}:${ep.port}.`,
        'Install'
      )
      if (!ok) return ''
      await headroomService.install(installLog)
      installLog('Starting headroom (first start can take a minute)…')
      await headroomService.setup()
      installLog('headroom is running.')
      break
    }
    case 'setup':
    case 'restart':
      await headroomService.setup()
      break
    case 'start':
      await headroomService.start()
      break
    case 'stop':
      await headroomService.stop()
      break
    case 'remove': {
      const ok = await confirm(
        'Remove the headroom service?',
        'Stops and deletes claude-desktop-proxy-headroom.service. headroom itself stays installed ' +
          '(uv tool uninstall headroom-ai removes it). The proxy sends requests straight to the API meanwhile.',
        'Remove'
      )
      if (!ok) return ''
      await headroomService.remove()
      break
    }
  }
  return null
}

const compressorAction = (action: CompressorAction): Promise<ActionResult> =>
  exclusive(() =>
    withPortCheck(
      () => runCompressorAction(action),
      () => runCompressorAction(action === 'install' ? 'setup' : action)
    )
  )

async function getSettings(): Promise<UserSettings> {
  const { proxyPort, codexPort, headroomUrl, headroom, autoRepair, checkIntervalSec } = store.settings
  return { proxyPort, codexPort, headroomUrl, headroom, autoRepair, checkIntervalSec, autostart: await autostart.isEnabled() }
}

/**
 * Saves settings and carries them through: services we run move to the new
 * port/URL, then clients are re-pointed at the proxy's new address.
 */
const saveSettings = (input: UserSettings): Promise<ActionResult> =>
  exclusive(async () => {
    const next = { ...input, headroomUrl: normalizeUrl(input.headroomUrl), headroom: normalizeHeadroomOptions(input.headroom) }
    const invalid = validateSettings(next) ?? validateHeadroomOptions(next.headroom)
    if (invalid) return invalid

    const before = { ...store.settings }
    const [proxyInfo, headroomInfo] = await Promise.all([proxy.info(), headroomService.info()])
    await store.update({
      proxyPort: next.proxyPort,
      codexPort: next.codexPort,
      headroomUrl: next.headroomUrl,
      headroom: next.headroom,
      autoRepair: next.autoRepair,
      checkIntervalSec: next.checkIntervalSec
    })
    await autostart.set(next.autostart)

    const urlChanged = before.headroomUrl !== next.headroomUrl
    const unitArgs = (o: typeof next.headroom): string => JSON.stringify([headroomArgs(o), headroomEnv(o)])
    const headroomArgsChanged = urlChanged || unitArgs(before.headroom) !== unitArgs(next.headroom)
    if (headroomArgsChanged && headroomInfo.unit !== 'missing') {
      if (localEndpoint(next.headroomUrl)) {
        const err = await withPortCheck(async () => (await headroomService.setup(), null))
        if (err) return `settings saved, but headroom did not move: ${err}`
      } else {
        await headroomService.stop() // the URL now points elsewhere; our service is not used
      }
    }
    const portsChanged = before.proxyPort !== next.proxyPort || before.codexPort !== next.codexPort
    if ((urlChanged || portsChanged) && proxyInfo.unit !== 'missing') {
      const err = await withPortCheck(async () => (await proxy.setup(), null))
      if (err) return `settings saved, but the proxy did not restart: ${err}`
    }
    if (before.checkIntervalSec !== next.checkIntervalSec) clients.start()
    await clients.resume() // re-points enabled clients at the new proxy address
    return null
  })

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
    ipcMain.handle(IPC.compressorAction, (_e, action: CompressorAction) => compressorAction(action))
    ipcMain.handle(IPC.compressorLogs, () => headroomService.logs(80))
    ipcMain.handle(IPC.requestDetail, (_e, id: string) => headroom().detail(id))
    ipcMain.handle(IPC.getSettings, () => getSettings())
    ipcMain.handle(IPC.saveSettings, (_e, s: UserSettings) => saveSettings(s))

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

import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppUpdates, UPDATE_INTERVAL_MS, installError, notesText, type UpdateBackend } from './updates'

class Backend extends EventEmitter implements UpdateBackend {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checkForUpdates = vi.fn(async () => { this.emit('update-available', { version: '0.3.0', releaseNotes: 'New feature' }) })
  downloadUpdate = vi.fn(async () => { this.emit('download-progress', { percent: 40 }); this.emit('update-downloaded') })
  quitAndInstall = vi.fn()
}
let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'app-updates-')) })
afterEach(async () => { vi.useRealTimers(); await fs.rm(dir, { recursive: true, force: true }) })

describe('app self updates', () => {
  it('downloads in the background but installs only explicitly when no service action is running', async () => {
    const backend = new Backend()
    let busy = true
    const updates = new AppUpdates(backend, '0.2.0', join(dir, 'updates.json'), () => busy)
    await updates.start(); updates.stop()
    expect(backend.autoInstallOnAppQuit).toBe(false)
    expect(backend.allowDowngrade).toBe(false)
    expect(backend.allowPrerelease).toBe(false)
    expect(updates.current).toMatchObject({ phase: 'ready', version: '0.3.0', notes: 'New feature', progress: 100 })
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
    expect(() => updates.install()).toThrow(/Wait/)
    busy = false
    updates.install()
    expect(backend.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('persists the two-hour cadence and preferences over restarts', async () => {
    const backend = new Backend()
    backend.checkForUpdates.mockImplementation(async () => { backend.emit('update-not-available') })
    let now = 1000
    const file = join(dir, 'updates.json')
    const first = new AppUpdates(backend, '0.2.0', file, () => false, () => now)
    await first.start(); first.stop()
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    const second = new AppUpdates(backend, '0.2.0', file, () => false, () => now)
    await second.start(); second.stop()
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    now += UPDATE_INTERVAL_MS - 1
    await second.tick()
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    now++
    await second.tick()
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2)
    await second.preferences({ autoCheck: false, autoDownload: false })
    now += UPDATE_INTERVAL_MS
    await second.tick()
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2)
    const third = new AppUpdates(new Backend(), '0.2.0', file, () => false, () => now)
    await third.start(); third.stop()
    expect(third.current).toMatchObject({ autoCheck: false, autoDownload: false })
  })

  it('supports manual downloads and retains the downloaded update until installation', async () => {
    const backend = new Backend()
    const updates = new AppUpdates(backend, '0.2.0', join(dir, 'updates.json'), () => false)
    await updates.preferences({ autoCheck: false, autoDownload: false })
    await updates.check()
    expect(updates.current.phase).toBe('available')
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
    await updates.download()
    await updates.check()
    expect(updates.current.phase).toBe('ready')
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('catches download/network failures and never installs a failed download', async () => {
    const backend = new Backend()
    backend.downloadUpdate.mockRejectedValue(new Error('Checksum mismatch'))
    const updates = new AppUpdates(backend, '0.2.0', join(dir, 'updates.json'), () => false)
    await updates.check()
    expect(updates.current).toMatchObject({ phase: 'error', error: 'Checksum mismatch' })
    expect(() => updates.install()).toThrow(/Download/)
    backend.checkForUpdates.mockRejectedValue(new Error('Offline'))
    await updates.check()
    expect(updates.current.error).toBe('Offline')
  })

  it('disables updates for development builds and ignores extra preference fields', async () => {
    const updates = new AppUpdates(null, '0.2.0', join(dir, 'updates.json'), () => false)
    await updates.start(); await updates.check()
    await updates.preferences({ autoCheck: true, autoDownload: false, phase: 'ready' } as never)
    expect(updates.current.phase).toBe('disabled')
    expect(() => updates.install()).toThrow(/Download/)
    updates.stop()
  })

  it('does not overlap checks or downloads', async () => {
    const backend = new Backend()
    let finish!: () => void
    backend.checkForUpdates.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const updates = new AppUpdates(backend, '0.2.0', join(dir, 'updates.json'), () => false)
    const pending = updates.check()
    await vi.waitFor(() => expect(backend.checkForUpdates).toHaveBeenCalledOnce())
    await updates.check(); await updates.download()
    expect(backend.checkForUpdates).toHaveBeenCalledOnce()
    finish(); await pending
  })

  it('shows GitHub release notes as text', () => {
    const html = '<p>Changes since 0.2.3.</p>\n<ul>\n<li>Docs &amp; split (<a class="issue-link" href="https://github.com/x/y/pull/7">#7</a>) (<a href="#"><tt>4603e5b</tt></a>)</li>\n</ul>'
    expect(notesText(html)).toBe('Changes since 0.2.3.\n• Docs & split (#7) (4603e5b)')
    expect(notesText('- plain markdown\n- stays')).toBe('- plain markdown\n- stays')
  })

  it('keeps a downloaded update installable after the installer fails', async () => {
    const backend = new Backend()
    Object.assign(backend, { installerPath: '/cache/app_0.3.0_amd64.deb' })
    backend.quitAndInstall.mockImplementation(() => { backend.emit('error', new Error('Command pkexec exited with code 127')) })
    const updates = new AppUpdates(backend, '0.2.0', join(dir, 'updates.json'), () => false)
    await updates.start(); updates.stop()
    updates.install()
    expect(updates.current.phase).toBe('ready')
    expect(updates.current.error).toMatch(/authentication was cancelled or failed.*sudo apt install \/cache\/app_0.3.0_amd64.deb/)
    expect(installError('disk full')).toBe('The update was not installed: disk full.')
  })
})

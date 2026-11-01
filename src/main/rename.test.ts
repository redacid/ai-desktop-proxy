import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupOnce } from './fsutil'
import { LEGACY_BACKUP_SUFFIX, migrateUserData } from './rename'
import { stripOurs, keyLine } from './clients/codex'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cdp-rename-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('rename from claude-desktop-proxy', () => {
  it('copies settings, moves the app RTK and re-points only our symlink', async () => {
    const oldDir = join(dir, 'claude-desktop-proxy'), newDir = join(dir, 'ai-desktop-proxy'), home = join(dir, 'home')
    await fs.mkdir(join(oldDir, 'tools'), { recursive: true })
    await fs.mkdir(join(home, '.local', 'bin'), { recursive: true })
    await fs.writeFile(join(oldDir, 'state.json'), '{"proxyPort":9000}')
    await fs.writeFile(join(oldDir, 'tools', 'rtk'), 'bin')
    await fs.symlink(join(oldDir, 'tools', 'rtk'), join(home, '.local', 'bin', 'rtk'))

    expect(await migrateUserData(oldDir, newDir, home)).toEqual(['state.json', 'tools/rtk', '~/.local/bin/rtk'])
    expect(await fs.readFile(join(newDir, 'state.json'), 'utf8')).toBe('{"proxyPort":9000}')
    expect(await fs.readlink(join(home, '.local', 'bin', 'rtk'))).toBe(join(newDir, 'tools', 'rtk'))
    expect(await fs.readFile(join(home, '.local', 'bin', 'rtk'), 'utf8')).toBe('bin')
    // Second start: the new state wins, nothing is copied again.
    expect(await migrateUserData(oldDir, newDir, home)).toEqual([])
  })

  it('leaves a foreign ~/.local/bin/rtk alone', async () => {
    const oldDir = join(dir, 'old'), newDir = join(dir, 'new'), home = join(dir, 'home')
    await fs.mkdir(join(oldDir, 'tools'), { recursive: true })
    await fs.mkdir(join(home, '.local', 'bin'), { recursive: true })
    await fs.writeFile(join(oldDir, 'tools', 'rtk'), 'bin')
    await fs.writeFile(join(home, '.local', 'bin', 'rtk'), 'someone else')
    await migrateUserData(oldDir, newDir, home)
    expect(await fs.readFile(join(home, '.local', 'bin', 'rtk'), 'utf8')).toBe('someone else')
  })

  it('keeps the pre-app backup made under the old name', async () => {
    const file = join(dir, 'settings.json')
    await fs.writeFile(file, 'now')
    await fs.writeFile(file + LEGACY_BACKUP_SUFFIX, 'original')
    await backupOnce(file, file + '.bak-ai-desktop-proxy', file + LEGACY_BACKUP_SUFFIX)
    await expect(fs.access(file + '.bak-ai-desktop-proxy')).rejects.toThrow()
  })

  it('removes a Codex line written with the old marker', () => {
    const url = 'http://127.0.0.1:8878/v1'
    const text = `# Added by Claude Desktop Proxy; turn Codex off in the app to remove it.\n${keyLine(url)}\nmodel = "x"\n`
    expect(stripOurs(text, url)).toBe('model = "x"\n')
  })
})

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { exists } from './fsutil'

/**
 * The app was called claude-desktop-proxy before. These names are only read, to carry an
 * existing installation over: its settings, the RTK binary, systemd units and backups.
 */
export const LEGACY_SLUG = 'claude-desktop-proxy'
export const LEGACY_PROXY_UNIT = `${LEGACY_SLUG}.service`
export const LEGACY_HEADROOM_UNIT = `${LEGACY_SLUG}-headroom.service`
export const LEGACY_BACKUP_SUFFIX = `.bak-${LEGACY_SLUG}`
export const LEGACY_AUTOSTART = `${LEGACY_SLUG}.desktop`

/**
 * Copies the old userData into the new one on the first start under the new name: settings and
 * the update cache are copied, the app-managed RTK moves and ~/.local/bin/rtk follows it. The old
 * directory stays, because a not yet migrated proxy unit still loads its addon from there.
 * Returns what was carried over, for the log.
 */
export async function migrateUserData(oldDir: string, newDir: string, home: string): Promise<string[]> {
  if (!(await exists(oldDir)) || (await exists(join(newDir, 'state.json')))) return []
  const done: string[] = []
  await fs.mkdir(newDir, { recursive: true })
  for (const file of ['state.json', 'tool-updates.json']) {
    if (await exists(join(oldDir, file))) {
      await fs.copyFile(join(oldDir, file), join(newDir, file))
      done.push(file)
    }
  }
  const oldRtk = join(oldDir, 'tools', 'rtk')
  const newRtk = join(newDir, 'tools', 'rtk')
  if ((await exists(oldRtk)) && !(await exists(newRtk))) {
    await fs.mkdir(join(newDir, 'tools'), { recursive: true, mode: 0o700 })
    await fs.rename(oldRtk, newRtk)
    done.push('tools/rtk')
    const link = join(home, '.local', 'bin', 'rtk')
    // Only our own symlink is re-pointed; anything else at that path is someone else's.
    if ((await fs.readlink(link).catch(() => null)) === oldRtk) {
      const tmp = `${link}.${process.pid}.tmp`
      await fs.symlink(newRtk, tmp)
      await fs.rename(tmp, link)
      done.push('~/.local/bin/rtk')
    }
  }
  return done
}

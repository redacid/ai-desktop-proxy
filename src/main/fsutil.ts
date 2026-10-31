import { constants, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Follows symlinks so that writes land in the real file (e.g. a dotfiles repo). */
export async function resolveTarget(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    return path // does not exist yet
  }
}

/**
 * Writes JSON atomically: a uniquely named temp file next to the real target,
 * with the target's permissions, then rename. Symlinks are kept, Unicode is
 * written as-is, and the file ends with a newline.
 */
export async function writeJsonAtomic(path: string, data: unknown, fallbackMode = 0o600): Promise<void> {
  const target = await resolveTarget(path)
  let mode = fallbackMode
  try {
    mode = (await fs.stat(target)).mode & 0o7777
  } catch {
    await fs.mkdir(dirname(target), { recursive: true })
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode })
    await fs.chmod(tmp, mode) // writeFile's mode is filtered by umask
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/** Copies `path` to `backup` once; later calls keep the first (pre-app) copy. */
export async function backupOnce(path: string, backup: string): Promise<void> {
  if (!(await exists(path)) || (await exists(backup))) return
  await fs.copyFile(await resolveTarget(path), backup)
  await fs.chmod(backup, (await fs.stat(await resolveTarget(path))).mode & 0o7777)
}

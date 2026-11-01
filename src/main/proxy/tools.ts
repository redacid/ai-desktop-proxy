import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { exists } from '../fsutil'
import type { Runner } from './exec'

export type PortOwner = { pid: number; name: string }

export async function which(name: string, extraDirs: string[] = []): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extraDirs].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

const userBinDirs = (): string[] => [join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin')]

export function findUv(): Promise<string | null> {
  return which('uv', userBinDirs())
}

/** An executable installed with `uv tool install`, wherever uv puts its bin dir. */
export async function findUvTool(name: string, runner: Runner): Promise<string | null> {
  const dirs = userBinDirs()
  const uv = await findUv()
  if (uv) {
    // uv's tool bin dir can be moved with UV_TOOL_BIN_DIR / XDG_BIN_HOME.
    const r = await runner(uv, ['tool', 'dir', '--bin'])
    const dir = r.code === 0 ? r.stdout.trim().split('\n').pop() : undefined
    if (dir) dirs.unshift(dir)
  }
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (await exists(candidate)) return candidate
  }
  return which(name)
}

/** Parses `ss -Hltnp` output: the first process listening, e.g. users:(("mitmdump",pid=42,fd=7)). */
export function parseSsOwner(output: string): PortOwner | null {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(output)
  return m ? { name: m[1], pid: Number(m[2]) } : null
}

/** Who listens on a TCP port (same-user processes only; ss cannot see others'). */
export async function portOwner(port: number, runner: Runner): Promise<PortOwner | null> {
  const r = await runner('ss', ['-Hltnp', 'sport', '=', `:${port}`])
  return r.code === 0 ? parseSsOwner(r.stdout) : null
}

export function userUnitFile(unit: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'systemd', 'user', unit)
}

/** Thrown instead of starting a service that would crash-loop on a taken port. */
export class PortTakenError extends Error {
  constructor(
    readonly port: number,
    readonly owner: PortOwner,
    readonly service: string
  ) {
    super(`port ${port} is held by ${owner.name} (pid ${owner.pid}), not by the ${service} service; stop it first`)
  }
}

import { execFile, spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>

/** Runs a command without a shell; never throws on a non-zero exit. */
export const run: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === 127 ? err.message : '')) })
    })
  })

/** Runs a long command and reports each output line (used for installs). */
export function runStreaming(cmd: string, args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const feed = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLine(line)
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (err) => {
      onLine(`error: ${err.message}`)
      resolve(127)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

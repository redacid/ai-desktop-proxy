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
    // Chunks can end mid-line; keep the tail of each stream until its newline arrives.
    const feeder = (): { feed: (chunk: Buffer) => void; flush: () => void } => {
      let rest = ''
      return {
        feed: (chunk) => {
          const lines = (rest + chunk.toString()).split(/\r?\n/)
          rest = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) onLine(line)
        },
        flush: () => {
          if (rest.trim()) onLine(rest)
          rest = ''
        }
      }
    }
    const out = feeder()
    const err = feeder()
    child.stdout.on('data', out.feed)
    child.stderr.on('data', err.feed)
    child.on('error', (err) => {
      onLine(`error: ${err.message}`)
      resolve(127)
    })
    child.on('close', (code) => {
      out.flush()
      err.flush()
      resolve(code ?? 1)
    })
  })
}

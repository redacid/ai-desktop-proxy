import { HEADROOM_COMPRESSORS, type HeadroomOptions } from '@shared/ipc'

/** headroom's own defaults: with these, no option flag is passed. */
export const DEFAULT_HEADROOM_OPTIONS: HeadroomOptions = {
  optimize: true,
  mode: 'cache',
  targetRatio: null,
  ccr: 'retrieve',
  protectToolResults: '',
  compressors: [],
  codeAware: false,
  kompress: true,
  semanticCache: true,
  rateLimit: true,
  rpm: null,
  tpm: null,
  budgetUsd: null,
  budgetPeriod: 'daily',
  http2: true,
  beacon: true,
  logMessages: false,
  extraArgs: ''
}

/** Fills missing or mistyped fields from the defaults (older state.json, hand edits). */
export function normalizeHeadroomOptions(raw: unknown): HeadroomOptions {
  const out: HeadroomOptions = { ...DEFAULT_HEADROOM_OPTIONS }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof HeadroomOptions)[]) {
    const def = DEFAULT_HEADROOM_OPTIONS[key]
    const v = r[key]
    if (v === undefined) continue
    if (def === null ? v === null || typeof v === 'number' : Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def) {
      ;(out as unknown as Record<string, unknown>)[key] = v
    }
  }
  out.compressors = out.compressors.filter((c): c is string => typeof c === 'string')
  return out
}

/**
 * Splits a string into arguments the way a POSIX shell would for quotes and backslashes,
 * without expansion of any kind. Throws on an unclosed quote.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i]
      else cur += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) args.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
    }
  }
  if (quote) throw new Error('unclosed quote')
  if (has || cur) args.push(cur)
  return args
}

// Set by the app from the headroom URL; extra arguments may not move or rebind headroom.
const RESERVED = ['--host', '--port', '-p', '--uds', '--workers']

/** Checks options from the settings form; returns an error message or null. */
export function validateHeadroomOptions(o: HeadroomOptions): string | null {
  if (!['cache', 'token'].includes(o.mode)) return 'headroom mode must be cache or token'
  if (!['retrieve', 'lossless', 'off'].includes(o.ccr)) return 'unknown headroom retrieval setting'
  if (!['hourly', 'daily', 'monthly'].includes(o.budgetPeriod)) return 'budget period must be hourly, daily or monthly'
  if (o.targetRatio !== null && !(o.targetRatio >= 0.05 && o.targetRatio <= 0.95)) {
    return 'target ratio must be from 0.05 to 0.95, or empty'
  }
  for (const [name, v] of [['requests per minute', o.rpm], ['tokens per minute', o.tpm]] as const) {
    if (v !== null && (!Number.isInteger(v) || v < 1)) return `${name} must be a whole number of at least 1, or empty`
  }
  if (o.budgetUsd !== null && !(o.budgetUsd > 0)) return 'budget must be more than 0, or empty'
  const unknown = o.compressors.filter((c) => !(HEADROOM_COMPRESSORS as readonly string[]).includes(c))
  if (unknown.length) return `unknown headroom compressors: ${unknown.join(', ')}`
  if (/[^\w,\s.-]/.test(o.protectToolResults)) return 'protected tools: tool names separated by commas'
  let extra: string[]
  try {
    extra = splitArgs(o.extraArgs)
  } catch {
    return 'extra arguments: unclosed quote'
  }
  const reserved = extra.find((a) => RESERVED.includes(a.split('=')[0]))
  if (reserved) return `extra arguments: ${reserved} is set by the app from the headroom URL`
  return null
}

/** `headroom proxy` flags for the options; defaults add nothing. */
export function headroomArgs(o: HeadroomOptions): string[] {
  const args: string[] = []
  if (!o.optimize) args.push('--no-optimize')
  if (o.mode !== 'cache') args.push('--mode', o.mode)
  if (o.targetRatio !== null) args.push('--target-ratio', String(o.targetRatio))
  if (o.ccr === 'lossless') args.push('--lossless')
  if (o.ccr === 'off') args.push('--no-ccr')
  const tools = o.protectToolResults.split(',').map((t) => t.trim()).filter(Boolean)
  if (tools.length) args.push('--protect-tool-results', tools.join(','))
  // An empty selection means "all" here; '*' is headroom's spelling for that, so just omit the flag.
  if (o.compressors.length && o.compressors.length < HEADROOM_COMPRESSORS.length) {
    args.push('--compressor', o.compressors.join(','))
  }
  if (o.codeAware) args.push('--code-aware')
  if (!o.kompress) args.push('--disable-kompress')
  if (!o.semanticCache) args.push('--no-cache')
  if (!o.rateLimit) args.push('--no-rate-limit')
  else {
    if (o.rpm !== null) args.push('--rpm', String(o.rpm))
    if (o.tpm !== null) args.push('--tpm', String(o.tpm))
  }
  if (o.budgetUsd !== null) args.push('--budget', String(o.budgetUsd), '--budget-period', o.budgetPeriod)
  if (!o.http2) args.push('--no-http2')
  // Keeps request/response bodies in memory (loopback-only feed) so the app can show them.
  if (o.logMessages) args.push('--log-messages')
  args.push(...splitArgs(o.extraArgs))
  return args
}

/** Environment for the headroom service; defaults add nothing. */
export function headroomEnv(o: HeadroomOptions): Record<string, string> {
  // HEADROOM_BEACON=off stops only the upload; --no-telemetry would also stop the local stats the app shows.
  return o.beacon ? {} : { HEADROOM_BEACON: 'off' }
}

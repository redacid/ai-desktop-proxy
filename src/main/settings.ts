import type { UserSettings } from '@shared/ipc'

/** Checks user input from the settings form; returns an error message or null. */
export function validateSettings(s: UserSettings): string | null {
  if (!Number.isInteger(s.proxyPort) || s.proxyPort < 1024 || s.proxyPort > 65535) {
    return 'proxy port must be a whole number from 1024 to 65535'
  }
  if (!Number.isInteger(s.codexPort) || s.codexPort < 1024 || s.codexPort > 65535) {
    return 'Codex port must be a whole number from 1024 to 65535'
  }
  if (s.codexPort === s.proxyPort) return 'the proxy and Codex ports must differ'
  let url: URL
  try {
    url = new URL(s.headroomUrl)
  } catch {
    return 'headroom URL is not a valid URL'
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'headroom URL must start with http:// or https://'
  if (url.pathname !== '/' || url.search || url.hash) return 'headroom URL must be a base URL without a path'
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname)
  if (local && [s.proxyPort, s.codexPort].includes(Number(url.port || 80))) {
    return 'headroom and the proxy cannot use the same port'
  }
  if (!Number.isInteger(s.checkIntervalSec) || s.checkIntervalSec < 10 || s.checkIntervalSec > 3600) {
    return 'check interval must be from 10 to 3600 seconds'
  }
  return null
}

/** headroom URL without a trailing slash, as the addon and the stats client expect. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

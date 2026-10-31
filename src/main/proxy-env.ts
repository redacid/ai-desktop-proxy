import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The environment a client needs to send its API traffic through our mitmproxy. */
export interface ProxyEnv {
  proxyUrl: string // HTTPS_PROXY
  caFile: string // NODE_EXTRA_CA_CERTS
  noProxyHosts: string[] // merged into NO_PROXY
  /** Base URL for clients that cannot use an HTTPS proxy (Codex's openai_base_url). */
  openaiBaseUrl: string
  codexPort: number
}

export const DEFAULT_PORT = 8877
export const DEFAULT_CODEX_PORT = 8878
export const DEFAULT_CA_FILE = join(homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem')
// Local services (headroom, the console claude pointed at it) must bypass the proxy.
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

export function buildProxyEnv(port: number, caFile = DEFAULT_CA_FILE, codexPort = DEFAULT_CODEX_PORT): ProxyEnv {
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    caFile,
    noProxyHosts: [...LOCAL_HOSTS],
    openaiBaseUrl: `http://127.0.0.1:${codexPort}/v1`,
    codexPort
  }
}

export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

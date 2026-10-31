import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../store'
import { ClaudeCodeAdapter } from './claude-code'
import { CodexAdapter } from './codex'
import { ClientManager } from './manager'

let dir: string
let settings: string
let store: AppStore
let proxyUp: boolean

function manager(): ClientManager {
  return new ClientManager([new ClaudeCodeAdapter(settings)], store, async () => proxyUp, async () => true, 0)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cdp-'))
  settings = join(dir, 'settings.json')
  await fs.writeFile(settings, '{}')
  store = new AppStore(join(dir, 'state.json'))
  await store.load()
  store.settings.caFile = '/ca.pem'
  proxyUp = true
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const env = async (): Promise<Record<string, string> | undefined> => JSON.parse(await fs.readFile(settings, 'utf8')).env

describe('ClientManager', () => {
  it('refuses to enable while the proxy is down', async () => {
    proxyUp = false
    const m = manager()
    expect(await m.setEnabled('claude-code', true)).toMatch(/not listening/)
    expect(await env()).toBeUndefined()
    expect(store.client('claude-code').enabled).toBe(false)
  })

  it('enables, persists the record, and disables', async () => {
    const m = manager()
    expect(await m.setEnabled('claude-code', true)).toBeNull()
    expect(m.list[0]).toMatchObject({ enabled: true, state: 'applied' })
    expect(store.client('claude-code').applied?.proxyUrl).toBe('http://127.0.0.1:8877')

    const reloaded = new AppStore(join(dir, 'state.json'))
    await reloaded.load()
    expect(reloaded.client('claude-code').enabled).toBe(true)

    expect(await m.setEnabled('claude-code', false)).toBeNull()
    expect(await env()).toBeUndefined()
    expect(m.list[0]).toMatchObject({ enabled: false, state: 'absent' })
  })

  it('restores settings someone removed, but only while the proxy is up', async () => {
    const m = manager()
    await m.setEnabled('claude-code', true)
    await fs.writeFile(settings, '{"env":{}}')

    proxyUp = false
    await m.checkNow()
    expect(m.list[0].state).toBe('absent')
    expect(m.list[0].detail).toMatch(/waiting for the proxy/)

    proxyUp = true
    await m.checkNow()
    expect(m.list[0].state).toBe('applied')
    expect(m.list[0].detail).toMatch(/^restored/)
  })

  it('pulls settings while the proxy is down and restores them when it is back', async () => {
    const m = manager()
    await m.setEnabled('claude-code', true)
    proxyUp = false
    await m.checkNow()
    expect(await env()).toBeUndefined()
    expect(m.list[0]).toMatchObject({ enabled: true, state: 'absent' })
    expect(m.list[0].detail).toMatch(/settings removed until it is back/)

    proxyUp = true
    await m.checkNow()
    expect(m.list[0]).toMatchObject({ enabled: true, state: 'applied' })
  })

  it('suspendAll removes settings, keeps clients enabled, and restores only on resume', async () => {
    const m = manager()
    await m.setEnabled('claude-code', true)
    await m.suspendAll() // proxy still up, as right before a stop
    expect(await env()).toBeUndefined()
    expect(store.client('claude-code')).toEqual({ enabled: true, applied: null })
    await m.checkNow()
    expect(await env()).toBeUndefined()
    expect(m.list[0].detail).toMatch(/stopped from the app/)

    await m.resume()
    expect(m.list[0].state).toBe('applied')
  })

  it('moves an enabled client to a new port without calling it a conflict', async () => {
    const m = manager()
    await m.setEnabled('claude-code', true)
    store.settings.proxyPort = 9999
    await m.checkNow()
    expect(m.list[0].state).toBe('applied')
    expect((await env())?.HTTPS_PROXY).toBe('http://127.0.0.1:9999')
  })

  it('reports a foreign value instead of overwriting it', async () => {
    const m = manager()
    await m.setEnabled('claude-code', true)
    await fs.writeFile(settings, '{"env":{"HTTPS_PROXY":"http://corp:3128"}}')
    await m.checkNow()
    expect(m.list[0].state).toBe('conflict')
    expect((await env())?.HTTPS_PROXY).toBe('http://corp:3128')
  })

  describe('Codex (plaintext port)', () => {
    let codexConfig: string
    let ours: boolean
    let ownedPorts: number[] | null // null = every port is ours unless `ours` is false
    // A long confirmation: pulling Codex from a foreign port must not wait for it.
    const codexManager = (): ClientManager =>
      new ClientManager([new CodexAdapter(codexConfig)], store, async () => proxyUp, async () => true, 60_000, async (port) =>
        ownedPorts ? ownedPorts.includes(port) : ours
      )
    const config = (): Promise<string> => fs.readFile(codexConfig, 'utf8')

    beforeEach(async () => {
      codexConfig = join(dir, 'config.toml')
      await fs.writeFile(codexConfig, 'model = "x"\n')
      ours = true
      ownedPorts = null
    })

    it('refuses to enable while our service does not hold the port', async () => {
      ours = false
      expect(await codexManager().setEnabled('codex', true)).toMatch(/not held by our proxy service/)
      expect(await config()).toBe('model = "x"\n')
    })

    it('pulls the base URL when someone else takes the port, and restores it once ours again', async () => {
      const m = codexManager()
      expect(await m.setEnabled('codex', true)).toBeNull()
      expect(await config()).toContain('openai_base_url')

      ours = false
      await m.checkNow()
      expect(await config()).toBe('model = "x"\n')
      expect(store.client('codex').enabled).toBe(true)

      ours = true
      await m.checkNow()
      expect(await config()).toContain('openai_base_url')
    })

    it('pulls a stale port of ours that someone else now holds, even with auto-restore off', async () => {
      const m = codexManager()
      expect(await m.setEnabled('codex', true)).toBeNull()
      store.settings.autoRepair = false
      store.settings.codexPort = 9999 // the config still says 8878
      ownedPorts = [9999]
      await m.checkNow()
      expect(await config()).toBe('model = "x"\n')
    })
  })
})

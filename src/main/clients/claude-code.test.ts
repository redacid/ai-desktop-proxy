import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProxyEnv } from '../proxy-env'
import { BACKUP_SUFFIX, ClaudeCodeAdapter } from './claude-code'
import { ClientConflictError } from './types'

let dir: string
let path: string
let adapter: ClaudeCodeAdapter
const env = buildProxyEnv(8877, '/ca.pem')

const write = (data: unknown): Promise<void> => fs.writeFile(path, JSON.stringify(data))
const read = async (): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(path, 'utf8'))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cdp-'))
  path = join(dir, 'settings.json')
  adapter = new ClaudeCodeAdapter(path)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('ClaudeCodeAdapter', () => {
  it('applies, is idempotent, and removes back to the original', async () => {
    const original = { model: 'haiku', env: { KEEP: '1' } }
    await write(original)
    expect((await adapter.inspect(env)).state).toBe('absent')

    const record = await adapter.apply(env, null)
    const applied = await read()
    expect(applied.env).toEqual({ KEEP: '1', HTTPS_PROXY: 'http://127.0.0.1:8877', NODE_EXTRA_CA_CERTS: '/ca.pem', NO_PROXY: '127.0.0.1,localhost' })
    expect((await adapter.inspect(env)).state).toBe('applied')
    expect(JSON.parse(await fs.readFile(path + BACKUP_SUFFIX, 'utf8'))).toEqual(original)

    await adapter.apply(env, record)
    expect(await read()).toEqual(applied)

    await adapter.remove(record, env)
    expect(await read()).toEqual(original)
  })

  it('drops the env block it created and leaves no empty one', async () => {
    await write({ model: 'haiku' })
    const record = await adapter.apply(env, null)
    await adapter.remove(record, env)
    expect(await read()).toEqual({ model: 'haiku' })
  })

  it('does not create a file on remove', async () => {
    await adapter.remove(null, env)
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('does not rewrite the file when nothing changes', async () => {
    await fs.writeFile(path, '{"env":{"A":"1"}}') // compact formatting would change on any write
    await adapter.remove(null, env)
    expect(await fs.readFile(path, 'utf8')).toBe('{"env":{"A":"1"}}')
  })

  it('merges into an existing NO_PROXY and removes only the hosts it added', async () => {
    await write({ env: { NO_PROXY: 'corp.example,localhost' } })
    const record = await adapter.apply(env, null)
    expect(record.noProxyAdded).toEqual(['127.0.0.1'])
    expect((await read()).env).toMatchObject({ NO_PROXY: 'corp.example,localhost,127.0.0.1' })
    await adapter.remove(record, env)
    expect(await read()).toEqual({ env: { NO_PROXY: 'corp.example,localhost' } })
  })

  it('refuses to overwrite a foreign HTTPS_PROXY and reports a conflict', async () => {
    await write({ env: { HTTPS_PROXY: 'http://corp:3128' } })
    await expect(adapter.apply(env, null)).rejects.toBeInstanceOf(ClientConflictError)
    expect((await adapter.inspect(env)).state).toBe('conflict')
    await adapter.remove(null, env)
    expect(await read()).toEqual({ env: { HTTPS_PROXY: 'http://corp:3128' } })
  })

  it('moves to a new port using the record, and removes after a port change', async () => {
    await write({})
    const old = await adapter.apply(env, null)
    const moved = buildProxyEnv(9999, '/ca.pem')
    expect((await adapter.inspect(moved)).state).toBe('conflict') // without a record it is foreign
    const record = await adapter.apply(moved, old)
    expect((await read()).env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:9999' })
    await adapter.remove(record, env) // env is stale; the record knows what we wrote
    expect(await read()).toEqual({})
  })

  it('reports partial when one variable was removed by hand', async () => {
    await write({ env: { HTTPS_PROXY: env.proxyUrl, NO_PROXY: '127.0.0.1,localhost' } })
    const result = await adapter.inspect(env)
    expect(result.state).toBe('partial')
    expect(result.detail).toContain('NODE_EXTRA_CA_CERTS')
  })

  it('cleans up what the shell version wrote when there is no record', async () => {
    await write({ env: { HTTPS_PROXY: env.proxyUrl, NODE_EXTRA_CA_CERTS: '/ca.pem', NO_PROXY: '127.0.0.1,localhost', X: '1' } })
    await adapter.remove(null, env)
    expect(await read()).toEqual({ env: { X: '1' } })
  })

  it('keeps file mode, symlinks and Unicode', async () => {
    const real = join(dir, 'real.json')
    await fs.writeFile(real, '{"model":"Привіт"}')
    await fs.chmod(real, 0o600)
    await fs.symlink(real, path)

    const record = await adapter.apply(env, null)
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
    expect((await fs.stat(real)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(real, 'utf8')).toContain('"Привіт"')

    await adapter.remove(record, env)
    expect(JSON.parse(await fs.readFile(real, 'utf8'))).toEqual({ model: 'Привіт' })
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('never overwrites broken JSON', async () => {
    await fs.writeFile(path, '{broken')
    expect((await adapter.inspect(env)).state).toBe('error')
    await expect(adapter.apply(env, null)).rejects.toThrow()
    await expect(adapter.remove(null, env)).rejects.toThrow()
    expect(await fs.readFile(path, 'utf8')).toBe('{broken')
  })

  it('says missing when the Claude directory does not exist', async () => {
    const gone = new ClaudeCodeAdapter(join(dir, 'nope', 'settings.json'))
    expect((await gone.inspect(env)).state).toBe('missing')
  })
})

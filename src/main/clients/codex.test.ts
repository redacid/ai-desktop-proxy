import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProxyEnv } from '../proxy-env'
import { BACKUP_SUFFIX, CodexAdapter, keyLine } from './codex'
import { ClientConflictError } from './types'

let dir: string
let path: string
let adapter: CodexAdapter
const env = buildProxyEnv(8877, '/ca.pem', 8878)
const URL = 'http://127.0.0.1:8878/v1'

const ORIGINAL = `# my codex config
model = "gpt-5" # a comment

[desktop]
localeOverride = "uk-UA"

[profiles.work]
openai_base_url = "https://example.com/v1"
`

const write = (text: string): Promise<void> => fs.writeFile(path, text)
const read = (): Promise<string> => fs.readFile(path, 'utf8')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cdp-codex-'))
  path = join(dir, 'config.toml')
  adapter = new CodexAdapter(path)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('CodexAdapter', () => {
  it('applies, is idempotent, and removes back to the original bytes', async () => {
    await write(ORIGINAL)
    expect((await adapter.inspect(env)).state).toBe('absent')

    const record = await adapter.apply(env, null)
    expect(record.proxyUrl).toBe(URL)
    const applied = await read()
    expect(applied.endsWith(ORIGINAL)).toBe(true)
    expect(applied).toContain(keyLine(URL))
    expect((await adapter.inspect(env, record)).state).toBe('applied')
    expect(await fs.readFile(path + BACKUP_SUFFIX, 'utf8')).toBe(ORIGINAL)

    await adapter.apply(env, record)
    expect(await read()).toBe(applied)

    await adapter.remove(record, env)
    expect(await read()).toBe(ORIGINAL)
    expect((await adapter.inspect(env)).state).toBe('absent')
  })

  it('creates the file when only the directory exists, and reports a missing Codex', async () => {
    expect((await adapter.inspect(env)).state).toBe('absent')
    await adapter.apply(env, null)
    expect((await adapter.inspect(env)).state).toBe('applied')

    const gone = new CodexAdapter(join(dir, 'nope', 'config.toml'))
    expect((await gone.inspect(env)).state).toBe('missing')
  })

  it('moves an old port of ours and never touches a foreign value', async () => {
    await write(ORIGINAL)
    const old = await adapter.apply(buildProxyEnv(8877, '/ca.pem', 9000), null)
    expect((await adapter.inspect(env, old)).state).toBe('partial')
    const record = await adapter.apply(env, old)
    expect((await adapter.inspect(env, record)).state).toBe('applied')
    expect((await read()).match(/^openai_base_url = "http:\/\/127/gm)).toHaveLength(1)

    const foreign = 'openai_base_url = "https://my.gateway/v1"\n' + ORIGINAL
    await write(foreign)
    expect((await adapter.inspect(env, record)).state).toBe('conflict')
    await expect(adapter.apply(env, record)).rejects.toBeInstanceOf(ClientConflictError)
    await adapter.remove(record, env)
    expect(await read()).toBe(foreign)
  })

  it('refuses a custom model provider', async () => {
    await write('model_provider = "ollama"\n' + ORIGINAL)
    expect((await adapter.inspect(env)).state).toBe('absent')
    expect((await adapter.inspect(env)).detail).toMatch(/model_provider/)
    await expect(adapter.apply(env, null)).rejects.toBeInstanceOf(ClientConflictError)
  })

  it('reports and never rewrites a broken file', async () => {
    await write('model = \n[[')
    expect((await adapter.inspect(env)).state).toBe('error')
    await expect(adapter.apply(env, null)).rejects.toThrow()
    await expect(adapter.remove(null, env)).rejects.toThrow()
    expect(await read()).toBe('model = \n[[')
  })

  it('leaves a hand-edited key of ours for the user instead of guessing', async () => {
    await write(`openai_base_url   =   "${URL}"\n` + ORIGINAL)
    await expect(adapter.remove({ proxyUrl: URL, caFile: '', noProxyAdded: [] }, env)).rejects.toThrow(/by hand/)
  })

  it('keeps a symlinked config a symlink', async () => {
    const real = join(dir, 'real.toml')
    await fs.writeFile(real, ORIGINAL)
    await fs.rm(path, { force: true })
    await fs.symlink(real, path)
    const record = await adapter.apply(env, null)
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
    await adapter.remove(record, env)
    expect(await fs.readFile(real, 'utf8')).toBe(ORIGINAL)
  })
})

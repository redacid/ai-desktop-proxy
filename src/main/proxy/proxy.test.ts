import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../store'
import type { RunResult } from './exec'
import { mitmdumpArgs, ProxyManager } from './manager'
import { quoteArg, renderUnit } from './systemd'

describe('quoteArg', () => {
  it('escapes what systemd would expand', () => {
    expect(quoteArg('^api[.]anthropic[.]com:443$')).toBe('"^api[.]anthropic[.]com:443$$"')
    expect(quoteArg('/home/my user/x')).toBe('"/home/my user/x"')
    expect(quoteArg('a"b\\c%d')).toBe('"a\\"b\\\\c%%d"')
  })
})

describe('renderUnit', () => {
  it('quotes every ExecStart argument', () => {
    const unit = renderUnit({ description: 'x', exec: '/bin/mitmdump', args: ['--allow-hosts', '^a$'] })
    expect(unit).toContain('ExecStart="/bin/mitmdump" "--allow-hosts" "^a$$"')
    expect(unit).toContain('Restart=always')
  })
})

describe('ProxyManager', () => {
  let dir: string
  let settings: Settings
  let calls: string[][]
  let active: boolean
  let listening: boolean

  function manager(): ProxyManager {
    const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, ...args])
      if (args.includes('is-active')) return { code: active ? 0 : 3, stdout: '', stderr: '' }
      if (args[0] === 'tool' && args[1] === 'dir') return { code: 0, stdout: join(dir, 'bin') + '\n', stderr: '' }
      if (args.includes('restart') || args.includes('start')) {
        active = listening = true
        await fs.writeFile(settings.caFile, 'pem')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return new ProxyManager(
      () => settings,
      { unitFile: join(dir, 'unit', 'x.service'), addonSource: join(dir, 'addon.py'), addonTarget: join(dir, 'cfg', 'addon.py') },
      runner,
      async () => listening
    )
  }

  const originalPath = process.env.PATH

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cdp-'))
    settings = { ...DEFAULT_SETTINGS, caFile: join(dir, 'ca.pem') }
    calls = []
    active = listening = false
    await fs.writeFile(join(dir, 'addon.py'), '# addon v1')
    await fs.mkdir(join(dir, 'bin'))
    await fs.writeFile(join(dir, 'bin', 'mitmdump'), '')
    await fs.writeFile(join(dir, 'bin', 'uv'), '', { mode: 0o755 })
    process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`
  })
  afterEach(async () => {
    process.env.PATH = originalPath
    await rm(dir, { recursive: true, force: true })
  })

  it('finds mitmdump in uv\'s tool bin dir', async () => {
    expect(await manager().findMitmdump()).toBe(join(dir, 'bin', 'mitmdump'))
  })

  it('sets up the unit, then reports it as current and serving', async () => {
    const m = manager()
    expect((await m.info()).unit).toBe('missing')
    await m.setup()
    const unit = await fs.readFile(join(dir, 'unit', 'x.service'), 'utf8')
    expect(unit).toContain(`"cdp_upstream=${settings.headroomUrl}"`)
    expect(unit).toContain(`"-s" "${join(dir, 'cfg', 'addon.py')}"`)
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual(expect.arrayContaining(['--user daemon-reload', '--user enable', '--user restart']))
    expect(await m.info()).toMatchObject({ unit: 'current', active: true, listening: true, caExists: true })
  })

  it('flags the unit as outdated after a port change or a new addon', async () => {
    const m = manager()
    await m.setup()
    settings = { ...settings, proxyPort: 9999 }
    expect((await m.info()).unit).toBe('outdated')
    settings = { ...settings, proxyPort: DEFAULT_SETTINGS.proxyPort }
    await fs.writeFile(join(dir, 'addon.py'), '# addon v2')
    expect((await m.info()).unit).toBe('outdated')
  })

  it('recognises the unit written by legacy/cdp.sh', async () => {
    await fs.mkdir(join(dir, 'unit'))
    await fs.writeFile(join(dir, 'unit', 'x.service'), 'ExecStart=/x/mitmdump --map-remote |a|b\n')
    expect((await manager().info()).unit).toBe('legacy')
  })

  it('passes the port and keeps the API-only decryption', () => {
    const args = mitmdumpArgs({ proxyPort: 1234, headroomUrl: 'http://h:1' }, '/a.py')
    expect(args.join(' ')).toContain('--listen-port 1234')
    expect(args).toContain('^api[.]anthropic[.]com:443$')
    expect(args).toContain('connection_strategy=lazy')
  })
})

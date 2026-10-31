import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompressorInfo } from '@shared/ipc'
import { approveToolAction, binaryVersion, extractRtk, newerVersion, officialPonytailSource, parsePonytailGain, parseRtkGain, ponytailInfo, releaseVersion, rtkUrls, ToolManager, UPDATE_INTERVAL_MS } from './tools'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function archive(name = 'rtk', kind = '0', payload = 'fake executable'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write(Buffer.byteLength(payload).toString(8).padStart(11, '0'), 124)
  header.write(kind, 156)
  const data = Buffer.from(payload)
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]))
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'proxy-tools-'))
  roots.push(root)
  const state = {
    now: Date.UTC(2026, 9, 31), offline: false, badChecksum: false, failDetection: false,
    missingRtk: false, missingHeadroom: false, missingClaude: false,
    rtkVersion: '0.49.0', headroomVersion: '0.40.0', ponyVersion: '5.3.0',
    ponyInstalled: true, codexInstalled: false, marketplace: true, foreignMarketplace: false,
    active: true, managed: 'ours' as CompressorInfo['managed'], local: true,
    streamCode: 0, failVerification: false
  }
  const service = vi.fn(async (): Promise<CompressorInfo> => ({
    binary: state.missingHeadroom ? null : '/fake/headroom', uv: '/fake/uv', unit: 'current', active: state.active,
    answering: state.active, managed: state.managed, local: state.local
  }))
  const runner = vi.fn(async (cmd: string, args: string[]) => {
    if (args[0] === '--version') {
      const managed = cmd === join(root, 'tools/rtk') && await fs.readFile(cmd, 'utf8').catch(() => '') === 'fake executable'
      const v = cmd.includes('headroom') ? state.headroomVersion : managed || (cmd.endsWith('.staging') && !state.failVerification) ? '0.50.0' : state.rtkVersion
      return { code: 0, stdout: `${cmd.includes('headroom') ? 'headroom, version' : 'rtk'} ${v}\n`, stderr: '' }
    }
    if (args[0] === 'init') return { code: 0, stdout: '[dry-run] would patch hooks.json; nothing written', stderr: '' }
    if (args[1] === 'marketplace') return { code: 0, stdout: JSON.stringify(state.marketplace ? [{ name: 'ponytail', repo: state.foreignMarketplace ? 'attacker/ponytail' : 'DietrichGebert/ponytail' }] : []), stderr: '' }
    if (state.failDetection) return { code: 1, stdout: '', stderr: 'plugin API unavailable' }
    return { code: 0, stdout: JSON.stringify(cmd.endsWith('codex')
      ? { installed: state.codexInstalled ? [{ pluginId: 'ponytail@ponytail', version: state.ponyVersion, enabled: true }] : [] }
      : state.ponyInstalled ? [{ id: 'ponytail@ponytail', version: state.ponyVersion, enabled: true, scope: 'user' }] : []), stderr: '' }
  })
  const stream = vi.fn(async (cmd: string, _args: string[], _log: (line: string) => void) => {
    if (state.streamCode) return state.streamCode
    if (cmd.endsWith('uv')) { state.headroomVersion = '0.41.0'; state.missingHeadroom = false }
    if (cmd.endsWith('claude')) { state.ponyInstalled = true; state.ponyVersion = '5.4.0' }
    if (cmd.endsWith('codex')) { state.codexInstalled = true; state.ponyVersion = '5.4.0' }
    return 0
  })
  const find = vi.fn(async (name: string) => (name === 'rtk' && state.missingRtk) || (name === 'claude' && state.missingClaude) ? null : `/fake/${name}`)
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (state.offline) throw new Error('offline')
    if (url.endsWith('.tar.gz')) return new Response(new Uint8Array(archive()))
    if (url.endsWith('checksums.txt')) return new Response(`${state.badChecksum ? '0'.repeat(64) : createHash('sha256').update(archive()).digest('hex')}  ${rtkUrls('0.50.0', 'x64').asset}\n`)
    const payload = url.includes('pypi.org') ? { info: { version: '0.41.0' } }
      : url.includes('api.github.com') ? { tag_name: 'v0.50.0', draft: false, prerelease: false } : { version: '5.4.0' }
    return new Response(JSON.stringify(payload))
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>
  const setup = vi.fn(async () => {})
  const deps = { root, home: join(root, 'home'), arch: 'x64', runner, stream, find, request, now: () => state.now, headroomInfo: service, setupHeadroom: setup }
  const manager = new ToolManager(deps)
  return { root, state, runner, stream, find, request, setup, manager, deps }
}

describe('version and source handling', () => {
  it('compares stable versions numerically without downgrades or prereleases', () => {
    expect(newerVersion('0.50.0', '0.9.0')).toBe(true)
    expect(newerVersion('1.0.0', '2.0.0')).toBe(false)
    expect(newerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(newerVersion('1.0.0-beta', '0.9.0')).toBe(false)
    expect(newerVersion('1.0.0', null)).toBe(false)
    expect(releaseVersion('v1.2.3')).toBe('1.2.3')
    expect(releaseVersion('1.2.3;evil')).toBeNull()
    expect(binaryVersion('headroom, version 0.40.0\n')).toBe('0.40.0')
    expect(binaryVersion('rtk 0.49.0-dev')).toBeNull()
  })

  it('recognizes only the official marketplace source', () => {
    expect(officialPonytailSource({ repo: 'DietrichGebert/ponytail' })).toBe(true)
    expect(officialPonytailSource({ marketplaceSource: { source: 'https://github.com/DietrichGebert/ponytail.git' } })).toBe(true)
    expect(officialPonytailSource({ repo: 'attacker/DietrichGebert/ponytail' })).toBe(false)
    expect(officialPonytailSource({ repo: 'https://github.com/DietrichGebert/ponytail.evil' })).toBe(false)
  })

  it('distinguishes native installed lists from catalogs and unknown schemas', () => {
    expect(ponytailInfo({ installed: [], available: [{ pluginId: 'ponytail@ponytail' }] }, true).installed).toBe(false)
    expect(ponytailInfo([{ id: 'ponytail@other', version: '5.3.0' }], false).installed).toBe(false)
    expect(ponytailInfo([{ id: 'ponytail@ponytail', scope: 'project' }], false).installed).toBe(false)
    expect(ponytailInfo([{ id: 'ponytail@ponytail', scope: 'user', version: '5.3.0', enabled: false }], false)).toEqual({ installed: true, version: '5.3.0', enabled: false })
    expect(() => ponytailInfo({}, true)).toThrow(/Unrecognized/)
  })
})

describe('bounded RTK archive handling', () => {
  it('reads the binary without extracting arbitrary archive paths', () => {
    expect(extractRtk(archive()).toString()).toBe('fake executable')
    expect(extractRtk(archive('./rtk')).toString()).toBe('fake executable')
    expect(() => extractRtk(archive('../../rtk'))).toThrow(/missing/)
    expect(() => extractRtk(archive('rtk', '2'))).toThrow(/regular/)
    expect(() => extractRtk(archive('rtk', '1'))).toThrow(/regular/)
    expect(() => extractRtk(Buffer.from('not gzip'))).toThrow()
    expect(() => rtkUrls('1.0.0', 'ia32')).toThrow(/Unsupported/)
  })
})

describe('tool detection and update cadence', () => {
  it('detects packages and each client independently without installing anything', async () => {
    const f = await fixture()
    const tools = await f.manager.refresh()
    expect(tools.find((t) => t.id === 'rtk')).toMatchObject({ installed: true, version: '0.49.0', latest: '0.50.0', updateAvailable: true })
    expect(tools.find((t) => t.id === 'ponytail-claude')).toMatchObject({ installed: true, version: '5.3.0' })
    expect(tools.find((t) => t.id === 'ponytail-codex')).toMatchObject({ installed: false })
    expect(f.stream).not.toHaveBeenCalled()
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('throttles network checks, shares in-flight work, and supports a forced check', async () => {
    const f = await fixture()
    await Promise.all([f.manager.refresh(), f.manager.refresh()])
    expect(f.request).toHaveBeenCalledTimes(3)
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(3)
    f.state.now += UPDATE_INTERVAL_MS
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(6)
    await f.manager.refresh(true)
    expect(f.request).toHaveBeenCalledTimes(9)
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('loads the durable cadence cache across app restarts', async () => {
    const f = await fixture()
    await f.manager.refresh()
    const restarted = new ToolManager(f.deps)
    try { await restarted.start(); expect(f.request).toHaveBeenCalledTimes(3) }
    finally { restarted.stop() }
  })

  it('keeps old versions during an outage, shows errors, and backs off retries', async () => {
    const f = await fixture()
    await f.manager.refresh()
    f.state.offline = true
    const tools = await f.manager.refresh(true)
    expect(tools[0]).toMatchObject({ installed: true, latest: '0.41.0', error: expect.stringContaining('offline') })
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(6)
  })

  it('does not offer installation on a detection failure', async () => {
    const f = await fixture()
    f.state.failDetection = true
    const tools = await f.manager.refresh()
    expect(tools.find((t) => t.id === 'ponytail-claude')).toMatchObject({ installed: null, blocked: expect.any(String), error: expect.stringContaining('Detection failed') })
    await expect(f.manager.plan('ponytail-claude', 'install')).rejects.toThrow(/detection error/)
  })

  it('shows missing prerequisites without running an installer', async () => {
    const f = await fixture()
    f.state.missingClaude = true
    expect((await f.manager.refresh()).find((t) => t.id === 'ponytail-claude')).toMatchObject({ installed: false, blocked: 'Install Claude Code first.' })
    expect(f.stream).not.toHaveBeenCalled()
  })
})

describe('approved actions', () => {
  it('a cancelled approval never installs or restarts anything', async () => {
    const f = await fixture()
    const approve = vi.fn(async () => false)
    expect(await approveToolAction(f.manager, 'headroom', 'update', approve, () => {})).toBe(false)
    expect(approve.mock.calls).toHaveLength(1)
    expect(f.stream).not.toHaveBeenCalled()
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('pins headroom updates and restarts only the active app-managed service', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('headroom', 'update')
    expect(plan.commands).toEqual([{ cmd: '/fake/uv', args: ['tool', 'install', '--upgrade', '--python', '3.13', 'headroom-ai[all]==0.41.0'] }])
    expect(plan.detail).toContain('headroom-ai[all]==0.41.0')
    expect(f.stream).not.toHaveBeenCalled()
    await f.manager.execute(plan, () => {})
    expect(f.setup).toHaveBeenCalledOnce()
  })

  it('leaves a stopped headroom stopped after an approved update', async () => {
    const f = await fixture()
    f.state.active = false
    f.state.managed = 'none'
    await approveToolAction(f.manager, 'headroom', 'update', async () => true, () => {})
    expect(f.stream).toHaveBeenCalledOnce()
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('refuses an external headroom before planning and rechecks before mutation', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('headroom', 'update')
    f.state.managed = 'external'
    await expect(f.manager.execute(plan, () => {})).rejects.toThrow(/outside/)
    await expect(f.manager.plan('headroom', 'update')).rejects.toThrow(/outside/)
    expect(f.stream).not.toHaveBeenCalled()
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('does not restart headroom if it was stopped while approval was pending', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('headroom', 'update')
    f.state.active = false
    f.state.managed = 'none'
    await f.manager.execute(plan, () => {})
    expect(f.stream).toHaveBeenCalledOnce()
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('never starts a service when package installation fails', async () => {
    const f = await fixture()
    f.state.streamCode = 1
    await expect(approveToolAction(f.manager, 'headroom', 'update', async () => true, () => {})).rejects.toThrow(/exited with 1/)
    expect(f.setup).not.toHaveBeenCalled()
  })

  it('previews RTK hook changes before approval and keeps custom filters untrusted', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('rtk', 'connect-codex')
    expect(plan.detail).toContain('[dry-run]')
    expect(plan.commands).toEqual([{ cmd: '/fake/rtk', args: ['init', '-g', '--codex', '--auto-patch', '--no-trust-filters'] }])
    expect(f.stream).not.toHaveBeenCalled()
    await f.manager.execute(plan, () => {})
    expect(f.stream).toHaveBeenCalledOnce()
  })

  it('installs RTK atomically in an app-owned path and preserves the external binary', async () => {
    const f = await fixture()
    await approveToolAction(f.manager, 'rtk', 'update', async () => true, () => {})
    expect(await fs.readFile(join(f.root, 'tools/rtk'), 'utf8')).toBe('fake executable')
    expect(await fs.readlink(join(f.root, 'home/.local/bin/rtk'))).toBe(join(f.root, 'tools/rtk'))
    expect(f.stream).not.toHaveBeenCalled()
    expect(f.find).toHaveBeenCalledWith('rtk')
  })

  it('rejects a checksum mismatch before creating a binary', async () => {
    const f = await fixture()
    f.state.badChecksum = true
    await expect(approveToolAction(f.manager, 'rtk', 'update', async () => true, () => {})).rejects.toThrow(/SHA-256/)
    await expect(fs.stat(join(f.root, 'tools/rtk'))).rejects.toThrow()
  })

  it('does not connect a private binary when PATH would run a different RTK', async () => {
    const f = await fixture()
    await approveToolAction(f.manager, 'rtk', 'update', async () => true, () => {})
    await expect(f.manager.plan('rtk', 'connect-claude')).rejects.toThrow(/currently resolves/)
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('never overwrites a foreign user-bin RTK while planning an update', async () => {
    const f = await fixture()
    const bin = join(f.root, 'home/.local/bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(join(bin, 'rtk'), 'foreign binary')
    await expect(f.manager.plan('rtk', 'update')).rejects.toThrow(/another installation/)
    expect(await fs.readFile(join(bin, 'rtk'), 'utf8')).toBe('foreign binary')
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('preserves a working binary if the downloaded version fails verification', async () => {
    const f = await fixture()
    await fs.mkdir(join(f.root, 'tools'))
    await fs.writeFile(join(f.root, 'tools/rtk'), 'old binary', { mode: 0o700 })
    f.state.failVerification = true
    await expect(approveToolAction(f.manager, 'rtk', 'update', async () => true, () => {})).rejects.toThrow(/Expected RTK/)
    expect(await fs.readFile(join(f.root, 'tools/rtk'), 'utf8')).toBe('old binary')
    await expect(fs.stat(join(f.root, 'tools/rtk.staging'))).rejects.toThrow()
  })

  it('refuses a foreign Ponytail marketplace and never updates unrelated plugins', async () => {
    const f = await fixture()
    f.state.foreignMarketplace = true
    await expect(f.manager.plan('ponytail-claude', 'update')).rejects.toThrow(/different marketplace/)
    expect(f.stream).not.toHaveBeenCalled()
    f.state.foreignMarketplace = false
    const plan = await f.manager.plan('ponytail-claude', 'update')
    expect(plan.commands.map((c) => c.args)).toEqual([
      ['plugin', 'marketplace', 'update', 'ponytail'], ['plugin', 'update', 'ponytail@ponytail', '--scope', 'user']
    ])
    await f.manager.execute(plan, () => {})
    expect(f.stream).toHaveBeenCalledTimes(2)
  })

  it('uses Codex native marketplace commands and leaves hook trust to the user', async () => {
    const f = await fixture()
    f.state.marketplace = false
    const plan = await f.manager.plan('ponytail-codex', 'install')
    expect(plan.commands.map((c) => c.args)).toEqual([
      ['plugin', 'marketplace', 'add', 'DietrichGebert/ponytail'], ['plugin', 'add', 'ponytail@ponytail']
    ])
    expect(plan.detail).toContain('/hooks')
    await f.manager.execute(plan, () => {})
    expect(f.stream).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid IPC action values without running any commands', async () => {
    const f = await fixture()
    await expect(f.manager.plan('evil' as 'rtk', 'install')).rejects.toThrow(/Unknown/)
    await expect(f.manager.plan('rtk', 'evil' as 'install')).rejects.toThrow(/Unknown/)
    expect(f.runner).not.toHaveBeenCalled()
    expect(f.stream).not.toHaveBeenCalled()
  })
})

describe('tool stats', () => {
  it('reads rtk gain JSON and keeps the last 14 days', () => {
    const daily = Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, saved_tokens: i }))
    const stats = parseRtkGain({ summary: { total_commands: 800, total_saved: 85630, avg_savings_pct: 27.02 }, daily })!
    expect(stats.facts).toEqual([
      { label: 'tokens saved', value: '85,630' },
      { label: 'average saving', value: '27%' },
      { label: 'commands filtered', value: '800' }
    ])
    expect(stats.daily).toHaveLength(14)
    expect(stats.daily.at(-1)).toEqual({ day: '2026-10-20', value: 19 })
    expect(parseRtkGain([])).toBeNull()
  })

  it('reads the benchmark scoreboard from the ponytail-gain skill', () => {
    const md = [
      '```',
      '  ponytail gain           benchmark · 39 tasks × 5 runs · Opus 5.5',
      '',
      '  no-skill        ████████████████████  100%',
      '  Lines of code   █████████···········   47%   ▼ 53%',
      '  Output tokens   ███████████·········   55%   ▼ 45%',
      '  Hidden checks passed   97%  (no-skill 96%)',
      '```'
    ].join('\n')
    const stats = parsePonytailGain(md)!
    expect(stats.facts).toEqual([{ label: 'less lines of code', value: '53%' }, { label: 'less output tokens', value: '45%' }])
    expect(stats.source).toMatch(/benchmark · 39 tasks.*nothing locally/)
    expect(parsePonytailGain('no scoreboard')).toBeNull()
  })
})

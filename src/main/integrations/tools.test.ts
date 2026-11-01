import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompressorInfo } from '@shared/ipc'
import { approveToolAction, binaryVersion, extractRtk, newerVersion, officialSource, mcpPin, parseChisleStats, parsePonytailBand, parsePonytailGain, parseRtkGain, rtkConnected, pluginInfo, releaseVersion, rtkUrls, ToolManager, UPDATE_INTERVAL_MS } from './tools'

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
    streamCode: 0, failVerification: false, rtkClaude: true, ponyEnabled: true
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
    if (args[0] === 'init' && args.includes('--show')) {
      return { code: 0, stdout: args.includes('--codex') ? '[--] Global hook: not found\n' : `[${state.rtkClaude ? 'ok' : '--'}] Hook: rtk hook claude\n`, stderr: '' }
    }
    if (args[0] === 'init') return { code: 0, stdout: '[dry-run] would patch hooks.json; nothing written', stderr: '' }
    if (args[1] === 'marketplace') return { code: 0, stdout: JSON.stringify(state.marketplace ? [{ name: 'ponytail', repo: state.foreignMarketplace ? 'attacker/ponytail' : 'DietrichGebert/ponytail' }] : []), stderr: '' }
    if (state.failDetection) return { code: 1, stdout: '', stderr: 'plugin API unavailable' }
    return { code: 0, stdout: JSON.stringify(cmd.endsWith('codex')
      ? { installed: state.codexInstalled ? [{ pluginId: 'ponytail@ponytail', version: state.ponyVersion, enabled: true }] : [] }
      : state.ponyInstalled ? [{ id: 'ponytail@ponytail', version: state.ponyVersion, enabled: state.ponyEnabled, scope: 'user' }] : []), stderr: '' }
  })
  const stream = vi.fn(async (cmd: string, args: string[], _log: (line: string) => void) => {
    if (state.streamCode) return state.streamCode
    if (args.includes('--uninstall')) { state.rtkClaude = false; return 0 }
    if (args[1] === 'disable' || args[1] === 'enable') { state.ponyEnabled = args[1] === 'enable'; return 0 }
    if (args[1] === 'marketplace' && args[2] === 'remove') { state.marketplace = false; return 0 }
    if (args[0] === 'mcp' || args[0] === 'cache') return 0
    if (args[1] === 'uninstall' || args[1] === 'remove') { state.ponyInstalled = state.codexInstalled = false; return 0 }
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
    expect(officialSource({ repo: 'DietrichGebert/ponytail' }, 'DietrichGebert/ponytail')).toBe(true)
    expect(officialSource({ marketplaceSource: { source: 'https://github.com/DietrichGebert/ponytail.git' } }, 'DietrichGebert/ponytail')).toBe(true)
    expect(officialSource({ repo: 'attacker/DietrichGebert/ponytail' }, 'DietrichGebert/ponytail')).toBe(false)
    expect(officialSource({ repo: 'https://github.com/DietrichGebert/ponytail.evil' }, 'DietrichGebert/ponytail')).toBe(false)
  })

  it('distinguishes native installed lists from catalogs and unknown schemas', () => {
    expect(pluginInfo({ installed: [], available: [{ pluginId: 'ponytail@ponytail' }] }, true, 'ponytail@ponytail').installed).toBe(false)
    expect(pluginInfo([{ id: 'ponytail@other', version: '5.3.0' }], false, 'ponytail@ponytail').installed).toBe(false)
    expect(pluginInfo([{ id: 'ponytail@ponytail', scope: 'project' }], false, 'ponytail@ponytail').installed).toBe(false)
    expect(pluginInfo([{ id: 'ponytail@ponytail', scope: 'user', version: '5.3.0', enabled: false }], false, 'ponytail@ponytail')).toEqual({ installed: true, version: '5.3.0', enabled: false })
    expect(() => pluginInfo({}, true, 'ponytail@ponytail')).toThrow(/Unrecognized/)
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

  // Six update sources: headroom, RTK, Ponytail, Chisle, Serena, MarkItDown.
  it('throttles network checks, shares in-flight work, and supports a forced check', async () => {
    const f = await fixture()
    await Promise.all([f.manager.refresh(), f.manager.refresh()])
    expect(f.request).toHaveBeenCalledTimes(6)
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(6)
    f.state.now += UPDATE_INTERVAL_MS
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(12)
    await f.manager.refresh(true)
    expect(f.request).toHaveBeenCalledTimes(18)
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('loads the durable cadence cache across app restarts', async () => {
    const f = await fixture()
    await f.manager.refresh()
    const restarted = new ToolManager(f.deps)
    try { await restarted.start(); expect(f.request).toHaveBeenCalledTimes(6) }
    finally { restarted.stop() }
  })

  it('keeps old versions during an outage, shows errors, and backs off retries', async () => {
    const f = await fixture()
    await f.manager.refresh()
    f.state.offline = true
    const tools = await f.manager.refresh(true)
    expect(tools[0]).toMatchObject({ installed: true, latest: '0.41.0', error: expect.stringContaining('offline') })
    await f.manager.refresh()
    expect(f.request).toHaveBeenCalledTimes(12)
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

  it('reads RTK connections and disconnects only after a preview', async () => {
    const f = await fixture()
    const rtk = (await f.manager.refresh(true)).find((t) => t.id === 'rtk')!
    expect(rtk.connected).toEqual({ claude: true, codex: false })
    const plan = await f.manager.plan('rtk', 'disconnect-claude')
    expect(plan.commands).toEqual([{ cmd: '/fake/rtk', args: ['init', '-g', '--uninstall'] }])
    expect(f.runner).toHaveBeenCalledWith('/fake/rtk', ['init', '-g', '--uninstall', '--dry-run'])
    expect(f.stream).not.toHaveBeenCalled()
    await f.manager.execute(plan, () => {})
    expect(f.manager.current.find((t) => t.id === 'rtk')!.connected?.claude).toBe(false)
  })

  it('removes Ponytail with the client command and verifies it is gone', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('ponytail-claude', 'remove')
    expect(plan.commands).toEqual([{ cmd: '/fake/claude', args: ['plugin', 'uninstall', 'ponytail@ponytail', '--scope', 'user'] }])
    await f.manager.execute(plan, () => {})
    expect(f.manager.current.find((t) => t.id === 'ponytail-claude')!.installed).toBe(false)
    await expect(f.manager.plan('ponytail-claude', 'remove')).rejects.toThrow(/not installed/)
  })

  it('previews RTK hook changes before approval and keeps custom filters untrusted', async () => {
    const f = await fixture()
    const plan = await f.manager.plan('rtk', 'connect-codex')
    expect(plan.detail).toContain('[dry-run]')
    expect(plan.commands).toEqual([{ cmd: '/fake/rtk', args: ['init', '-g', '--codex', '--no-trust-filters'] }])
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
    expect(stats.source).toMatch(/benchmark · 39 tasks.*no local band ledger/)
    expect(parsePonytailGain('no scoreboard')).toBeNull()
  })
})

describe('rtkConnected', () => {
  const claude = [
    'rtk Configuration:', '',
    '[ok] Hook: rtk hook claude (native binary command)',
    '[ok] RTK.md: /home/u/.claude/RTK.md (slim mode)',
    '[ok] Global (~/.claude/CLAUDE.md): @RTK.md reference',
    '[--] Local (./CLAUDE.md): exists but rtk not configured',
    '[ok] settings.json: RTK hooks configured (PreToolUse)',
    '[--] OpenCode: plugin not found'
  ].join('\n')
  const codex = [
    'rtk Configuration (Codex CLI):', '',
    '[--] Global RTK.md: not found',
    '[--] Global hook: not found',
    '[--] Global AGENTS.md: exists but rtk not configured',
    '[--] Local hook: not found'
  ].join('\n')

  it('ignores project-local and other-client lines', () => {
    expect(rtkConnected(claude, false)).toBe(true)
    expect(rtkConnected(codex, true)).toBe(false)
    expect(rtkConnected(codex.replace(/\[--\] Global/g, '[ok] Global'), true)).toBe(true)
  })
  it('treats a partial setup as not connected and unknown output as unknown', () => {
    expect(rtkConnected(claude.replace('[ok] settings.json', '[--] settings.json'), false)).toBe(false)
    expect(rtkConnected('something else', false)).toBeNull()
  })
})

describe('parsePonytailBand', () => {
  const header = 'key,started,project,name,cost_usd,turns,agent_minutes,tokens_total,tokens_output,reuse_pct,reused,new,callers_open,tests,level,model'
  it('sums every session across project ledgers, with quoted names', () => {
    const stats = parsePonytailBand([
      `${header}\na-1,2026-10-31 13:26,p,"say ""hi"", then go",11.94,8,1.0,1084738,1145,,0,0,0,not run,full,m\n`,
      `${header}\nb-2,2026-10-31 09:22,q,plain,5.07,9,80.3,6972369,47132,,0,0,0,not run,full,m\n`
    ])!
    expect(stats.facts).toEqual([
      { label: 'cost', value: '$17.01' },
      { label: 'tokens', value: '8.1M' },
      { label: 'turns', value: '17' },
      { label: 'agent time', value: '1h 21m' }
    ])
    expect(stats.source).toMatch(/2 Claude Code sessions/)
    expect(parsePonytailBand([header])).toBeNull()
  })
})

describe('MCP servers and Chisle', () => {
  it('recognizes only uvx registrations pinned to the package', () => {
    expect(mcpPin({ command: '/u/.local/bin/uvx', args: ['--python', '3.13', '--from', 'serena-agent==2.1.0', 'serena'] }, 'serena-agent')).toBe('2.1.0')
    expect(mcpPin({ command: 'uvx', args: ['--from', 'markitdown-mcp==0.0.1a8', 'markitdown-mcp'] }, 'markitdown-mcp')).toBe('0.0.1a8')
    expect(mcpPin({ command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena'] }, 'serena-agent')).toBeNull()
    expect(mcpPin({ command: 'npx', args: ['--from', 'serena-agent==2.1.0'] }, 'serena-agent')).toBeNull()
    expect(mcpPin({ command: 'uvx', args: ['--from', 'serena-agent==2.1.0;rm'] }, 'serena-agent')).toBeNull()
  })

  it('reads chisle compress stats', () => {
    expect(parseChisleStats({ savedChars: 40_000, events: 12 })!.facts.map((f) => f.value)).toEqual(['40,000', '10,000', '12'])
    expect(parseChisleStats({})).toBeNull()
  })

  it('connects Serena at user scope with a pinned uvx command, and leaves a foreign one alone', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    await fs.mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "serena-mcp"\n')
    const serena = (await f.manager.refresh(true)).find((t) => t.id === 'serena')!
    expect(serena).toMatchObject({ installed: true, version: null, latest: '0.41.0', connected: { claude: false, codex: true }, foreign: { claude: false, codex: true } })

    const plan = await f.manager.plan('serena', 'connect-claude')
    expect(plan.commands).toEqual([{ cmd: '/fake/claude', args: ['mcp', 'add', '--scope', 'user', 'serena', '--',
      '/fake/uvx', '--python', '3.13', '--from', 'serena-agent==0.41.0', 'serena', 'start-mcp-server', '--context', 'claude-code', '--project-from-cwd'] }])
    await expect(f.manager.plan('serena', 'disconnect-codex')).rejects.toThrow(/did not add/)
    await expect(f.manager.plan('serena', 'install')).rejects.toThrow()
    const md = await f.manager.plan('markitdown', 'connect-codex')
    expect(md.commands[0].args).toEqual(['mcp', 'add', 'markitdown', '--', '/fake/uvx', '--python', '3.13',
      '--prerelease', 'if-necessary-or-explicit', '--with', 'azure-ai-contentunderstanding>=1.2.0b1', '--from', 'markitdown-mcp==0.41.0', 'markitdown-mcp'])
  })

  it('plans Chisle like Ponytail, from its own marketplace', async () => {
    const f = await fixture()
    f.state.marketplace = false
    const plan = await f.manager.plan('chisle-claude', 'install')
    expect(plan.commands).toEqual([
      { cmd: '/fake/claude', args: ['plugin', 'marketplace', 'add', 'JayPokale/Chisle'] },
      { cmd: '/fake/claude', args: ['plugin', 'install', 'chisle@chisle', '--scope', 'user'] }
    ])
  })
})

describe('stop, start and remove from system', () => {
  it('disables and re-enables a plugin in Claude Code without uninstalling it', async () => {
    const f = await fixture()
    const stop = await f.manager.plan('ponytail-claude', 'stop')
    expect(stop.commands).toEqual([{ cmd: '/fake/claude', args: ['plugin', 'disable', 'ponytail@ponytail', '--scope', 'user'] }])
    await f.manager.execute(stop, () => {})
    expect(f.manager.current.find((t) => t.id === 'ponytail-claude')).toMatchObject({ installed: true, enabled: false })
    await f.manager.execute(await f.manager.plan('ponytail-claude', 'start'), () => {})
    expect(f.manager.current.find((t) => t.id === 'ponytail-claude')!.enabled).toBe(true)
  })

  it('uninstalls a plugin from every client and removes only the official marketplace', async () => {
    const f = await fixture()
    f.state.codexInstalled = true
    await f.manager.refresh(true)
    const plan = await f.manager.plan('ponytail-claude', 'uninstall')
    expect(plan.commands.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      '/fake/claude plugin uninstall ponytail@ponytail --scope user',
      '/fake/codex plugin remove ponytail@ponytail',
      '/fake/claude plugin marketplace remove ponytail',
      '/fake/codex plugin marketplace remove ponytail'
    ])
    await f.manager.execute(plan, () => {})
    f.state.foreignMarketplace = true
    f.state.ponyInstalled = true
    await f.manager.refresh(true)
    expect((await f.manager.plan('ponytail-claude', 'uninstall')).commands.some((c) => c.args.includes('marketplace'))).toBe(false)
  })

  it('stops RTK by unhooking connected clients and refuses to delete a binary it did not install', async () => {
    const f = await fixture()
    expect((await f.manager.plan('rtk', 'stop')).commands).toEqual([{ cmd: '/fake/rtk', args: ['init', '-g', '--uninstall'] }])
    await expect(f.manager.plan('rtk', 'uninstall')).rejects.toThrow(/outside this app/)
  })

  it('deletes the app-managed RTK and its symlink', async () => {
    const f = await fixture()
    await approveToolAction(f.manager, 'rtk', 'update', async () => true, () => {})
    const binary = join(f.root, 'tools/rtk')
    const plan = await f.manager.plan('rtk', 'uninstall')
    await f.manager.execute(plan, () => {})
    await expect(fs.access(binary)).rejects.toThrow()
    await expect(fs.lstat(join(f.root, 'home/.local/bin/rtk'))).rejects.toThrow()
  })

  it('removes only its own MCP registrations and clears the uv cache', async () => {
    const f = await fixture()
    const home = join(f.root, 'home')
    await fs.mkdir(join(home, '.codex'), { recursive: true })
    await fs.writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { serena: { command: '/fake/uvx', args: ['--from', 'serena-agent==0.41.0', 'serena'] } } }))
    await fs.writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.serena]\ncommand = "serena-mcp"\n')
    await f.manager.refresh(true)
    expect((await f.manager.plan('serena', 'stop')).commands).toEqual([{ cmd: '/fake/claude', args: ['mcp', 'remove', '--scope', 'user', 'serena'] }])
    expect((await f.manager.plan('serena', 'uninstall')).commands.at(-1)).toEqual({ cmd: '/fake/uv', args: ['cache', 'clean', 'serena-agent'] })
    await expect(f.manager.plan('serena', 'start')).rejects.toThrow(/switch/)
  })
})

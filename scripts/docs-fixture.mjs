// Public demo data for documentation screenshots. No local client configs or live API calls.
const checkedAt = '2026-11-01T10:00:00Z'
const healthy = (detail) => ({ health: 'ok', detail })
const totals = { requests: 1248, tokensSaved: 3420800, totalInputTokens: 7900000, compressionSavingsUsd: 12.38, cacheSavingsUsd: 46.2, totalInputCostUsd: 95.4 }
export const fixture = {
  status: {
    overall: 'ok', checkedAt,
    proxy: healthy('listening on 127.0.0.1:8877 and :8878 (Codex)'),
    proxyInfo: { port: 8877, codexPort: 8878, mitmdump: '/home/demo/.local/bin/mitmdump', uv: '/home/demo/.local/bin/uv',
      unit: 'current', active: true, listening: true, codexListening: true, caExists: true, owner: { pid: 1200, name: 'mitmdump' }, ours: true },
    compressor: healthy('healthy; run by this app'),
    compressorInfo: { binary: '/home/demo/.local/bin/headroom', uv: '/home/demo/.local/bin/uv', unit: 'current', active: true, answering: true, managed: 'ours', local: true },
    clients: healthy('routed: Claude Code, Codex'),
    clientList: ['claude-code', 'codex'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      configPath: id === 'codex' ? '/home/demo/.codex/config.toml' : '/home/demo/.claude/settings.json',
      enabled: true, state: 'applied', detail: `routed through http://127.0.0.1:${id === 'codex' ? '8878/v1' : '8877'}`, checkedAt })),
    stats: { lifetime: totals, session: { ...totals, requests: 86, tokensSaved: 248000, startedAt: checkedAt, lastActivityAt: checkedAt },
      daily: [100, 160, 135, 220, 190, 280, 240, 310, 290, 350, 320, 440, 380, 460].map((v, i) => ({
        day: `2026-10-${String(18 + i).padStart(2, '0')}`, tokensSaved: v * 1000, compressionSavingsUsd: v / 200 })),
      generatedAt: checkedAt, messagesLogged: true,
      recent: ['claude-opus-4-1', 'gpt-5'].map((model, i) => ({ id: `demo-${i}`, timestamp: checkedAt, provider: i ? 'openai' : 'anthropic', model,
        inputTokensOriginal: 24000, inputTokensOptimized: 15800, tokensSaved: 8200, savingsPercent: 34.2,
        transforms: ['tool-output', 'dedup'], cacheReadTokens: 10000, cacheWriteTokens: 0, uncachedInputTokens: 5800 })) }
  },
  settings: {
    proxyPort: 8877, codexPort: 8878, headroomUrl: 'http://127.0.0.1:6767', autoRepair: true, checkIntervalSec: 60, autostart: true,
    headroom: { optimize: true, mode: 'cache', targetRatio: null, ccr: 'retrieve', protectToolResults: '', compressors: [],
      codeAware: false, kompress: true, semanticCache: true, rateLimit: true, rpm: null, tpm: null, budgetUsd: null,
      budgetPeriod: 'daily', http2: true, beacon: true, logMessages: false, extraArgs: '' }
  },
  update: { currentVersion: '0.2.0', version: null, phase: 'idle', progress: 0, notes: '', error: null,
    checkedAt: Date.parse(checkedAt), autoCheck: true, autoDownload: true }
}
const tool = (id, name, extra = {}) => ({ id, name, installed: true, version: null, latest: null, updateAvailable: false,
  checkedAt, error: null, blocked: null, detail: '', stats: null, ...extra })
fixture.tools = [
  tool('headroom', 'headroom', { version: '0.40.0', latest: '0.40.0', detail: 'Run by this app.', dashboards: ['http://127.0.0.1:6767/dashboard'] }),
  tool('rtk', 'RTK', { version: '1.1.0', latest: '1.1.0', detail: 'App-managed binary. Connect it to each client below.',
    connected: { claude: true, codex: false }, stats: { source: 'rtk gain, this machine',
      facts: [{ label: 'tokens saved', value: '85,630' }, { label: 'average saving', value: '27%' }, { label: 'commands filtered', value: '800' }], daily: [] } }),
  ...['serena', 'markitdown', 'context7', 'codebase-memory'].map((id) => tool(id,
    { serena: 'Serena', markitdown: 'MarkItDown', context7: 'Context7', 'codebase-memory': 'Codebase Memory' }[id], {
      version: { serena: '2.1.0', markitdown: '0.0.1a8', context7: '4.4.4', 'codebase-memory': '0.12.1' }[id],
      connected: { claude: true, codex: id === 'context7' }, foreign: { claude: false, codex: false },
      detail: 'Local MCP server. Restart the client after changing its connection.',
      dashboards: id === 'serena' ? ['http://127.0.0.1:24282/dashboard/'] : [] })),
  tool('ponytail-claude', 'Ponytail · Claude Code', { version: '5.3.3', latest: '5.3.3', enabled: true, detail: 'Enabled. Restart the client after changes.',
    stats: { source: 'Ponytail band ledger, 11 Claude Code sessions on this machine', facts: [
      { label: 'cost', value: '$90.51' }, { label: 'tokens', value: '159.6M' }, { label: 'turns', value: '73' }, { label: 'agent time', value: '3h 55m' }], daily: [] } }),
  tool('ponytail-codex', 'Ponytail · Codex', { version: '5.3.3', latest: '5.3.3', enabled: true, detail: 'Enabled. Restart the client after changes.' }),
  tool('chisle-claude', 'Chisle · Claude Code', { installed: false, latest: '3.8.1', detail: 'Install the official Chisle plugin for this client.' })
]

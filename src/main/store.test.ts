import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HEADROOM_OPTIONS } from './compressors/headroom-options'
import { AppStore } from './store'

describe('AppStore', () => {
  it('moves the old top-level headroomLogMessages into headroom options', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cdp-store-')), 'state.json')
    await writeFile(path, JSON.stringify({ proxyPort: 9000, headroomLogMessages: true }))
    const store = new AppStore(path)
    const s = await store.load()
    expect(s.proxyPort).toBe(9000)
    expect(s.headroom).toEqual({ ...DEFAULT_HEADROOM_OPTIONS, logMessages: true })
    expect('headroomLogMessages' in s).toBe(false)
    await store.update({ checkIntervalSec: 30 })
    expect(JSON.parse(await readFile(path, 'utf8')).headroomLogMessages).toBeUndefined()
  })
})

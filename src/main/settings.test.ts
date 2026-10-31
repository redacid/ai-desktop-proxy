import { describe, expect, it } from 'vitest'
import { desktopArg, desktopEntry } from './autostart'
import { DEFAULT_HEADROOM_OPTIONS } from './compressors/headroom-options'
import { normalizeUrl, validateSettings } from './settings'

const good = { proxyPort: 8877, codexPort: 8878, headroomUrl: 'http://127.0.0.1:6767', headroom: DEFAULT_HEADROOM_OPTIONS, autoRepair: true, checkIntervalSec: 60, autostart: false }

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(good)).toBeNull()
  })
  it('rejects bad ports, URLs and intervals', () => {
    expect(validateSettings({ ...good, proxyPort: 80 })).toMatch(/port/)
    expect(validateSettings({ ...good, proxyPort: 8877.5 })).toMatch(/port/)
    expect(validateSettings({ ...good, headroomUrl: 'nope' })).toMatch(/valid URL/)
    expect(validateSettings({ ...good, headroomUrl: 'ftp://h' })).toMatch(/http/)
    expect(validateSettings({ ...good, headroomUrl: 'http://127.0.0.1:6767/v1' })).toMatch(/path/)
    expect(validateSettings({ ...good, headroomUrl: 'http://127.0.0.1:8877' })).toMatch(/same port/)
    expect(validateSettings({ ...good, checkIntervalSec: 5 })).toMatch(/interval/)
    expect(validateSettings({ ...good, codexPort: 8877 })).toMatch(/differ/)
    expect(validateSettings({ ...good, codexPort: 1 })).toMatch(/Codex port/)
    expect(validateSettings({ ...good, headroomUrl: 'http://127.0.0.1:8878' })).toMatch(/same port/)
  })
  it('trims a trailing slash', () => {
    expect(normalizeUrl('http://127.0.0.1:6767/')).toBe('http://127.0.0.1:6767')
  })
})

describe('autostart entry', () => {
  it('quotes paths with spaces and starts hidden', () => {
    expect(desktopArg('/opt/My Apps/x.AppImage')).toBe('"/opt/My Apps/x.AppImage"')
    expect(desktopEntry(['/a/b', '--hidden'])).toContain('Exec=/a/b --hidden')
  })
})

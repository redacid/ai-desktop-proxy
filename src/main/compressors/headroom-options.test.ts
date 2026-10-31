import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEADROOM_OPTIONS as D,
  headroomArgs,
  headroomEnv,
  normalizeHeadroomOptions,
  splitArgs,
  validateHeadroomOptions
} from './headroom-options'

describe('headroomArgs', () => {
  it('adds nothing for headroom defaults', () => {
    expect(headroomArgs(D)).toEqual([])
    expect(validateHeadroomOptions(D)).toBeNull()
  })

  it('maps every option to its flag', () => {
    expect(headroomArgs({
      ...D,
      optimize: false,
      mode: 'token',
      targetRatio: 0.4,
      ccr: 'lossless',
      protectToolResults: ' Bash, WebFetch ,',
      compressors: ['smart_crusher', 'log'],
      codeAware: true,
      kompress: false,
      semanticCache: false,
      rpm: 300,
      tpm: 100000,
      budgetUsd: 5,
      budgetPeriod: 'monthly',
      http2: false,
      logMessages: true,
      extraArgs: '--memory-top-k 5'
    })).toEqual([
      '--no-optimize', '--mode', 'token', '--target-ratio', '0.4', '--lossless',
      '--protect-tool-results', 'Bash,WebFetch', '--compressor', 'smart_crusher,log', '--code-aware',
      '--disable-kompress', '--no-cache', '--rpm', '300', '--tpm', '100000',
      '--budget', '5', '--budget-period', 'monthly', '--no-http2', '--log-messages', '--memory-top-k', '5'
    ])
  })

  it('drops rpm/tpm when rate limiting is off, and the compressor flag when all are on', () => {
    expect(headroomArgs({ ...D, rateLimit: false, rpm: 10, ccr: 'off' })).toEqual(['--no-ccr', '--no-rate-limit'])
    const all = ['smart_crusher', 'kompress', 'code_aware', 'search', 'log', 'tabular', 'config', 'html', 'image']
    expect(headroomArgs({ ...D, compressors: all })).toEqual([])
  })
})

describe('validateHeadroomOptions', () => {
  it('rejects out-of-range values and app-owned flags', () => {
    expect(validateHeadroomOptions({ ...D, targetRatio: 1.5 })).toMatch(/ratio/)
    expect(validateHeadroomOptions({ ...D, rpm: 0 })).toMatch(/requests/)
    expect(validateHeadroomOptions({ ...D, tpm: 1.5 })).toMatch(/tokens/)
    expect(validateHeadroomOptions({ ...D, budgetUsd: 0 })).toMatch(/budget/)
    expect(validateHeadroomOptions({ ...D, compressors: ['zip'] })).toMatch(/zip/)
    expect(validateHeadroomOptions({ ...D, protectToolResults: 'Bash; rm' })).toMatch(/protected/)
    expect(validateHeadroomOptions({ ...D, extraArgs: '--port=1' })).toMatch(/--port/)
    expect(validateHeadroomOptions({ ...D, extraArgs: '-p 1' })).toMatch(/-p/)
    expect(validateHeadroomOptions({ ...D, extraArgs: '"open' })).toMatch(/quote/)
  })
})

describe('splitArgs', () => {
  it('handles quotes and escapes without expanding anything', () => {
    expect(splitArgs(` --a  "b c" 'd $HOME' e\\ f "" `)).toEqual(['--a', 'b c', 'd $HOME', 'e f', ''])
    expect(splitArgs('')).toEqual([])
  })
})

describe('normalizeHeadroomOptions', () => {
  it('fills defaults and ignores wrong types', () => {
    expect(normalizeHeadroomOptions(undefined)).toEqual(D)
    const o = normalizeHeadroomOptions({ mode: 'token', rpm: '5', targetRatio: 0.5, compressors: ['log', 3] })
    expect(o).toMatchObject({ mode: 'token', rpm: null, targetRatio: 0.5, compressors: ['log'] })
  })
})

describe('headroomEnv', () => {
  it('turns off only the upload beacon', () => {
    expect(headroomEnv(D)).toEqual({})
    expect(headroomEnv({ ...D, beacon: false })).toEqual({ HEADROOM_BEACON: 'off' })
  })
})

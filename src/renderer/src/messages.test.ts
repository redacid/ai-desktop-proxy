import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedIndexes, totalChars, viewMessage } from './messages'

const feed = JSON.parse(readFileSync(resolve(__dirname, '../../../examples/headroom-feed.json'), 'utf8'))
const item = feed.transformations[0]

describe('viewMessage', () => {
  it('renders text, tool calls and tool results', () => {
    const views = item.request_messages.map(viewMessage)
    expect(views[0]).toMatchObject({ role: 'user', kinds: ['text'], text: 'Why does the build fail? Check the CI log.' })
    expect(views[1].kinds).toEqual(['text', 'tool_use'])
    expect(views[1].text).toContain('Bash({"command":"cat ci.log"})')
    expect(views[2].kinds).toEqual(['tool_result'])
    expect(views[2].text.split('\n').length).toBeGreaterThan(100)
  })

  it('handles string content, OpenAI tool calls and junk', () => {
    expect(viewMessage({ role: 'system', content: 'be brief' })).toMatchObject({ kinds: ['text'], text: 'be brief' })
    const tool = viewMessage({ role: 'assistant', content: null, tool_calls: [{ function: { name: 'ls', arguments: '{}' } }] })
    expect(tool.kinds).toEqual(['text', 'tool_call'])
    expect(tool.text).toBe('ls({})')
    expect(viewMessage(42)).toMatchObject({ role: 'unknown', text: '42' })
  })
})

describe('changedIndexes', () => {
  it('marks only the messages headroom rewrote', () => {
    const original = item.request_messages.map(viewMessage)
    const sent = item.compressed_messages.map(viewMessage)
    expect([...changedIndexes(original, sent)]).toEqual([2])
    expect(totalChars(sent)).toBeLessThan(totalChars(original))
  })
})

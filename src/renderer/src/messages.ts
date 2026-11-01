/**
 * Turns provider messages (Anthropic / OpenAI chat shape) into something a person can read: one entry per message
 * with its role, block kinds, plain text and size. Pure, so it is unit tested without a DOM.
 */

export interface MessageView {
  role: string
  /** e.g. ["text", "tool_use"] */
  kinds: string[]
  /** Readable text of all blocks; tool calls rendered as `name(input)`. */
  text: string
  /** Size of the JSON form, in characters: what actually crosses the wire. */
  chars: number
  /** JSON form, used to tell whether two copies of a message differ. */
  json: string
}

function blockText(block: unknown): { kind: string; text: string } {
  if (typeof block === 'string') return { kind: 'text', text: block }
  if (!block || typeof block !== 'object') return { kind: 'unknown', text: String(block) }
  const b = block as Record<string, unknown>
  const kind = typeof b.type === 'string' ? b.type : 'unknown'
  if (typeof b.text === 'string') return { kind, text: b.text }
  if (kind === 'tool_use') return { kind, text: `${String(b.name)}(${JSON.stringify(b.input ?? {})})` }
  if (kind === 'tool_result') return { kind, text: contentText(b.content) }
  if (kind === 'thinking' && typeof b.thinking === 'string') return { kind, text: b.thinking }
  if (kind === 'image') return { kind, text: '[image]' }
  return { kind, text: JSON.stringify(block) }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => blockText(c).text).join('\n')
  if (content == null) return ''
  return JSON.stringify(content)
}

export function viewMessage(message: unknown): MessageView {
  const json = JSON.stringify(message) ?? ''
  if (!message || typeof message !== 'object') {
    return { role: 'unknown', kinds: [], text: String(message), chars: json.length, json }
  }
  const m = message as Record<string, unknown>
  const role = typeof m.role === 'string' ? m.role : 'unknown'
  const content = m.content
  const blocks = Array.isArray(content) ? content.map(blockText) : [{ kind: 'text', text: contentText(content) }]
  // OpenAI-style tool calls live next to content
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls as Record<string, unknown>[]) {
      const fn = (call?.function ?? {}) as Record<string, unknown>
      blocks.push({ kind: 'tool_call', text: `${String(fn.name)}(${String(fn.arguments ?? '')})` })
    }
  }
  return {
    role,
    kinds: [...new Set(blocks.map((b) => b.kind))],
    text: blocks.map((b) => b.text).filter((t) => t !== '').join('\n\n'),
    chars: json.length,
    json
  }
}

/** Indexes of messages in `sent` that differ from the same position in `original`. */
export function changedIndexes(original: MessageView[], sent: MessageView[]): Set<number> {
  const changed = new Set<number>()
  sent.forEach((m, i) => {
    if (original[i]?.json !== m.json) changed.add(i)
  })
  return changed
}

export function totalChars(views: MessageView[]): number {
  return views.reduce((n, v) => n + v.chars, 0)
}

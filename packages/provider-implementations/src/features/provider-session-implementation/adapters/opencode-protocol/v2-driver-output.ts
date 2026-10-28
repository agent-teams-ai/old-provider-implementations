import type { EventPayload } from '@agent-teams/provider-session-contracts'
import { record } from './v2-projection-helpers.ts'
import type { OpenCodeV2NativeTurn, OpenCodeV2NativeTurnCut } from './v2-projection-types.ts'

/** Per-turn canonical projection, only after complete native-cut qualification. */
export class OpenCodeV2DriverOutput {
  private readonly text = new Map<string, string>()
  private readonly calls = new Set<string>()
  private readonly results = new Set<string>()
  private readonly emit: (event: EventPayload) => void
  constructor(emit: (event: EventPayload) => void) { this.emit = emit }
  accept(cut: OpenCodeV2NativeTurnCut, turn: OpenCodeV2NativeTurn): void {
    if (turn.state === 'unknown') {return}
    const terminal = turn.state !== 'pending'
    for (const messageRef of turn.assistantMessageIds) {
      const content = cut.messages.data.find(message => message.id === messageRef)?.data.content
      if (!Array.isArray(content)) {throw new Error('invalid_qualified_native_output')}
      for (const [block, raw] of content.entries()) {
        const part = record(raw)
        if (part?.type !== 'text' || typeof part.text !== 'string') {continue}
        const key = messageRef + ':' + block, phase = terminal ? 'complete' : 'snapshot'
        const value = phase + ':' + part.text
        if (this.text.get(key) === value) {continue}
        this.emit({ kind: 'text', messageRef, block, text: part.text, phase }); this.text.set(key, value)
      }
    }
    for (const tool of turn.tools) {
      const toolRef = tool.assistantMessageId + ':' + tool.toolCallId
      if (!this.calls.has(toolRef)) {
        this.emit({ kind: 'tool', messageRef: tool.assistantMessageId, toolRef, name: tool.toolName, input: tool.input })
        this.calls.add(toolRef)
      }
      if (tool.status !== 'running' && !this.results.has(toolRef)) {
        this.emit({ kind: 'tool-result', toolRef, isError: tool.status === 'error', content: tool.status === 'error' ? tool.error : tool.content })
        this.results.add(toolRef)
      }
    }
  }
}

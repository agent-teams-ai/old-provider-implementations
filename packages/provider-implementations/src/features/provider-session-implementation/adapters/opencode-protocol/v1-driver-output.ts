import type { EventPayload } from '@agent-teams/provider-session-contracts'
import type { readV1DriverCut } from './v1-driver-cut.ts'

/** Retains raw native part indices and exact message/tool identity, never product receipts. */
export function createV1DriverOutput() {
  const text = new Map<string, string>(), calls = new Set<string>(), results = new Set<string>()
  return (cut: NonNullable<Awaited<ReturnType<typeof readV1DriverCut>>>): EventPayload[] => {
    const facts: EventPayload[] = []
    for (const [index, raw] of cut.raw.entries()) {
      const message = cut.messages[index]!
      for (const [block, part] of raw.parts.entries()) {
        if (part.type === 'text' && typeof part.text === 'string') {
          const phase = cut.terminal ? 'complete' : 'snapshot', key = message.id + ':' + part.id, value = phase + ':' + part.text
          if (text.get(key) !== value) { facts.push({ kind: 'text', messageRef: message.id!, block, text: part.text, phase }); text.set(key, value) }
        }
      }
      for (const tool of message.toolCalls) {
        if (tool.callId === null || tool.callId.length === 0 || tool.toolName === null || tool.toolName.length === 0 || tool.status === 'unknown') {continue}
        const toolRef = message.id + ':' + tool.callId
        if (!calls.has(toolRef)) { facts.push({ kind: 'tool', messageRef: message.id!, toolRef, name: tool.toolName, input: tool.input }); calls.add(toolRef) }
        if (['completed', 'errored'].includes(tool.status) && !results.has(toolRef)) {
          facts.push({ kind: 'tool-result', toolRef, content: tool.output, isError: tool.isError }); results.add(toolRef)
        }
      }
    }
    return facts
  }
}

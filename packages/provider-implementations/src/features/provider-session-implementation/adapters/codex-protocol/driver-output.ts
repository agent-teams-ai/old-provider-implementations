import type { EventPayload } from '@agent-teams/provider-session-contracts'
import type { CodexNativeNormalizedEvent } from '../../contracts/codex-events.ts'

/** Provider DTOs end here. Raw errors/payloads are never forwarded as diagnostics. */
export function projectDriverEvent(event: CodexNativeNormalizedEvent): EventPayload[] {
  switch (event.type) {
    case 'assistant_text': return [{ kind: 'text', messageRef: event.itemId, block: 0, text: event.text, phase: 'complete' }]
    case 'tool_call_started': return [{ kind: 'tool', messageRef: event.itemId, toolRef: event.itemId,
      name: event.toolSource === 'mcp' ? `mcp__${event.serverName ?? 'unknown'}__${event.toolName}` : event.toolName, input: event.arguments }]
    case 'tool_call_completed': return [{ kind: 'tool-result', toolRef: event.itemId, content: event.rawResult ?? event.resultText, isError: event.isError }]
    case 'usage_updated': return [{ kind: 'usage', ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }) }]
    case 'warning': return [{ kind: 'diagnostic', code: 'provider-failure' }]
    case 'unsupported_raw_event': return [{ kind: 'diagnostic', code: 'unknown-event' }]
    case 'thread_started': case 'turn_started': case 'turn_completed': case 'turn_failed': case 'turn_interrupted':
      return [] // Native completion promise is the single terminal authority.
  }
}

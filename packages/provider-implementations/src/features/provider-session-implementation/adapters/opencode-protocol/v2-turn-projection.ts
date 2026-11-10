import { record, assistantLineage, messageIDFromEvent, terminal } from './v2-projection-helpers.ts'
import { projectNativeAssistants } from './v2-assistant-projection.ts'
import type { OpenCodeV2NativeTurnCut, OpenCodeV2NativeTurn, OpenCodeV2NativeLogEvent } from './v2-projection-types.ts'
const empty = (state: OpenCodeV2NativeTurn['state'], reason: string): OpenCodeV2NativeTurn => ({ state, reason, assistantMessageIds: [], text: '', tools: [] })
const unknown = (reason: string) => empty('unknown', reason)
function logProblem(input: OpenCodeV2NativeTurnCut): string | null {
  const ids = new Set<string>()
  let last = -1
  for (const event of input.log.events) {
    if (event.aggregateID !== input.sessionID || event.data.sessionID !== input.sessionID || ids.has(event.id)
      || !Number.isSafeInteger(event.seq) || event.seq <= last || last >= 0 && event.seq !== last + 1) { return 'foreign_or_incomplete_log' }
    ids.add(event.id); last = event.seq
  }
  return input.log.watermark !== (input.log.events.at(-1)?.seq ?? null) ? 'incomplete_log_watermark' : null
}
function cutProblem(input: OpenCodeV2NativeTurnCut): string | null {
  if (record(input.messages)?.previous !== null || record(input.messages)?.next !== null || record(input.log)?.synced !== true) { return 'incomplete_native_cut' }
  if (!['2.0.0', '2.0.21'].includes(input.pin)) { return 'unqualified_projection_pin' }
  const events = input.log.events
  if (events.at(0)?.seq !== 0 || events.at(0)?.type !== 'session.created') { return 'missing_native_log_prefix' }
  if (events.length > 4096 || input.messages.data.length > 1600 || new Set(input.messages.data.map(message => message.id)).size !== input.messages.data.length) { return 'unbounded_or_duplicate_cut' }
  return logProblem(input)
}
function intervalFor(events: readonly OpenCodeV2NativeLogEvent[], delivered: OpenCodeV2NativeLogEvent) {
  const deliveredAt = events.indexOf(delivered)
  let boundary = -1
  for (const [index, event] of events.entries()) { if (index < deliveredAt && terminal(event)) { boundary = index } }
  const end = events.findIndex((event, index) => index > deliveredAt && terminal(event))
  const interval = events.slice(boundary + 1, end < 0 ? undefined : end + 1)
  if (interval.filter(event => event.type === 'session.inbox.delivered').length !== 1) { return { problem: 'ambiguous_delivered_input_lineage' } as const }
  const starts = interval.filter(event => event.type === 'session.execution.started')
  if (starts.length !== 1 || interval.some(event => event.type === 'session.step.started' && event.seq < delivered.seq)) { return { problem: 'execution_interval_lineage_missing' } as const }
  const assistants = assistantLineage(interval)
  if (!assistants || events.some(event => event.type === 'session.step.started' && assistants.includes(event.data.assistantMessageID as string) && !interval.includes(event))) { return { problem: 'ambiguous_assistant_lineage' } as const }
  return { interval, end, assistants }
}
function terminalProjection(input: OpenCodeV2NativeTurnCut, ending: OpenCodeV2NativeLogEvent, assistants: readonly string[]): string {
  const state = ending.type === 'session.execution.succeeded' ? 'succeeded' : ending.type === 'session.execution.failed' ? 'failed' : 'cancelled'
  if (state === 'succeeded' && assistants.length === 0) { return 'no_assistant_terminal_lineage' }
  // Current emits idle except native shutdown; floor omits idle (both pins audited).
  if (input.pin === '2.0.21' && !(state === 'cancelled' && ending.data.reason === 'shutdown')) {
    const idle = input.messages.data.find(message => message.id === messageIDFromEvent(ending.id))
    if (!idle || idle.type !== 'idle' || idle.data.outcome !== (state === 'cancelled' ? 'interrupted' : state)) { return 'terminal_snapshot_mismatch' }
  }
  return state
}
function deliveredTurn(input: OpenCodeV2NativeTurnCut, delivered: OpenCodeV2NativeLogEvent): OpenCodeV2NativeTurn {
  const user = input.messages.data.find(message => message.id === input.nativeInputID)
  if (!user || user.type !== 'user' || user.data.id !== input.nativeInputID || user.data.type !== 'user' || user.data.text !== input.originalText) { return unknown('original_input_projection_mismatch') }
  const scope = intervalFor(input.log.events, delivered)
  if ('problem' in scope) { return unknown(scope.problem) }
  const { interval, end, assistants } = scope
  const projected = projectNativeAssistants(input, interval, assistants, end >= 0)
  if (projected.kind === 'unknown') { return unknown(projected.reason) }
  if (interval.some(event => typeof event.data.assistantMessageID === 'string' && !assistants.includes(event.data.assistantMessageID))) { return unknown('foreign_assistant_event') }
  const facts = { assistantMessageIds: assistants, text: projected.text.join('\n'), tools: projected.tools }
  if (end < 0) { return { state: 'pending', reason: 'no_execution_terminal', ...facts } }
  const ending = input.log.events.at(end)
  if (!ending) { return unknown('missing_execution_terminal') }
  const state = terminalProjection(input, ending, assistants)
  if (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') { return unknown(state) }
  return { state, reason: ending.type, ...facts }
}
/** Native turn facts only. No product message/task receipt inference or writer. */
export function projectOpenCodeV2NativeTurn(input: OpenCodeV2NativeTurnCut): OpenCodeV2NativeTurn {
  const problem = cutProblem(input)
  if (problem !== null) { return unknown(problem) }
  const after = input.beforeCursor ?? -1
  const deliveries = input.log.events.filter(event => event.seq > after && event.type === 'session.inbox.delivered' && event.data.inboxID === input.nativeInputID)
  const cancellations = input.log.events.filter(event => event.seq > after && event.type === 'session.inbox.cancelled' && event.data.inboxID === input.nativeInputID)
  if (deliveries.length === 0) { return cancellations.length === 1 ? empty('cancelled', 'original_inbox_cancelled') : cancellations.length > 1 ? unknown('ambiguous_input_disposition') : empty('pending', 'input_not_delivered') }
  if (deliveries.length !== 1 || cancellations.length !== 0) { return unknown('ambiguous_input_disposition') }
  const delivered = deliveries.at(0)
  return delivered ? deliveredTurn(input, delivered) : unknown('missing_original_delivery')
}

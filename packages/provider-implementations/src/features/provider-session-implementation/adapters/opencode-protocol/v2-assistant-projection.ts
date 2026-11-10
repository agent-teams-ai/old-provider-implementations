import { record, string, same } from './v2-projection-helpers.ts'
import type { OpenCodeV2NativeLogEvent, OpenCodeV2NativeTurnCut, OpenCodeV2NativeToolFact } from './v2-projection-types.ts'
type UnknownProjection = { kind: 'unknown'; reason: string }
const reject = (reason: string): UnknownProjection => ({ kind: 'unknown', reason })
const sequence = (events: readonly OpenCodeV2NativeLogEvent[], fallback: number) => events.at(0)?.seq ?? fallback
function toolCallEvents(related: readonly OpenCodeV2NativeLogEvent[], toolId: string, name: string, state: Record<string, unknown>) {
  const events = related.filter(event => event.data.id === toolId)
  const started = events.filter(event => event.type === 'session.tool.input.started')
  const called = events.filter(event => event.type === 'session.tool.called')
  const call = called.at(0)
  if (started.length !== 1 || started.at(0)?.data.name !== name || called.length !== 1
    || !same(call?.data.input, state.input) || typeof call?.data.executed !== 'boolean'
    || sequence(started, Infinity) >= sequence(called, -1)) { return null }
  return { called, successes: events.filter(event => event.type === 'session.tool.success'), failures: events.filter(event => event.type === 'session.tool.failed') }
}
function projectTool(part: Record<string, unknown>, related: readonly OpenCodeV2NativeLogEvent[], assistantId: string, ended: boolean): OpenCodeV2NativeToolFact | UnknownProjection {
  const toolId = string(part.id), name = string(part.name), state = record(part.state)
  if (toolId === null || name === null || state === null) { return reject('invalid_tool_snapshot') }
  const events = toolCallEvents(related, toolId, name, state)
  if (!events) { return reject('tool_call_lineage_mismatch') }
  const { called, successes, failures } = events
  const base = { assistantMessageId: assistantId, toolCallId: toolId, toolName: name, input: state.input }
  if (state.status === 'streaming' || state.status === 'running') {
    if (ended || successes.length !== 0 || failures.length !== 0) { return reject('unsettled_tool_at_execution_terminal') }
    return { ...base, status: 'running', executed: null, content: null, error: null, metadata: null }
  }
  const executed = typeof part.executed === 'boolean' ? part.executed : null, metadata = state.metadata ?? null
  if (state.status === 'error') {
    if (failures.length !== 1 || successes.length !== 0 || !same(failures.at(0)?.data.error, state.error)
      || sequence(called, Infinity) >= sequence(failures, -1)) { return reject('tool_failure_snapshot_mismatch') }
    return { ...base, status: 'error', executed, content: null, error: state.error, metadata }
  }
  if (!validToolSuccess(state, part, called, successes, failures)) { return reject('tool_success_snapshot_mismatch') }
  return { ...base, status: 'completed', executed, content: state.content, error: null, metadata }
}
function validToolSuccess(state: Record<string, unknown>, part: Record<string, unknown>, called: readonly OpenCodeV2NativeLogEvent[], successes: readonly OpenCodeV2NativeLogEvent[], failures: readonly OpenCodeV2NativeLogEvent[]): state is Record<string, unknown> & { content: readonly unknown[] } {
  return state.status === 'completed' && successes.length === 1 && failures.length === 0 && Array.isArray(state.content)
    && state.content.length > 0 && same(successes.at(0)?.data.content, state.content) && successes.at(0)?.data.executed === part.executed
    && sequence(called, Infinity) < sequence(successes, -1)
}
function assistantProblem(message: OpenCodeV2NativeTurnCut['messages']['data'][number], related: readonly OpenCodeV2NativeLogEvent[], ended: boolean): string | null {
  const stepEnds = related.filter(event => event.type === 'session.step.ended' || event.type === 'session.step.failed')
  if (ended && stepEnds.length !== 1) { return 'missing_step_terminal' }
  if (stepEnds.length > 1) { return 'ambiguous_step_terminal' }
  const completed = record(message.data.time)?.completed
  if (ended && (typeof completed !== 'number' || !Number.isFinite(completed) || completed < message.timeCreated)) { return 'incomplete_assistant_snapshot' }
  const content = message.data.content as unknown[]
  const ids = content.map(record).filter(part => part?.type === 'tool').map(part => part?.id)
  if (new Set(ids).size !== ids.length) { return 'duplicate_tool_snapshot' }
  const end = stepEnds.at(0)
  if (end && (end.type === 'session.step.ended' ? message.data.finish !== end.data.finish : !same(message.data.error, end.data.error))) { return 'step_terminal_snapshot_mismatch' }
  return null
}
function projectContent(content: readonly unknown[], related: readonly OpenCodeV2NativeLogEvent[], assistantId: string, ended: boolean) {
  const text: string[] = [], tools: OpenCodeV2NativeToolFact[] = []
  for (const raw of content) {
    const part = record(raw)
    if (!part) { return reject('invalid_assistant_content') }
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || !related.some(event => event.type === 'session.text.ended' && event.data.text === part.text)) { return reject('text_snapshot_mismatch') }
      text.push(part.text); continue
    }
    if (part.type !== 'tool') { continue }
    const tool = projectTool(part, related, assistantId, ended)
    if ('kind' in tool) { return tool }
    tools.push(tool)
  }
  const ids = new Set(content.map(record).filter(part => part?.type === 'tool').map(part => part?.id))
  if (related.some(event => event.type.startsWith('session.tool.') && !ids.has(event.data.id))) { return reject('tool_event_missing_snapshot') }
  return { kind: 'known' as const, text, tools }
}
export function projectNativeAssistants(input: OpenCodeV2NativeTurnCut, interval: readonly OpenCodeV2NativeLogEvent[], assistants: readonly string[], ended: boolean) {
  const text: string[] = [], tools: OpenCodeV2NativeToolFact[] = []
  for (const assistantId of assistants) {
    const message = input.messages.data.find(item => item.id === assistantId)
    if (!message || message.type !== 'assistant' || message.data.type !== 'assistant' || message.data.id !== assistantId || !Array.isArray(message.data.content)) { return reject('assistant_snapshot_lineage_mismatch') }
    const related = interval.filter(event => event.data.assistantMessageID === assistantId)
    const problem = assistantProblem(message, related, ended)
    if (problem !== null) { return reject(problem) }
    const projection = projectContent(message.data.content, related, assistantId, ended)
    if (projection.kind === 'unknown') { return projection }
    text.push(...projection.text); tools.push(...projection.tools)
  }
  return { kind: 'known' as const, text, tools }
}

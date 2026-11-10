import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import type { OpenCodeV2NativeLogEvent } from './v2-projection-types.ts'

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
export const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
export const terminal = (event: OpenCodeV2NativeLogEvent): boolean =>
  ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)
export const messageIDFromEvent = (id: string): string => id.replace(/^evt_/, 'msg_')
export const same = (left: unknown, right: unknown): boolean => {
  try { return canonicalExecutionJSON(left) === canonicalExecutionJSON(right) } catch { return false }
}
function validAssistantRetry(previous: { event: OpenCodeV2NativeLogEvent; index: number; count: number }, event: OpenCodeV2NativeLogEvent, interval: readonly OpenCodeV2NativeLogEvent[], index: number): boolean {
  const retry = interval.at(index - 1), error = record(retry?.data.error)
  return previous.index === index - 2 && retry?.type === 'session.retry.scheduled'
    && retry.data.assistantMessageID === event.data.assistantMessageID && retry.data.attempt === previous.count + 1
    && Number.isSafeInteger(retry.data.at) && (retry.data.at as number) >= 0
    && error !== null && typeof error.type === 'string' && typeof error.message === 'string'
    && same(event.data.agent, previous.event.data.agent) && same(event.data.model, previous.event.data.model)
}
export function assistantLineage(interval: readonly OpenCodeV2NativeLogEvent[]): string[] | null {
  const starts = new Map<string, { event: OpenCodeV2NativeLogEvent; index: number; count: number }>()
  const retries = new Set<number>()
  for (const [index, event] of interval.entries()) {
    if (event.type !== 'session.step.started') {continue}
    const id = string(event.data.assistantMessageID)
    if (id === null) {return null}
    const previous = starts.get(id)
    if (previous) {
      if (!validAssistantRetry(previous, event, interval, index)) { return null }
      retries.add(index - 1)
    }
    starts.set(id, { event, index, count: (previous?.count ?? 0) + 1 })
  }
  if (interval.some((event, index) => event.type === 'session.retry.scheduled' && !retries.has(index))) {return null}
  return [...starts.keys()]
}

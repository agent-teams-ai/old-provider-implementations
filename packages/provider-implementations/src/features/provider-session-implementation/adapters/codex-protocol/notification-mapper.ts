import type { CodexNativeNormalizedEvent } from '../../contracts/codex-events.ts'
import { CodexProtocolError } from './rpc-types.ts'
import { record, string } from './wire-frames.ts'
import { mapThreadItemToToolStarted, mapThreadItemToToolCompleted } from './notification-items.ts'

function consistentId(direct: unknown, nested: unknown): string | null {
  if ((direct !== undefined && string(direct) === null) || (nested !== undefined && string(nested) === null)) {return null}
  if (direct !== undefined && nested !== undefined && direct !== nested) {return null}
  return string(direct) ?? string(nested)
}

export function nativeThreadId(params: Record<string, unknown>): string | null {
  return consistentId(params.threadId, record(params.thread)?.id)
}

export function nativeTurnId(params: Record<string, unknown>): string | null {
  return consistentId(params.turnId, record(params.turn)?.id)
}

function usageEvent(params: Record<string, unknown>): CodexNativeNormalizedEvent[] {
  const usage = record(record(params.tokenUsage)?.last)
  if (!usage) {return []}
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const
  const event: Extract<CodexNativeNormalizedEvent, { type: 'usage_updated' }> = { type: 'usage_updated' }
  for (const field of fields) {
    const value = usage[field]
    if (value === undefined) {continue}
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return [{ type: 'unsupported_raw_event', rawType: 'thread/tokenUsage/updated:invalid-usage', payload: params }]
    }
    event[field] = value
  }
  return Object.keys(event).length > 1 ? [event] : []
}

export function nativeTurnOutcome(params: Record<string, unknown>): 'completed' | 'failed' | 'interrupted' | 'unknown' {
  const status = string(record(params.turn)?.status)
  return status === 'completed' || status === 'failed' || status === 'interrupted' ? status : 'unknown'
}

export function nativeTurnError(params: Record<string, unknown>): string | undefined {
  const error = record(record(params.turn)?.error)
  return string(error?.message) ?? string(error?.additionalDetails) ?? undefined
}
function terminalEvent(params: Record<string, unknown>): CodexNativeNormalizedEvent {
  const outcome = nativeTurnOutcome(params), turnId = nativeTurnId(params), errorMessage = nativeTurnError(params)
  const identity = turnId !== null ? { turnId } : {}
  switch (outcome) {
    case 'completed': return { type: 'turn_completed', ...identity }
    case 'failed': return { type: 'turn_failed', ...identity, ...(errorMessage !== undefined ? { errorMessage } : {}) }
    case 'interrupted': return { type: 'turn_interrupted', ...identity }
    case 'unknown': return { type: 'unsupported_raw_event', rawType: 'turn/completed:unknown-outcome', payload: params }
  }
}

/** One mapper per confirmed native turn; state is discarded on terminal/transport loss. */
export class CodexNotificationMapper {
  private readonly text = new Map<string, string>()
  private readonly completed = new Set<string>()
  private usage: CodexNativeNormalizedEvent[] = []
  private bytes = 0

  private readonly maxTextBytes: number
  private readonly maxItems: number

  constructor(maxTextBytes = 1_048_576, maxItems = 256) {
    this.maxTextBytes = maxTextBytes
    this.maxItems = maxItems
  }

  map(method: string, params: Record<string, unknown>): CodexNativeNormalizedEvent[] {
    const item = record(params.item) ?? {}
    const itemId = string(params.itemId) ?? string(item.id)
    if (method === 'item/agentMessage/delta') {
      return this.appendDelta(itemId, params)
    }
    if (method === 'item/completed' && item.type === 'agentMessage') {
      return this.completeText(itemId, item, params)
    }
    if (method === 'thread/tokenUsage/updated') {
      const events = usageEvent(params)
      if (!this.text.size) {return events}
      this.usage = events // Native `last` is a turn snapshot, not a usage increment.
      return []
    }
    if (method === 'turn/completed') {
      return [...this.flushPending(), terminalEvent(params)]
    }
    if (method === 'turn/started') {
      const turnId = nativeTurnId(params)
      return [{ type: 'turn_started', ...(turnId !== null ? { turnId } : {}) }]
    }
    if (method === 'item/started' || method === 'item/completed') {
      const event = method === 'item/started' ? mapThreadItemToToolStarted(item) : mapThreadItemToToolCompleted(item)
      return event ? [event] : this.unsupported(method, params)
    }
    if (method === 'warning' || method === 'error') {
      const text = string(params.message) ?? string(record(params.error)?.message)
      return text !== null ? [{ type: 'warning', source: 'codex', text }] : this.unsupported(method, params)
    }
    return this.unsupported(method, params)
  }
  private appendDelta(itemId: string | null, params: Record<string, unknown>): CodexNativeNormalizedEvent[] {
    if (itemId === null || typeof params.delta !== 'string') {return this.unsupported('item/agentMessage/delta', params)}
    if (this.completed.has(itemId)) {return []}
    this.bytes += new TextEncoder().encode(params.delta).byteLength
    if (this.bytes > this.maxTextBytes || (!this.text.has(itemId) && this.text.size + this.completed.size >= this.maxItems)) {
      throw new CodexProtocolError('codex.protocol.text-limit')
    }
    this.text.set(itemId, (this.text.get(itemId) ?? '') + params.delta)
    return []
  }
  private completeText(itemId: string | null, item: Record<string, unknown>, params: Record<string, unknown>): CodexNativeNormalizedEvent[] {
    if (itemId === null) {return this.unsupported('item/completed', params)}
    if (this.completed.has(itemId)) {return []}
    const text = typeof item.text === 'string' ? item.text : this.text.get(itemId)
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.maxTextBytes) {throw new CodexProtocolError('codex.protocol.text-limit')}
    this.text.delete(itemId); this.completed.add(itemId)
    if (this.completed.size > this.maxItems) {throw new CodexProtocolError('codex.protocol.item-limit')}
    return [...(text === undefined ? [] : [{ type: 'assistant_text' as const, itemId, text }]), ...this.flushUsage()]
  }

  flushPending(): CodexNativeNormalizedEvent[] {
    const events: CodexNativeNormalizedEvent[] = []
    for (const [itemId, text] of this.text) {events.push({ type: 'assistant_text', itemId, text })}
    this.text.clear()
    return [...events, ...this.flushUsage()]
  }

  private flushUsage(): CodexNativeNormalizedEvent[] {
    if (this.text.size) {return []}
    const events = this.usage
    this.usage = []
    return events
  }

  private unsupported(method: string, params: Record<string, unknown>): CodexNativeNormalizedEvent[] {
    return [{ type: 'unsupported_raw_event', rawType: method, payload: params }]
  }
}

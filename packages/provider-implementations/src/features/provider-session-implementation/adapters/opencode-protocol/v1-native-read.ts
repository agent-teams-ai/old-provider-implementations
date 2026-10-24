import type { OpenCodeClient } from './client-types.ts'
import type { OpenCodeMessage } from './types.ts'
import { record } from './v2-projection-helpers.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'

type WindowIdentities = { ids: Set<string>; parts: Set<string>; calls: Set<string> }
function validatePart(part: OpenCodeMessage['parts'][number], sessionId: string, messageId: string, seen: WindowIdentities): void {
  if (typeof part.id !== 'string' || !part.id.startsWith('prt_') || seen.parts.has(part.id) || part.sessionID !== sessionId
    || part.messageID !== messageId || typeof part.type !== 'string') { throw new Error('foreign_or_duplicate_native_part') }
  seen.parts.add(part.id)
  if (part.type !== 'tool') { return }
  if (typeof part.callID !== 'string' || part.callID.length === 0 || seen.calls.has(part.callID)) { throw new Error('duplicate_native_tool') }
  seen.calls.add(part.callID)
}
function validateMessage(value: OpenCodeMessage, sessionId: string, seen: WindowIdentities): void {
  const info = record(value.info)
  if (!info || typeof info.id !== 'string' || !info.id.startsWith('msg_') || seen.ids.has(info.id)
    || info.sessionID !== sessionId || !['user', 'assistant'].includes(String(info.role)) || !Array.isArray(value.parts)) { throw new Error('foreign_or_duplicate_native_message') }
  seen.ids.add(info.id)
  if (info.role === 'assistant' && (typeof info.parentID !== 'string' || !info.parentID.startsWith('msg_'))) { throw new Error('missing_native_parent') }
  if (['parent', 'parentId'].some(key => info[key] !== undefined && info[key] !== info.parentID)) { throw new Error('conflicting_native_parent') }
  for (const part of value.parts) { validatePart(part, sessionId, info.id, seen) }
}
/** Native V1 latest-window pagination, preserving original message/part IDs and parent links. */
export async function readV1Window(client: OpenCodeClient, sessionId: string, anchor?: string): Promise<OpenCodeMessage[]> {
  const seen: WindowIdentities = { ids: new Set(), parts: new Set(), calls: new Set() }
  const messages: OpenCodeMessage[] = []
  let before: string | undefined
  for (let page = 0; page < 4; page++) {
    const values = await client.getSessionMessages(sessionId, 50, before)
    if (!Array.isArray(values) || values.length > 50) { throw new Error('invalid_native_window') }
    for (const value of values) { validateMessage(value, sessionId, seen) }
    messages.unshift(...values)
    if (anchor === undefined || anchor.length === 0 || values.some(value => value.info.id === anchor && value.info.role === 'user') || values.length < 50) { return messages }
    const oldest = values[0]?.info.id
    if (typeof oldest !== 'string' || oldest === before) { throw new Error('native_pagination_cycle') }
    before = oldest
  }
  throw new Error('native_window_budget')
}
export function sameV1Window(a: unknown, b: unknown): boolean { return canonicalExecutionJSON(a) === canonicalExecutionJSON(b) }

import { record, string } from './v2-projection-helpers.ts'
import type { OpenCodeV2NativeLogEvent, OpenCodeV2NativeMessage } from './v2-projection-types.ts'

function requireCut(value: boolean, code: string): asserts value { if (!value) {throw new Error(code)} }
function position(value: unknown): number {
  requireCut(Number.isSafeInteger(value) && Number(value) >= 0, 'invalid_native_position')
  return value as number
}
function text(value: unknown): string {
  requireCut(typeof value === 'string' && value.length > 0 && value.length <= 4096, 'invalid_native_identity')
  return value
}
export function decodeV2Session(value: unknown, sessionID: string, directory: string) {
  const raw = record(value), location = record(raw?.location), time = record(raw?.time)
  requireCut(raw?.id === sessionID && location?.directory === directory, 'native_session_binding_mismatch')
  const model = record(raw.model)
  requireCut(model !== null && string(model.providerID) !== null && string(model.id) !== null, 'invalid_native_model')
  return { id: sessionID, directory, agent: text(raw.agent), model, timeCreated: position(time?.created) }
}
export function decodeV2MessagePage(value: unknown, sessionID: string) {
  const raw = record(value), cursor = record(raw?.cursor)
  requireCut(raw !== null && cursor !== null && Array.isArray(raw.data) && raw.data.length <= 200, 'invalid_native_page')
  const data: OpenCodeV2NativeMessage[] = raw.data.map((native: unknown) => {
    const row = record(native), time = record(row?.time)
    requireCut(row !== null && (row.sessionID === undefined || row.sessionID === sessionID), 'foreign_native_message')
    return { id: text(row.id), type: text(row.type), timeCreated: position(time?.created), data: row }
  })
  requireCut(new Set(data.map(row => row.id)).size === data.length, 'duplicate_native_messages')
  return { data, previous: (cursor.previous === null || cursor.previous === undefined) ? null : text(cursor.previous), next: (cursor.next === null || cursor.next === undefined) ? null : text(cursor.next) }
}
function nativeLogEvent(raw: Record<string, unknown>, sessionID: string, directory: string, progress: { previous: number; ids: ReadonlySet<string>; count: number }): OpenCodeV2NativeLogEvent {
  const { previous, ids, count } = progress
  const durable = record(raw.durable), body = record(raw.data), location = raw.location === undefined ? null : record(raw.location)
  requireCut(durable?.aggregateID === sessionID && body?.sessionID === sessionID && (raw.location === undefined || location?.directory === directory), 'foreign_native_log')
  const seq = position(durable.seq), id = text(raw.id), type = text(raw.type)
  requireCut(type.startsWith('session.') && seq > previous && (previous < 0 || seq === previous + 1) && !ids.has(id) && count < 4096, 'incomplete_native_log')
  return { id, type, aggregateID: sessionID, seq, data: body }
}
export function decodeV2Log(source: string, sessionID: string, directory: string) {
  const events: OpenCodeV2NativeLogEvent[] = [], ids = new Set<string>()
  let synced = false, watermark: number | null = null, previous = -1
  const frames = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
  requireCut(frames.at(-1) === '' && frames.length <= 4098, 'incomplete_native_log')
  for (const frame of frames) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) {continue}
    const raw = record(JSON.parse(data) as unknown)
    requireCut(raw !== null && !synced, 'incomplete_native_log')
    if (raw.type === 'log.synced') {
      requireCut(raw.aggregateID === sessionID, 'foreign_native_log')
      watermark = raw.seq === undefined ? null : position(raw.seq)
      requireCut(watermark === (previous < 0 ? null : previous), 'incomplete_native_log')
      synced = true; continue
    }
    const event = nativeLogEvent(raw, sessionID, directory, { previous, ids, count: events.length })
    ids.add(event.id); previous = event.seq; events.push(event)
  }
  requireCut(synced && events.at(0)?.seq === 0 && events.at(0)?.type === 'session.created', 'incomplete_native_log')
  return { events, synced: true as const, watermark }
}

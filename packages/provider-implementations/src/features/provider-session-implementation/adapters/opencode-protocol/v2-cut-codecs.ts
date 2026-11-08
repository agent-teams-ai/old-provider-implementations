import { record, string } from './v2-projection-helpers.ts'
import { checkOpenCodeReadJson } from './v2-json-budget.ts'
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
/** Both pinned V2 server versions return an exact { data } envelope on these routes. */
export function decodeV2DataEnvelope(value: unknown): unknown {
  const envelope = record(value)
  requireCut(envelope !== null && Object.keys(envelope).length === 1 && Object.hasOwn(envelope, 'data'), 'invalid_native_envelope')
  return envelope.data
}
export function decodeV2Session(value: unknown, sessionID: string, directory: string) {
  const raw = record(decodeV2DataEnvelope(value)), location = record(raw?.location), time = record(raw?.time)
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
  // The native bus sequence includes filtered non-session durable events; gaps are valid.
  requireCut(type.startsWith('session.') && seq > previous && !ids.has(id) && count < 4096, 'incomplete_native_log')
  return { id, type, aggregateID: sessionID, seq, data: body }
}
export function decodeV2Log(source: string, sessionID: string, directory: string) {
  // The public decoder also receives injected read transports. Enforce the
  // execution wire's body bound before splitting/parsing native SSE.
  requireCut(Buffer.byteLength(source) <= 8 * 1024 * 1024, 'incomplete_native_log')
  const events: OpenCodeV2NativeLogEvent[] = [], ids = new Set<string>()
  let synced = false, watermark: number | null = null, previous = -1
  const frames = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
  requireCut(frames.at(-1) === '' && frames.length <= 4098, 'incomplete_native_log')
  for (const frame of frames) {
    const lines = frame.split('\n')
    // Only SSE comments/blank keep-alives are non-events. An unsupported
    // directive or empty data frame cannot silently hide native log evidence.
    requireCut(lines.every(line => line === '' || line.startsWith(':') || line.startsWith('data:')), 'incomplete_native_log')
    const dataLines = lines.filter(line => line.startsWith('data:'))
    if (dataLines.length === 0) {continue}
    const data = dataLines.map(line => line.slice(5).replace(/^ /, '')).join('\n')
    requireCut(data.length > 0 && Buffer.byteLength(data) <= 256 * 1024, 'incomplete_native_log')
    // JSON.parse diagnostics can quote native SSE bytes (including secrets).
    // The public decoder must only expose a fixed refusal code.
    let raw: ReturnType<typeof record>
    try { checkOpenCodeReadJson(data); raw = record(JSON.parse(data) as unknown) }
    catch { throw new Error('incomplete_native_log') }
    requireCut(raw !== null && !synced, 'incomplete_native_log')
    if (raw.type === 'log.synced') {
      requireCut(raw.aggregateID === sessionID, 'foreign_native_log')
      watermark = raw.seq === undefined ? null : position(raw.seq)
      // The synchronization watermark may include filtered bus events beyond the final session event.
      requireCut(watermark !== null && watermark >= previous, 'incomplete_native_log')
      synced = true; continue
    }
    const event = nativeLogEvent(raw, sessionID, directory, { previous, ids, count: events.length })
    ids.add(event.id); previous = event.seq; events.push(event)
  }
  // Pinned native V2.0.21 emits only an owned log.synced frame on a fresh
  // session, before first execution. No synthetic session.created is implied.
  // Keep the stronger known prefix rule for non-empty history until a real
  // post-execution native turn is separately qualified.
  requireCut(synced && (events.length === 0 ||
    (events[0]?.seq === 0 && events[0]?.type === 'session.created')), 'incomplete_native_log')
  return { events, synced: true as const, watermark }
}

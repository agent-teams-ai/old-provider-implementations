import { createV2ControlWire } from './v2-control-transport.ts'
import type { OpenCodeV2SessionControlConfig } from './v2-control-transport.ts'
import { ExecutionTransportFailure, unsubmitted } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { decodeV2DataEnvelope } from './v2-cut-codecs.ts'
import { safeV2MessageID } from './v2-native-identifiers.ts'

export type OpenCodeV2Permission = Readonly<{
  requestId: string; sessionId: string; action: string; resources: readonly string[]
  source?: { type: 'tool'; messageID: string; id: string }
}>
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {throw new Error('invalid_native_control_response')}
  return value
}
// Both pinned V2 versions brand pending permission IDs with the `per` prefix.
// Bound to the session route's safe single-segment alphabet before any grant.
const nativePermissionId = /^per[A-Za-z0-9_-]{1,253}$/
function denyUnsubmitted(): never {
  const failure = new ExecutionTransportFailure('invalid_input', 'not_submitted')
  unsubmitted.add(failure)
  throw failure
}
function permission(value: unknown, sessionId: string): OpenCodeV2Permission {
  const raw = record(value)
  if (!raw || raw.sessionID !== sessionId || !Array.isArray(raw.resources) || raw.resources.length > 256) {throw new Error('foreign_native_permission')}
  const requestId = text(raw.id)
  if (!nativePermissionId.test(requestId)) {throw new Error('invalid_native_permission_id')}
  const result: { requestId: string; sessionId: string; action: string; resources: string[]; source?: NonNullable<OpenCodeV2Permission['source']> } = {
    requestId, sessionId, action: text(raw.action), resources: raw.resources.map(text),
  }
  if (raw.source !== undefined) {
    const source = record(raw.source)
    if (!source || source.type !== 'tool') {throw new Error('invalid_native_permission_source')}
    result.source = { type: 'tool', messageID: text(source.messageID), id: text(source.id) }
  }
  return result
}

/** Caller runtime owns current interaction/generation authority. GET+POST is not an atomic grant fence. */
export function createOpenCodeV2SessionControl(config: OpenCodeV2SessionControlConfig) {
  const version = config.version, sessionId = config.nativeSessionId, wire = createV2ControlWire(config)
  const path = `/api/session/${encodeURIComponent(sessionId)}`
  const entries = version === '2.0.0' ? path + '/instructions/entries' : `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries`
  return {
    check: wire.check,
    dispose: wire.dispose,
    interrupt: async () => {
      const response = await wire.request(path + `/interrupt?${version === '2.0.0' ? 'continue' : 'resume'}=false`, { method: 'POST' })
      const body = record(await response.json() as unknown)
      if (typeof body?.interrupted !== 'boolean') {throw new Error('invalid_native_interrupt_receipt')}
      return { interrupted: body.interrupted }
    },
    cancelInbox: async (inboxId: string) => {
      if (!safeV2MessageID(inboxId)) denyUnsubmitted()
      await wire.request(path + `/inbox/${encodeURIComponent(inboxId)}`, { method: 'DELETE' })
    },
    pendingPermissions: async (): Promise<readonly OpenCodeV2Permission[]> => {
      const body: unknown = decodeV2DataEnvelope(await (await wire.request(path + '/permission')).json() as unknown)
      if (!Array.isArray(body) || body.length > 4096) {throw new Error('invalid_native_permission_list')}
      const values = body.map(raw => permission(raw, sessionId))
      if (new Set(values.map(value => value.requestId)).size !== values.length) {throw new Error('duplicate_native_permission')}
      return values
    },
    replyPermission: async (requestId: string, decision: 'once' | 'always' | 'reject') => {
      // V2 `always` writes a durable project-scoped approval pattern. Until Host
      // owns and proves that mutation, reject it before even reading native state.
      if (!nativePermissionId.test(requestId) || (decision !== 'once' && decision !== 'reject')) denyUnsubmitted()
      const requestPath = path + `/permission/${encodeURIComponent(requestId)}`
      try {
        const current = permission(decodeV2DataEnvelope(await (await wire.request(requestPath)).json() as unknown), sessionId)
        if (current.requestId !== requestId) {throw new Error('native_permission_identity_mismatch')}
      } catch {
        // This method's grant POST has not begun; a failed read cannot have granted permission.
        const failure = new ExecutionTransportFailure('native_permission_preflight', 'not_submitted')
        unsubmitted.add(failure); throw failure
      }
      const key = version === '2.0.0' ? 'reply' : 'decision'
      await wire.request(requestPath + '/reply', { method: 'POST', body: JSON.stringify({ [key]: decision }) })
    },
    putInstruction: async (key: string, value: unknown) => {
      // URL encoding does not escape '.' or '..'; reject non-canonical keys before PUT.
      if (!/^[a-z0-9][a-z0-9._-]{0,255}$/.test(key)) denyUnsubmitted()
      const encoded = canonicalExecutionJSON(value)
      if (Buffer.byteLength(encoded) > 256 * 1024) {throw new Error('native_instruction_byte_budget')}
      await wire.request(entries + '/' + encodeURIComponent(key), { method: 'PUT', body: '{"value":' + encoded + '}' })
    },
    instructions: async () => {
      const raw: unknown = decodeV2DataEnvelope(await (await wire.request(entries)).json() as unknown)
      if (!Array.isArray(raw) || raw.length > 256) {throw new Error('invalid_native_instructions')}
      const values = raw.map(value => {
        const entry = record(value), key = text(entry?.key)
        if (!/^[a-z0-9][a-z0-9._-]{0,255}$/.test(key)) {throw new Error('invalid_native_instruction_key')}
        const canonical = canonicalExecutionJSON(entry?.value)
        if (Buffer.byteLength(canonical) > 256 * 1024) {throw new Error('native_instruction_byte_budget')}
        return { key, value: entry?.value }
      })
      if (new Set(values.map(value => value.key)).size !== values.length) {throw new Error('duplicate_native_instruction')}
      return values
    },
  }
}

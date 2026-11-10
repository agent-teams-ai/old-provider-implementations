import type { OpenCodeClient } from './client-types.ts'
import type { OpenCodeV1DriverConfig } from './v1-driver-config.ts'
import { readV1Window, sameV1Window } from './v1-native-read.ts'
import { openCodeTranscriptProjector } from './v1-transcript-projector.ts'
import { normalizeOpenCodePermission } from './v1-permission-normalizer.ts'
import { record } from './v2-projection-helpers.ts'
import { qualifyOpenCodeV1BoundTerminalProof } from './terminal-proof.ts'
import type { DriverPermission } from './driver-protocol.ts'
import type { OpenCodeCanonicalMessage } from './canonical-message-types.ts'
import type { OpenCodeMessage } from './types.ts'

export async function verifyV1Session(client: OpenCodeClient, config: OpenCodeV1DriverConfig) {
  const native = await client.getSession(config.nativeSessionId)
  if (native.id !== config.nativeSessionId || native.directory !== config.workspacePath) { throw new Error('native_session_binding_mismatch') }
  return native
}
function sessionOf(value: unknown): unknown {
  const row = record(value), metadata = record(row?.metadata), nested = record(row?.permission)
  const ids = [row?.sessionID, row?.sessionId, row?.session, metadata?.sessionID, metadata?.sessionId, nested?.sessionID, nested?.sessionId].filter(id => id !== undefined)
  return ids.length > 0 && ids.every(id => typeof id === 'string' && id === ids[0]) ? ids[0] : null
}
function nativeStatus(value: unknown): unknown {
  if (typeof value === 'string') { return value }
  const row = record(value)
  if (row === null) { return undefined }
  return row.type !== undefined && row.status !== undefined && row.type !== row.status ? undefined : row.type ?? row.status
}
function selectedNativeStatus(value: unknown, sessionId: string): unknown {
  const statuses = record(value)
  if (statuses === null || Object.values(statuses).some(row => !['idle', 'busy', 'retry'].includes(String(nativeStatus(row))))) { return undefined }
  // Pinned V1 SessionStatus.set(idle) deletes this key; /session/status lists only retained entries.
  // Absence is meaningful only in a valid status map, and never replaces bound terminal proof.
  return Object.hasOwn(statuses, sessionId) ? nativeStatus(statuses[sessionId]) : 'idle'
}
function validOriginalWindow(raw: readonly OpenCodeMessage[], nativeInputID: string, originalText: string): number {
  const anchor = raw.findIndex(value => value.info.id === nativeInputID && value.info.role === 'user')
  if (anchor < 0 || raw[anchor]!.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') !== originalText
    || raw.slice(anchor + 1).some(value => value.info.role !== 'assistant' || value.info.parentID !== nativeInputID)) { return -1 }
  return anchor
}
function canonicalWindow(raw: OpenCodeMessage[], config: OpenCodeV1DriverConfig): OpenCodeCanonicalMessage[] | null {
  const canonical = openCodeTranscriptProjector.projectSessionMessages({ sessionId: config.nativeSessionId, messages: raw }).messages
    .map((value, index) => ({ ...value, finishReason: typeof raw[index]!.info.finish === 'string' ? raw[index]!.info.finish : null }))
  let previous = -1
  for (const value of canonical) {
    if (value.createdAt === null || value.createdAt < previous || value.createdAt < 0) { return null }
    previous = value.createdAt
  }
  return canonical
}
function unsettledPart(part: OpenCodeMessage['parts'][number]): boolean {
  return ['question', 'permission'].includes(String(part.type)) || part.type === 'tool' && !['completed', 'error'].includes(String(record(part.state)?.status))
}
function permissionFact(value: unknown, relevant: readonly OpenCodeCanonicalMessage[], sessionID: string): DriverPermission | null {
  if (sessionOf(value) !== sessionID) { return null }
  const raw = record(value)
  if (raw === null) { return null }
  const normalized = normalizeOpenCodePermission(raw), source = record(raw.tool), requestId = normalized?.requestId
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(requestId) || !source
    || typeof source.messageID !== 'string' || typeof source.callID !== 'string') { return null }
  const message = relevant.find(item => item.id === source.messageID)
  const tool = message?.toolCalls.find(item => item.callId === source.callID && item.status === 'running')
  if (!tool || tool.toolName === null || tool.toolName.length === 0 || tool.input === null) { return null }
  const nested = record(raw.permission)
  if ([raw.id, raw.requestID, raw.requestId, raw.permissionID, raw.permissionId, nested?.id, nested?.requestID, nested?.requestId].some(id => id !== undefined && id !== requestId)
    || [raw.sessionId, raw.session].some(id => id !== undefined && id !== sessionID)) { throw new Error('conflicting_native_permission_identity') }
  return { requestId, tool: tool.toolName, input: tool.input }
}
function qualifiedPermissions(permissions: readonly unknown[], relevant: readonly OpenCodeCanonicalMessage[], sessionID: string): DriverPermission[] {
  const allowed = permissions.map(value => permissionFact(value, relevant, sessionID)).filter((value): value is DriverPermission => value !== null)
  if (new Set(allowed.map(value => value.requestId)).size !== allowed.length) { throw new Error('duplicate_native_permission') }
  return allowed
}
export async function readV1DriverCut(client: OpenCodeClient, questions: () => Promise<unknown>, config: OpenCodeV1DriverConfig, nativeInputID: string, originalText: string) {
  const initialSession = await verifyV1Session(client, config)
  const raw = await readV1Window(client, config.nativeSessionId, nativeInputID)
  const permissions = await client.getPermissions(), pendingQuestions = await questions(), status = await client.getSessionStatus()
  if (!Array.isArray(permissions) || !Array.isArray(pendingQuestions) || permissions.length > 256 || pendingQuestions.length > 256) { throw new Error('invalid_native_interactions') }
  const confirmed = await readV1Window(client, config.nativeSessionId, nativeInputID)
  if (!sameV1Window(raw, confirmed) || !sameV1Window(initialSession, await verifyV1Session(client, config))) { return null }
  const anchor = validOriginalWindow(raw, nativeInputID, originalText)
  if (anchor < 0) { return null }
  const canonical = canonicalWindow(raw, config)
  if (!canonical) { return null }
  const relevant = canonical.slice(anchor + 1)
  if (relevant.some(message => message.providerId !== config.model.providerID || message.modelId !== config.model.modelID)) { return null }
  const owns = (value: unknown) => sessionOf(value) === null || sessionOf(value) === config.nativeSessionId
  const unsettled = permissions.some(owns) || pendingQuestions.some(owns) || raw.slice(anchor).some(value => value.parts.some(unsettledPart))
  const evidence = { authority: { hostKey: config.trustedBinding, runId: config.runBinding, profileRootKey: config.profileBinding, projectPath: config.workspacePath },
    sessionId: config.nativeSessionId, messages: canonical, messageSessionIds: raw.map(value => String(value.info.sessionID)), complete: true, interactionsSettled: !unsettled, diagnostics: [] }
  const proof = qualifyOpenCodeV1BoundTerminalProof(evidence, { nativeSessionId: config.nativeSessionId, workspacePath: config.workspacePath,
    hostKey: config.trustedBinding, runId: config.runBinding, profileRootKey: config.profileBinding }, nativeInputID).proof
  const state = selectedNativeStatus(status, config.nativeSessionId)
  const terminal = state === 'idle' && proof ? proof.outcome === 'success' ? 'succeeded' as const : 'cancelled' as const : undefined
  const mayAsk = !terminal && ['busy', 'retry'].includes(String(state)) && relevant.length > 0 && relevant.every(message => !message.hasError)
  return { raw: raw.slice(anchor + 1), messages: relevant, terminal, permissions: mayAsk ? qualifiedPermissions(permissions, relevant, config.nativeSessionId) : [] }
}

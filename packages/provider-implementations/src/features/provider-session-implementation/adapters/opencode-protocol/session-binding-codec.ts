import type { OpenCodeStoredBinding } from './session-binding-types.ts'

export const OPENCODE_BINDING_MAX_BYTES = 32 * 1024 * 1024
export const OPENCODE_CURSOR_MAX_BYTES = 64 * 1024

type ObjectRecord = Record<string, unknown>
export function bindingObject(value: unknown): value is ObjectRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export type OpenCodeBindingEnvelope = ObjectRecord & { schemaVersion: 1; records: ObjectRecord }
export function parseBindingEnvelope(bytes: string): OpenCodeBindingEnvelope | null {
  if (Buffer.byteLength(bytes) > OPENCODE_BINDING_MAX_BYTES) {return null}
  try {
    // Native JSON reviver source allows a conservative veto before an opaque
    // number changes on whole-envelope serialization. Noncanonical numbers also
    // remain untouched rather than guessing that a numeric rewrite is harmless.
    const value: unknown = JSON.parse(bytes, (_key: string, item: unknown, context?: { source?: string }) => {
      if (typeof item === 'number' && context?.source !== JSON.stringify(item)) {throw new Error('Opaque numeric preservation veto')}
      return item
    })
    if (!bindingObject(value) || value.schemaVersion !== 1 || !bindingObject(value.records)
      || Object.hasOwn(value, 'version') || (Object.hasOwn(value, 'generation') && value.generation !== 'v1')) {return null}
    return value as OpenCodeBindingEnvelope
  } catch { return null }
}

/** Preserve the exact existing lane-aware key; pre-lane archives are never selected. */
export function matchesStoredBinding(record: ObjectRecord, binding: OpenCodeStoredBinding): boolean {
  return record.providerId === 'opencode'
    && typeof record.teamId === 'string' && typeof record.memberName === 'string'
    && (record.laneId === undefined || typeof record.laneId === 'string')
    && binding.storageKey === `${record.teamId}::${record.laneId ?? 'primary'}::${record.memberName}`
    && record.opencodeSessionId === binding.nativeSessionId
    && record.projectPath === binding.workspacePath
    && record.hostKey === binding.hostKey && record.runId === binding.runId
    && record.profileRootKey === binding.profileRootKey && record.createdAt === binding.createdAt
    && (record.lastCanonicalCursor === null || typeof record.lastCanonicalCursor === 'string')
    && (record.stoppedAt === undefined || (typeof record.stoppedAt === 'string'
      && Number.isFinite(Date.parse(record.stoppedAt)) && new Date(record.stoppedAt).toISOString() === record.stoppedAt))
}

export function hasBindingFence(store: OpenCodeBindingEnvelope, binding: OpenCodeStoredBinding): boolean {
  for (const name of ['materializationClaims', 'materializationOwners']) {
    if (store[name] !== undefined && !bindingObject(store[name])) {return true}
  }
  const claims = store.materializationClaims as ObjectRecord | undefined
  if (claims && Object.hasOwn(claims, binding.storageKey)) {return true}
  const owners = store.materializationOwners as ObjectRecord | undefined
  const owner = owners && Object.hasOwn(owners, binding.storageKey) ? owners[binding.storageKey] : undefined
  const supplied = binding.materializationOwner
  if (owner === undefined) {return supplied !== undefined}
  return !bindingObject(owner) || !supplied || owner.attemptId !== supplied.attemptId
    || owner.sessionId !== supplied.sessionId || owner.version !== supplied.version
    || supplied.sessionId !== binding.nativeSessionId || !Number.isSafeInteger(supplied.version) || supplied.version < 1
}

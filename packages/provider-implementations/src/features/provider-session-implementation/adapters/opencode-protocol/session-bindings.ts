import { bindingObject, hasBindingFence, matchesStoredBinding, parseBindingEnvelope, OPENCODE_BINDING_MAX_BYTES, OPENCODE_CURSOR_MAX_BYTES } from './session-binding-codec.ts'
import type { OpenCodeBindingStorage, OpenCodeStoredBinding, OpenCodeBindingObservation, OpenCodeCursorUpdate } from './session-binding-types.ts'

/** Maps one pre-existing technical record. No materialization, team state or dispatch journal. */
export function createOpenCodeSessionBindings(storage: OpenCodeBindingStorage, supplied: OpenCodeStoredBinding) {
  const binding = structuredClone(supplied)
  if (![binding.storageKey, binding.nativeSessionId, binding.workspacePath, binding.hostKey, binding.runId, binding.profileRootKey, binding.createdAt]
    .every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= OPENCODE_CURSOR_MAX_BYTES)) {throw new Error('Explicit native session binding required')}

  const inspect = async () => {
    const read = await storage.read().catch(() => ({ kind: 'unknown' as const }))
    if (read.kind !== 'known') {return { kind: read.kind } as const}
    const envelope = parseBindingEnvelope(read.bytes)
    if (!envelope) {return { kind: 'unknown' } as const}
    const record = Object.hasOwn(envelope.records, binding.storageKey) ? envelope.records[binding.storageKey] : undefined
    if (record === undefined) {return { kind: 'missing' } as const}
    if (!bindingObject(record) || !matchesStoredBinding(record, binding)) {return { kind: 'binding_mismatch' } as const}
    if (hasBindingFence(envelope, binding)) {return { kind: 'fenced' } as const}
    return { kind: 'bound', bytes: read.bytes, envelope, record } as const
  }

  return {
    observe: async (): Promise<OpenCodeBindingObservation> => {
      const found = await inspect()
      if (found.kind !== 'bound') {return found}
      return { kind: 'bound', cursor: found.record.lastCanonicalCursor as string | null,
        stoppedAt: found.record.stoppedAt as string | undefined ?? null }
    },
    updateCursor: async (expectedCursor: string | null, nextCursor: string | null): Promise<OpenCodeCursorUpdate> => {
      if (![expectedCursor, nextCursor].every(value => value === null || typeof value === 'string')) {throw new Error('Invalid native cursor')}
      if ([expectedCursor, nextCursor].some(value => value !== null && Buffer.byteLength(value) > OPENCODE_CURSOR_MAX_BYTES)) {return { kind: 'unknown' }}
      const found = await inspect()
      if (found.kind !== 'bound') {return { kind: found.kind }}
      if (found.record.stoppedAt !== undefined) {return { kind: 'fenced' }}
      if (found.record.lastCanonicalCursor !== expectedCursor) {return { kind: 'conflict' }}
      if (expectedCursor === nextCursor) {return { kind: 'unchanged' }}
      found.envelope.records[binding.storageKey] = { ...found.record, lastCanonicalCursor: nextCursor }
      // The consumer's atomic CAS protects the entire shared envelope. Lost receipt is never replayed.
      try {
        const replacement = JSON.stringify(found.envelope)
        if (Buffer.byteLength(replacement) > OPENCODE_BINDING_MAX_BYTES) {return { kind: 'unknown' }}
        const updated = await storage.compareAndSwap(found.bytes, replacement)
        return { kind: updated ? 'updated' : 'conflict' }
      } catch { return { kind: 'unknown' } }
    },
  }
}

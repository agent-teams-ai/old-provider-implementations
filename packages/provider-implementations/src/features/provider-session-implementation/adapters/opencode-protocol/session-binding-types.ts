/** Consumer owns persistence, locking, custody and durability; this adapter only maps schema1. */
export type OpenCodeBindingStorage = {
  read: () => Promise<{ kind: 'known'; bytes: string } | { kind: 'missing' | 'unknown' }>
  compareAndSwap: (expectedBytes: string, replacementBytes: string) => Promise<boolean>
}

/** Supplied from a runtime's existing opaque binding; never discovered by team/name. */
export type OpenCodeStoredBinding = {
  storageKey: string
  nativeSessionId: string
  workspacePath: string
  hostKey: string
  profileRootKey: string
  createdAt: string
  runId: string
  materializationOwner?: { attemptId: string; sessionId: string; version: number }
}

export type OpenCodeBindingObservation =
  | { kind: 'bound'; cursor: string | null; stoppedAt: string | null }
  | { kind: 'missing' | 'unknown' | 'binding_mismatch' | 'fenced' }
export type OpenCodeCursorUpdate =
  | { kind: 'updated' | 'unchanged' | 'conflict' | 'unknown' | 'missing' | 'binding_mismatch' | 'fenced' }

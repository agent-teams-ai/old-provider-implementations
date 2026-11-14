import { executionAssert, ExecutionTransportFailure } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'
import { createV2CredentialWire, nativeSelectedSourceReference } from './v2-credential-wire.ts'
import type { OpenCodeV2CredentialClientConfig } from './v2-credential-wire.ts'

export type OpenCodeV2KeyIntegration = Readonly<{
  integrationId: string
  name: string
  plainKey: boolean
  connections: readonly (
    Readonly<{ type: 'credential'; id: string; method: 'key' | 'oauth' | 'external'; needsAuth: boolean }> |
    Readonly<{ type: 'env'; needsAuth: boolean }>
  )[]
}>

export type OpenCodeV2SelectedSourceProof = Readonly<{
  schemaVersion: 1
  sourceReference: string
  witness: string
}>

/** Synchronous Host acceptance after original wire/body cleanup, before the next request. */
type AcceptSelectedSourceProof = (proof: OpenCodeV2SelectedSourceProof) => undefined

function selectedSource(value: unknown, reference: string, reading: boolean) {
  const envelope = record(value), fields = reading
    ? ['schemaVersion', 'sourceReference', 'witness', 'integration'] : ['schemaVersion', 'sourceReference', 'witness']
  if (envelope === null || Object.keys(envelope).length !== fields.length ||
    Object.keys(envelope).some(key => !fields.includes(key)) || envelope.schemaVersion !== 1 ||
    envelope.sourceReference !== reference || typeof envelope.witness !== 'string' ||
    envelope.witness.length === 0 || envelope.witness.length > 64 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.witness) ||
    Buffer.from(envelope.witness, 'base64url').toString('base64url') !== envelope.witness) {
    throw new ExecutionTransportFailure('invalid_native_source_proof', 'unknown')
  }
  return { proof: Object.freeze({ schemaVersion: 1 as const, sourceReference: reference, witness: envelope.witness }),
    integration: envelope.integration }
}

function acceptSelectedSource(proof: OpenCodeV2SelectedSourceProof, acceptProof: AcceptSelectedSourceProof): void {
  try {
    executionAssert(acceptProof(proof) === undefined, 'invalid_native_source_acceptance')
  } catch {
    // A Host refusal cannot expose private proof data or authorize replay/rollback.
    throw new ExecutionTransportFailure('native_source_proof_refused', 'unknown')
  }
}

function integration(value: unknown, config: OpenCodeV2CredentialClientConfig): OpenCodeV2KeyIntegration {
  const envelope = record(value), native = record(envelope?.data)
  executionAssert(envelope !== null && record(envelope.location)?.directory === config.directory &&
    native !== null && native.id === config.integrationId && typeof native.name === 'string' &&
    native.name.length > 0 && Buffer.byteLength(native.name) <= 2048 && !/[\x00-\x1f\x7f]/.test(native.name) &&
    Array.isArray(native.methods) && native.methods.length <= 256 &&
    Array.isArray(native.connections) && native.connections.length <= 256, 'invalid_native_integration')
  let plainKey = false
  for (const raw of native.methods) {
    const method = record(raw)
    executionAssert(method !== null && typeof method.type === 'string' && ['key', 'oauth', 'external', 'command', 'env'].includes(method.type),
      'invalid_native_integration')
    if (method.type === 'key' && method.form === undefined) plainKey = true
  }
  const ids = new Set<string>()
  const connections: OpenCodeV2KeyIntegration['connections'][number][] = native.connections.map(raw => {
    const connection = record(raw)
    executionAssert(connection !== null && (connection.type === 'credential' || connection.type === 'env'),
      'invalid_native_integration')
    const status = connection.status === undefined ? undefined : record(connection.status)
    executionAssert(status === undefined || status !== null && status.status === 'needs_auth', 'invalid_native_integration')
    if (connection.type === 'env') return { type: 'env', needsAuth: status !== undefined }
    executionAssert(typeof connection.id === 'string' && /^cred_[A-Za-z0-9]{1,250}$/.test(connection.id) &&
      !ids.has(connection.id) && typeof connection.method === 'string' && ['key', 'oauth', 'external'].includes(connection.method), 'invalid_native_integration')
    ids.add(connection.id)
    return { type: 'credential', id: connection.id, method: connection.method as 'key' | 'oauth' | 'external',
      needsAuth: status !== undefined }
  })
  // No labels, environment names, native status text, forms or credential values.
  return { integrationId: config.integrationId, name: native.name, plainKey, connections }
}

/** Pinned native key protocol only. Host owns durable intent, auth publication and process custody. */
export function createOpenCodeV2CredentialClient(supplied: OpenCodeV2CredentialClientConfig) {
  const config = { ...supplied }, wire = createV2CredentialWire(config)
  let attempted = false, rollbackAttempted = false, ownedCredential: string | undefined
  const read = async () => integration(await wire.request('read'), config)
  return {
    read,
    async readSelectedSource(reference: string, acceptProof: AcceptSelectedSourceProof): Promise<OpenCodeV2KeyIntegration> {
      nativeSelectedSourceReference(reference)
      executionAssert(typeof acceptProof === 'function', 'invalid_native_source_acceptance')
      const selected = selectedSource(await wire.request('read-selected-source', reference), reference, true)
      const result = integration(selected.integration, config)
      acceptSelectedSource(selected.proof, acceptProof)
      return result
    },
    async connectKey(key: string): Promise<Readonly<{ integrationId: string; credentialId: string }>> {
      executionAssert(!attempted, 'native_key_already_attempted')
      // Claim synchronously before even the readback; concurrent callers cannot race a second POST.
      attempted = true
      const before = await read()
      executionAssert(before.plainKey && before.connections.length === 0, 'native_key_existing_or_unsupported')
      await wire.request('connect', key)
      const after = await read(), connection = after.connections[0]
      executionAssert(after.plainKey && after.connections.length === 1 && connection?.type === 'credential' &&
        connection.method === 'key', 'native_key_readback_unknown')
      ownedCredential = connection.id
      return { integrationId: config.integrationId, credentialId: connection.id }
    },
    async connectSelectedSource(reference: string, acceptProof: AcceptSelectedSourceProof): Promise<Readonly<{ integrationId: string; credentialId: string }>> {
      executionAssert(!attempted, 'native_key_already_attempted')
      attempted = true
      nativeSelectedSourceReference(reference)
      executionAssert(typeof acceptProof === 'function', 'invalid_native_source_acceptance')
      const before = await read()
      executionAssert(before.plainKey && before.connections.length === 0, 'native_key_existing_or_unsupported')
      const selected = selectedSource(await wire.request('connect-selected-source', reference), reference, false)
      acceptSelectedSource(selected.proof, acceptProof)
      const after = await read(), connection = after.connections[0]
      executionAssert(after.plainKey && after.connections.length === 1 && connection?.type === 'credential' &&
        connection.method === 'key', 'native_key_readback_unknown')
      ownedCredential = connection.id
      return { integrationId: config.integrationId, credentialId: connection.id }
    },
    /** Only a key whose empty-before/single-after ownership this client observed can be removed. */
    async rollbackOwnedKey(): Promise<void> {
      executionAssert(ownedCredential !== undefined && !rollbackAttempted, 'native_key_rollback_unowned')
      rollbackAttempted = true
      const before = await read(), connection = before.connections[0]
      executionAssert(before.connections.length === 1 && connection?.type === 'credential' &&
        connection.id === ownedCredential && connection.method === 'key', 'native_key_rollback_changed')
      await wire.request('rollback', ownedCredential)
      executionAssert((await read()).connections.length === 0, 'native_key_rollback_unknown')
    },
    dispose: wire.dispose,
  }
}

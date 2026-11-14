import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createOpenCodeV2CredentialClient, createOpenCodeV2ExecutionTransport } from '../../../../src/opencode.ts'
import type { OpenCodeV2CredentialClientConfig } from '../../../../src/opencode.ts'

const selected = { endpoint: 'http://127.0.0.1:14321', version: '2.1.4' as const,
  directory: resolve('TEST/key-workspace'), integrationId: 'TEST-provider' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } })
function peer() {
  const calls: { method: string; path: string }[] = []
  const native: { methods: unknown[]; connections: unknown[] } = { methods: [{ type: 'key' }], connections: [] }
  const read = () => ({ location: { directory: selected.directory }, data: { id: selected.integrationId,
    name: 'TEST provider', ...native, metadata: { secret: 'TEST-private-key' } } })
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(input instanceof Request)
    assert.deepEqual([...input.headers], [...new Headers(init?.headers)])
    assert.equal(input.headers.get('connection'), 'close')
    const url = new URL(input.url)
    calls.push({ method: input.method, path: url.pathname })
    assert.equal(input.redirect, 'error'); assert.equal(input.credentials, 'omit')
    assert.equal(input.headers.get('authorization'), 'Basic ' + Buffer.from('opencode:TEST-password').toString('base64'))
    assert.equal(url.search, input.method === 'DELETE' ? '' : '?' + new URLSearchParams({ 'location[directory]': selected.directory }))
    if (input.method === 'GET') return json(read())
    if (input.method === 'POST') {
      assert.equal(url.pathname, '/api/integration/TEST-provider/connect/key')
      assert.deepEqual(JSON.parse(await input.text()), { key: 'TEST-private-key' })
      native.connections = [{ type: 'credential', id: 'cred_TESToriginal', method: 'key', label: 'TEST-private-label' }]
    } else {
      assert.equal(input.method, 'DELETE'); assert.equal(url.pathname, '/api/credential/cred_TESToriginal')
      native.connections = []
    }
    return new Response(null, { status: 204 })
  }
  const config = { ...selected, readPassword: () => 'TEST-password', deadline: Date.now() + 30_000, fetchImpl }
  return { config, calls, native, read }
}

const sourceReference = 'a'.repeat(64)
const sourceProof = Object.freeze({ schemaVersion: 1, sourceReference,
  witness: Buffer.from('TEST-native-private-source-proof').toString('base64url') })

/** Synthetic native transform only; the F native cases qualify real file materialization/import. */
function sourcePeer() {
  const fixture = peer(), cutoffs: number[] = []
  const config = { ...fixture.config, deadline: Date.now() + 120_000, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.ok(input instanceof Request)
    assert.deepEqual([...input.headers], [...new Headers(init?.headers)])
    const started = Date.now()
    if (input.method === 'POST') {
      assert.equal(input.headers.get('content-type'), 'application/json')
      assert.equal(input.headers.has('x-agent-teams-selected-source'), false)
      const body: unknown = JSON.parse(await input.clone().text())
      assert.ok(body !== null && typeof body === 'object' && 'selectedSource' in body)
      const selectedSource = body.selectedSource
      assert.ok(selectedSource !== null && typeof selectedSource === 'object' && 'deadline' in selectedSource)
      const deadline = selectedSource.deadline
      assert.equal(typeof deadline, 'number'); assert.ok(Number.isSafeInteger(deadline))
      assert.ok(typeof deadline === 'number' && deadline > started && deadline <= started + 30_000 && deadline <= config.deadline)
      cutoffs.push(deadline)
      assert.deepEqual(body, { selectedSource: { schemaVersion: 1, reference: sourceReference, deadline } })
      const original = await fixture.config.fetchImpl(new Request(input, { body: JSON.stringify({ key: 'TEST-private-key' }) }), init)
      assert.equal(original.status, 204); assert.equal(await original.text(), '')
      return json(sourceProof)
    }
    if (input.headers.has('x-agent-teams-selected-source')) {
      assert.equal(input.method, 'GET')
      assert.equal(input.headers.get('x-agent-teams-selected-source'), 'v1:' + sourceReference)
      const cutoff = input.headers.get('x-agent-teams-selected-source-deadline')
      assert.ok(cutoff !== null && /^[1-9][0-9]*$/.test(cutoff))
      const deadline = Number(cutoff)
      assert.ok(Number.isSafeInteger(deadline) && String(deadline) === cutoff && deadline > started &&
        deadline <= started + 30_000 && deadline <= config.deadline)
      cutoffs.push(deadline)
      const original = await fixture.config.fetchImpl(input, init)
      return json({ ...sourceProof, integration: await original.json() })
    }
    assert.equal(input.headers.has('x-agent-teams-selected-source-deadline'), false)
    return fixture.config.fetchImpl(input, init)
  } }
  return { ...fixture, config, cutoffs }
}

test('2.1.4 key connect uses original integration, exact readback and only owned rollback', async () => {
  const fixture = peer(), client = createOpenCodeV2CredentialClient(fixture.config)
  fixture.config.integrationId = 'TEST-foreign'; fixture.config.readPassword = () => 'TEST-foreign'
  try {
    assert.deepEqual(await client.read(), { integrationId: selected.integrationId, name: 'TEST provider', plainKey: true, connections: [] })
    const result = client.connectKey('TEST-private-key')
    await assert.rejects(client.connectKey('TEST-private-key'), /native_key_already_attempted/)
    await assert.rejects(client.connectSelectedSource(sourceReference, () => undefined), /native_key_already_attempted/)
    assert.deepEqual(await result, { integrationId: selected.integrationId, credentialId: 'cred_TESToriginal' })
    const snapshot = await client.read()
    assert.deepEqual(snapshot.connections, [{ type: 'credential', id: 'cred_TESToriginal', method: 'key', needsAuth: false }])
    assert.equal(JSON.stringify(snapshot).includes('TEST-private'), false)
    await client.rollbackOwnedKey()
    await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_unowned/)
    assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 1)
    assert.equal(fixture.calls.filter(row => row.method === 'DELETE').length, 1)
  } finally { await client.dispose() }

  const source = sourcePeer()
  let acquired = 0, released = 0, active = false, accepted = 0
  const sourceConfig = { ...source.config, beforeRequest: async () => {
    assert.equal(active, false)
    if (source.calls.length === 2) assert.equal(accepted, 1, 'proof is accepted before the final GET admission')
    acquired++; active = true
    return () => { assert.equal(active, true); active = false; released++ }
  }, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(active, true)
    return source.config.fetchImpl(input, init)
  } }
  const fresh = createOpenCodeV2CredentialClient(sourceConfig), cold = createOpenCodeV2CredentialClient(sourceConfig)
  try {
    const connected = fresh.connectSelectedSource(sourceReference, proof => {
      assert.deepEqual(proof, sourceProof); assert.equal(Object.isFrozen(proof), true)
      assert.deepEqual({ active, acquired, released, calls: source.calls.length }, { active: false, acquired: 2, released: 2, calls: 2 })
      accepted++; return undefined
    })
    await assert.rejects(fresh.connectKey('TEST-private-key'), /native_key_already_attempted/)
    await assert.rejects(fresh.connectSelectedSource(sourceReference, () => undefined), /native_key_already_attempted/)
    assert.deepEqual(await connected, { integrationId: selected.integrationId, credentialId: 'cred_TESToriginal' })
    assert.deepEqual(source.calls.map(row => row.method), ['GET', 'POST', 'GET'])
    const snapshot = await cold.readSelectedSource(sourceReference, proof => {
      assert.deepEqual(proof, sourceProof)
      assert.deepEqual({ active, acquired, released }, { active: false, acquired: 4, released: 4 })
      accepted++; return undefined
    })
    assert.deepEqual(snapshot.connections, [{ type: 'credential', id: 'cred_TESToriginal', method: 'key', needsAuth: false }])
    assert.equal(JSON.stringify(snapshot).includes('TEST-private'), false)
    assert.deepEqual(source.calls.map(row => row.method), ['GET', 'POST', 'GET', 'GET'])
    await assert.rejects(cold.rollbackOwnedKey(), /native_key_rollback_unowned/)
    await fresh.rollbackOwnedKey()
    assert.deepEqual(source.calls.map(row => row.method), ['GET', 'POST', 'GET', 'GET', 'GET', 'DELETE', 'GET'])
    assert.deepEqual({ accepted, acquired, released, active, cutoffs: source.cutoffs.length },
      { accepted: 2, acquired: 7, released: 7, active: false, cutoffs: 2 })
  } finally { await fresh.dispose(); await cold.dispose() }
})

test('lost ACK, partial success and foreign/malformed readback never replay key mutation', async () => {
  for (const mode of ['lost', 'partial', 'location', 'identity', 'duplicate', 'wrong-method'] as const) {
    const fixture = peer()
    let posted = false
    const client = createOpenCodeV2CredentialClient({ ...fixture.config, fetchImpl: async (input, init) => {
      assert.ok(input instanceof Request)
      const response = await fixture.config.fetchImpl(input, init)
      if (input.method === 'POST') {
        posted = true
        if (mode === 'lost') throw new Error('TEST-private-key')
        if (mode === 'partial') return new Response(null, { status: 202 })
      }
      if (posted && input.method === 'GET') {
        const value = fixture.read()
        if (mode === 'location') value.location.directory = resolve('TEST/foreign')
        if (mode === 'identity') value.data.id = 'TEST-foreign'
        if (mode === 'duplicate') value.data.connections = [...value.data.connections, ...value.data.connections]
        if (mode === 'wrong-method') value.data.connections = [{ type: 'credential', id: 'cred_TESTforeign', method: 'oauth' }]
        return json(value)
      }
      return response
    } })
    try {
      await assert.rejects(client.connectKey('TEST-private-key'), error => {
        assert.ok(error instanceof Error); assert.equal(error.message.includes('TEST-private'), false); return true
      })
      await assert.rejects(client.connectKey('TEST-private-key'), /native_key_already_attempted/)
      await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_unowned/)
      assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 1, mode)
      assert.equal(fixture.calls.filter(row => row.method === 'DELETE').length, 0, mode)
    } finally { await client.dispose() }
  }
  for (const mode of ['lost', 'partial', 'stock', 'empty-204', 'reference', 'version', 'extra', 'missing',
    'witness', 'noncanonical', 'oversize', 'duplicate', 'escaped-duplicate', 'non-json', 'readback', 'consumer'] as const) {
    const fixture = sourcePeer()
    let posted = false, accepted = 0
    const client = createOpenCodeV2CredentialClient({ ...fixture.config, fetchImpl: async (input, init) => {
      assert.ok(input instanceof Request)
      if (input.method === 'POST' && mode === 'stock') {
        const body: unknown = JSON.parse(await input.text())
        assert.ok(body !== null && typeof body === 'object' && 'selectedSource' in body && !('key' in body))
        fixture.calls.push({ method: 'POST', path: new URL(input.url).pathname })
        return json({ error: 'TEST stock key schema rejects a source body' }, 400)
      }
      const response = await fixture.config.fetchImpl(input, init)
      if (input.method === 'POST') {
        await response.arrayBuffer()
        posted = true
        if (mode === 'lost') throw new Error('TEST-private-key')
        if (mode === 'partial') return json(sourceProof, 202)
        if (mode === 'empty-204') return new Response(null, { status: 204 })
        const proof: Record<string, unknown> = { ...sourceProof }
        if (mode === 'reference') proof.sourceReference = 'b'.repeat(64)
        if (mode === 'version') proof.schemaVersion = 2
        if (mode === 'extra') proof.key = 'TEST-private-key'
        if (mode === 'missing') delete proof.witness
        if (mode === 'witness') proof.witness = 'TEST+/private='
        if (mode === 'noncanonical') proof.witness = 'AB'
        if (mode === 'oversize') proof.witness = 'A'.repeat(64 * 1024 + 4)
        if (mode === 'duplicate' || mode === 'escaped-duplicate') {
          const field = mode === 'duplicate' ? 'schemaVersion' : '\\u0073chemaVersion'
          return new Response(JSON.stringify(proof).replace('"schemaVersion":1', '"schemaVersion":1,"' + field + '":1'),
            { headers: { 'content-type': 'application/json' } })
        }
        if (mode === 'non-json') return new Response(JSON.stringify(proof), { headers: { 'content-type': 'text/plain' } })
        return json(proof)
      }
      if (posted && mode === 'readback') {
        await response.arrayBuffer()
        const value = fixture.read(); value.data.id = 'TEST-foreign'
        return json(value)
      }
      return response
    } })
    try {
      await assert.rejects(client.connectSelectedSource(sourceReference, () => {
        accepted++
        if (mode === 'consumer') throw new Error('TEST-private-proof')
        return undefined
      }), error => {
        assert.ok(error instanceof Error); assert.equal(error.message.includes('TEST-private'), false); return true
      })
      await assert.rejects(client.connectSelectedSource(sourceReference, () => undefined), /native_key_already_attempted/)
      await assert.rejects(client.connectKey('TEST-private-key'), /native_key_already_attempted/)
      await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_unowned/)
      assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 1, mode)
      assert.equal(fixture.calls.filter(row => row.method === 'DELETE').length, 0, mode)
      assert.equal(accepted, mode === 'consumer' || mode === 'readback' ? 1 : 0, mode)
      if (mode === 'stock') assert.deepEqual(fixture.native.connections, [])
    } finally { await client.dispose() }
  }
  for (const mode of ['location', 'identity', 'missing', 'reference', 'extra'] as const) {
    const fixture = sourcePeer()
    let accepted = 0
    const client = createOpenCodeV2CredentialClient({ ...fixture.config, fetchImpl: async (input, init) => {
      const response = await fixture.config.fetchImpl(input, init)
      await response.arrayBuffer()
      const value = fixture.read(), reply: Record<string, unknown> = { ...sourceProof, integration: value }
      if (mode === 'location') value.location.directory = resolve('TEST/foreign')
      if (mode === 'identity') value.data.id = 'TEST-foreign'
      if (mode === 'missing') delete reply.integration
      if (mode === 'reference') reply.sourceReference = 'b'.repeat(64)
      if (mode === 'extra') reply.key = 'TEST-private-key'
      return json(reply)
    } })
    try {
      await assert.rejects(client.readSelectedSource(sourceReference, () => { accepted++; return undefined }))
      assert.equal(accepted, 0)
      assert.deepEqual(fixture.calls.map(row => row.method), ['GET'])
      await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_unowned/)
    } finally { await client.dispose() }
  }
})

test('additional forms, environment and pre-existing credentials prevent a replacement POST', async () => {
  for (const mode of ['form', 'oauth', 'env', 'credential'] as const) {
    const fixture = peer()
    if (mode === 'form') fixture.native.methods = [{ type: 'key', form: [] }]
    if (mode === 'oauth') fixture.native.methods = [{ type: 'oauth', id: 'TEST-oauth' }]
    if (mode === 'env') fixture.native.connections = [{ type: 'env', name: 'TEST-private-env' }]
    if (mode === 'credential') fixture.native.connections = [{ type: 'credential', id: 'cred_TESTexisting', method: 'key' }]
    const client = createOpenCodeV2CredentialClient(fixture.config)
    try {
      await assert.rejects(client.connectKey('TEST-private-key'), /native_key_existing_or_unsupported/)
      assert.equal(fixture.calls.some(row => row.method !== 'GET'), false)
    } finally { await client.dispose() }
    const source = sourcePeer()
    source.native.methods = [...fixture.native.methods]; source.native.connections = [...fixture.native.connections]
    const sourceClient = createOpenCodeV2CredentialClient(source.config)
    try {
      await assert.rejects(sourceClient.connectSelectedSource(sourceReference, () => assert.fail('unsupported key source accepted')),
        /native_key_existing_or_unsupported/)
      assert.deepEqual(source.calls.map(row => row.method), ['GET'])
    } finally { await sourceClient.dispose() }
  }
  const fixture = peer(), client = createOpenCodeV2CredentialClient(fixture.config)
  try {
    await client.connectKey('TEST-private-key')
    fixture.native.connections = [{ type: 'credential', id: 'cred_TESTreplacement', method: 'key' }]
    await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_changed/)
    assert.equal(fixture.calls.some(row => row.method === 'DELETE'), false)
  } finally { await client.dispose() }
})

test('Host revocation precedes credential projection and late acquisitions keep cleanup unknown', async () => {
  const fixture = peer(), revoked = new AbortController()
  let passwords = 0, released = 0
  const client = createOpenCodeV2CredentialClient({ ...fixture.config, signal: revoked.signal,
    beforeRequest: async () => { revoked.abort(); return () => { released++ } },
    readPassword: () => { passwords++; return 'TEST-password' },
  })
  await assert.rejects(client.read())
  await client.dispose()
  assert.deepEqual({ passwords, released, calls: fixture.calls.length }, { passwords: 0, released: 1, calls: 0 })
  const late = Promise.withResolvers<void>(), acquired = Promise.withResolvers<void>()
  const waiting = createOpenCodeV2CredentialClient({ ...fixture.config, deadline: Date.now() + 30,
    beforeRequest: async () => { acquired.resolve(); await late.promise; return () => { released++ } },
  })
  const read = waiting.read(); await acquired.promise
  await assert.rejects(read, /cleanup_unknown/)
  late.resolve(); await waiting.dispose()
  assert.equal(released, 2)

  for (const mode of ['complete', 'cancel', 'release-unknown'] as const) {
    const source = sourcePeer(), stop = new AbortController()
    const responseEntered = Promise.withResolvers<void>(), responseAllowed = Promise.withResolvers<void>()
    const bodyWaiting = Promise.withResolvers<void>(), cancelEntered = Promise.withResolvers<void>()
    const cancelAllowed = Promise.withResolvers<void>()
    let active = false, acquired = 0, freed = 0, accepted = 0, completedBody = false, cancelledBody = false
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined, bytes: Uint8Array | undefined
    const controlled = createOpenCodeV2CredentialClient({ ...source.config, signal: stop.signal,
      beforeRequest: async () => {
        assert.equal(active, false)
        const ordinal = ++acquired; active = true
        return () => {
          assert.equal(active, true); active = false; freed++
          if (mode === 'release-unknown' && ordinal === 2) throw new Error('TEST-private-release')
        }
      },
      fetchImpl: async (input, init) => {
        assert.ok(input instanceof Request); assert.equal(active, true)
        const response = await source.config.fetchImpl(input, init)
        if (input.method !== 'POST') return response
        bytes = new Uint8Array(await response.arrayBuffer())
        responseEntered.resolve(); await responseAllowed.promise
        let first = true
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { stream = controller },
          pull(controller) {
            if (first) {
              first = false; assert.ok(bytes); controller.enqueue(bytes.subarray(0, 1)); bodyWaiting.resolve()
            }
          },
          cancel() { cancelledBody = true; cancelEntered.resolve(); return cancelAllowed.promise },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
      },
    })
    // Attach both settlements immediately, before any awaited fixture traffic.
    const outcome = controlled.connectSelectedSource(sourceReference, proof => {
      assert.deepEqual(proof, sourceProof)
      assert.deepEqual({ active, acquired, freed, completedBody }, { active: false, acquired: 2, freed: 2, completedBody: true })
      accepted++; return undefined
    }).then(value => ({ status: 'fulfilled' as const, value }), (error: unknown) => ({ status: 'rejected' as const, error }))
    let unknownRelease = false
    try {
      await Promise.race([responseEntered.promise, outcome.then(() => assert.fail('source response did not remain pending'))])
      assert.deepEqual({ active, acquired, freed, accepted }, { active: true, acquired: 2, freed: 1, accepted: 0 })
      responseAllowed.resolve()
      await Promise.race([bodyWaiting.promise, outcome.then(() => assert.fail('source body did not remain pending'))])
      assert.deepEqual({ active, acquired, freed, accepted }, { active: true, acquired: 2, freed: 1, accepted: 0 })
      if (mode === 'cancel') {
        stop.abort()
        await Promise.race([cancelEntered.promise, outcome.then(() => assert.fail('body cleanup was not awaited'))])
        assert.deepEqual({ active, freed, accepted }, { active: true, freed: 1, accepted: 0 })
        cancelAllowed.resolve()
      } else {
        assert.ok(stream && bytes)
        completedBody = true; stream.enqueue(bytes.subarray(1)); stream.close()
      }
      const result = await outcome
      if (mode === 'complete') {
        assert.equal(result.status, 'fulfilled')
        if (result.status === 'fulfilled') assert.equal(result.value.credentialId, 'cred_TESToriginal')
        assert.deepEqual({ accepted, acquired, freed, active }, { accepted: 1, acquired: 3, freed: 3, active: false })
      } else {
        assert.equal(result.status, 'rejected')
        if (result.status === 'rejected') {
          assert.ok(result.error instanceof Error)
          assert.equal(result.error.message.includes('TEST-private'), false)
          if (mode === 'release-unknown') { assert.match(result.error.message, /cleanup_unknown/); unknownRelease = true }
        }
        assert.deepEqual({ accepted, acquired, freed, active }, { accepted: 0, acquired: 2, freed: 2, active: false })
        await assert.rejects(controlled.rollbackOwnedKey(), /native_key_rollback_unowned/)
      }
      assert.deepEqual(source.calls.map(row => row.method), mode === 'complete' ? ['GET', 'POST', 'GET'] : ['GET', 'POST'])
      await assert.rejects(controlled.connectKey('TEST-private-key'), /native_key_already_attempted/)
    } finally {
      responseAllowed.resolve(); cancelAllowed.resolve(); stop.abort()
      if (stream && !completedBody && !cancelledBody) stream.close()
      if (unknownRelease) await assert.rejects(controlled.dispose(), /cleanup_unknown/)
      else await controlled.dispose()
    }
  }
})

test('unqualified management identity and original session global capability stay rejected', async () => {
  for (const integrationId of ['..', 'TEST/foreign', '', 'TEST\nprivate']) {
    assert.throws(() => createOpenCodeV2CredentialClient({ ...peer().config, integrationId }), /invalid_native_integration/)
  }
  assert.throws(() => createOpenCodeV2CredentialClient({ ...peer().config, version: '2.0.21' } as unknown as OpenCodeV2CredentialClientConfig), /unqualified_version/)
  const fixture = peer(), wire = createOpenCodeV2ExecutionTransport({ ...fixture.config, nativeSessionId: 'ses_TESTsession' })
  try {
    await assert.rejects(wire.fetch(selected.endpoint + '/api/integration/TEST-provider?' +
      new URLSearchParams({ 'location[directory]': selected.directory })), /capabilities_pending/)
    assert.equal(fixture.calls.length, 0)
  } finally { await wire.dispose() }
  for (const reference of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64) + '\n', '../TEST-file']) {
    const source = sourcePeer()
    let passwords = 0
    const client = createOpenCodeV2CredentialClient({ ...source.config,
      readPassword: () => { passwords++; return 'TEST-password' },
    })
    try {
      await assert.rejects(client.connectSelectedSource(reference, () => assert.fail('invalid source accepted')), /invalid_native_source_reference/)
      await assert.rejects(client.readSelectedSource(reference, () => assert.fail('invalid source read')), /invalid_native_source_reference/)
      await assert.rejects(client.connectKey('TEST-private-key'), /native_key_already_attempted/)
      assert.deepEqual(source.calls, []); assert.equal(passwords, 0)
    } finally { await client.dispose() }
  }
})

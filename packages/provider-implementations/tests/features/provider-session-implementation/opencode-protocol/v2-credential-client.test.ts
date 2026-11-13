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

test('2.1.4 key connect uses original integration, exact readback and only owned rollback', async () => {
  const fixture = peer(), client = createOpenCodeV2CredentialClient(fixture.config)
  fixture.config.integrationId = 'TEST-foreign'; fixture.config.readPassword = () => 'TEST-foreign'
  try {
    assert.deepEqual(await client.read(), { integrationId: selected.integrationId, name: 'TEST provider', plainKey: true, connections: [] })
    const result = client.connectKey('TEST-private-key')
    await assert.rejects(client.connectKey('TEST-private-key'), /native_key_already_attempted/)
    assert.deepEqual(await result, { integrationId: selected.integrationId, credentialId: 'cred_TESToriginal' })
    const snapshot = await client.read()
    assert.deepEqual(snapshot.connections, [{ type: 'credential', id: 'cred_TESToriginal', method: 'key', needsAuth: false }])
    assert.equal(JSON.stringify(snapshot).includes('TEST-private'), false)
    await client.rollbackOwnedKey()
    await assert.rejects(client.rollbackOwnedKey(), /native_key_rollback_unowned/)
    assert.equal(fixture.calls.filter(row => row.method === 'POST').length, 1)
    assert.equal(fixture.calls.filter(row => row.method === 'DELETE').length, 1)
  } finally { await client.dispose() }
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
})

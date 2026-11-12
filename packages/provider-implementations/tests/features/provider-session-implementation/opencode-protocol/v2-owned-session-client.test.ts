import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, createOpenCodeV2OwnedSessionClient,
  readOpenCodeV2CheckpointSessionId } from '../../../../src/opencode.ts'
import { checkDriverCheckpoint, driverCompatibility } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'
import type { OpenCodeV2DriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'
import type { OpenCodeV2TransportConfig } from '../../../../src/opencode.ts'

const selected = { agent: 'build', model: { providerID: 'TEST-provider', id: 'TEST-model', variant: 'default' },
  permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' as const }] }
const baseline: OpenCodeV2TransportConfig = { endpoint: 'http://127.0.0.1:14321', version: '2.1.4',
  directory: resolve('TEST/owned-workspace'), nativeSessionId: 'ses_TESTowner',
  deadline: Date.now() + 30_000, readPassword: () => 'TEST-private' }
const nativeSession = () => ({ data: { id: baseline.nativeSessionId, location: { directory: baseline.directory },
  ...structuredClone(selected), time: { created: 1 } } })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } })

test('2.1.4 owner client captures exact session/config identity and exposes finite sanitized readback', async () => {
  const requests: Request[] = []
  const config = { ...baseline, fetchImpl: async (input: RequestInfo | URL) => {
    const request = input as Request; requests.push(request)
    assert.equal(request.headers.get('authorization'), 'Basic ' + Buffer.from('opencode:TEST-private').toString('base64'))
    const url = new URL(request.url)
    if (url.pathname === '/api/info') return json({ version: '2.1.4', pid: 123,
      paths: { home: 'TEST-private-home' }, urls: [], capabilities: {} })
    if (url.pathname === '/api/mcp') {
      assert.equal(url.searchParams.get('location[directory]'), baseline.directory)
      return json({ location: { directory: baseline.directory }, data: [
        { name: 'TEST-team', status: { status: 'connected', error: 'TEST-private-diagnostic' } },
      ] })
    }
    if (request.method === 'POST') {
      assert.deepEqual(JSON.parse(await request.text()), { id: baseline.nativeSessionId,
        location: { directory: baseline.directory }, ...selected })
    }
    return json(nativeSession())
  } }
  const client = createOpenCodeV2OwnedSessionClient(config)
  config.nativeSessionId = 'ses_TESTforeign'; config.readPassword = () => 'TEST-wrong'
  try {
    assert.deepEqual(await client.identity(), { version: '2.1.4', pid: 123 })
    const expected = { id: baseline.nativeSessionId, directory: baseline.directory, ...selected }
    assert.deepEqual(await client.createSession(selected), expected)
    assert.deepEqual(await client.readSession(), expected)
    assert.deepEqual(await client.readMcp(), [{ name: 'TEST-team', status: 'connected' }])
    assert.equal(requests.length, 4)
    await assert.rejects(client.createSession(selected), /native_create_already_attempted/)
    assert.equal(requests.length, 4)
  } finally { await client.dispose() }
})

test('owned creation never retries a lost ACK, wrong model/permissions, foreign session or partial success', async () => {
  for (const mode of ['lost', 'model', 'permissions', 'foreign', 'partial'] as const) {
    let calls = 0
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async () => {
      calls++
      if (mode === 'lost') throw new Error('TEST-private-network-detail')
      const response = nativeSession()
      if (mode === 'model') response.data.model.id = 'TEST-other'
      if (mode === 'permissions') response.data.permissions = []
      if (mode === 'foreign') response.data.id = 'ses_TESTforeign'
      return json(response, mode === 'partial' ? 202 : 200)
    } })
    try {
      await assert.rejects(client.createSession(selected))
      await assert.rejects(client.createSession(selected), /native_create_already_attempted/)
      assert.equal(calls, 1, mode)
    } finally { await client.dispose() }
  }
})

test('owned create captures native default variant before effects and requires its exact readback', async () => {
  for (const omitReadback of [false, true]) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async input => {
      const sent = JSON.parse(await (input as Request).text())
      assert.equal(sent.model.variant, 'default')
      const response = nativeSession()
      if (omitReadback) Reflect.deleteProperty(response.data.model, 'variant')
      return json(response)
    } })
    try {
      const work = client.createSession({ ...selected, model: { providerID: selected.model.providerID, id: selected.model.id } })
      if (omitReadback) await assert.rejects(work, /native_selection_mismatch/)
      else assert.equal((await work).model.variant, 'default')
    } finally { await client.dispose() }
  }
})

test('owned client rejects unqualified version/identity and malformed MCP readback', async () => {
  for (const version of ['2.0.21', '2.1.5']) {
    assert.throws(() => createOpenCodeV2OwnedSessionClient({ ...baseline, version } as OpenCodeV2TransportConfig), /unqualified_version/)
  }
  for (const value of [
    { location: { directory: 'TEST-foreign' }, data: [] },
    { location: { directory: baseline.directory }, data: [{ name: 'TEST-team', status: { status: 'unknown' } }] },
    { location: { directory: baseline.directory }, data: [
      { name: 'TEST-team', status: { status: 'connected' } }, { name: 'TEST-team', status: { status: 'connected' } },
    ] },
  ]) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async () => json(value) })
    try { await assert.rejects(client.readMcp()) } finally { await client.dispose() }
  }
})

test('ordinary 2.1.4 session transport retains zero-credential rejection of owner/global operations', async () => {
  let credentials = 0, requests = 0
  const wire = createOpenCodeV2ExecutionTransport({ ...baseline,
    readPassword: () => { credentials++; return 'TEST-private' },
    fetchImpl: async () => { requests++; return json({}) },
  })
  try {
    for (const path of ['/api/info', '/api/permission/saved', '/api/mcp?location[directory]=' + encodeURIComponent(baseline.directory),
      ...['plugin', 'provider', 'model', 'model/default'].map(route =>
        '/api/' + route + '?location[directory]=' + encodeURIComponent(baseline.directory))]) {
      await assert.rejects(wire.fetch(baseline.endpoint + path), /capabilities_pending/)
    }
    await assert.rejects(wire.fetch(baseline.endpoint + '/api/session', { method: 'POST',
      body: JSON.stringify({ id: baseline.nativeSessionId, location: { directory: baseline.directory }, ...selected }) }), /capabilities_pending/)
    assert.deepEqual({ credentials, requests }, { credentials: 0, requests: 0 })
  } finally { await wire.dispose() }
})

test('owned native catalog preserves native selection and drops provider credentials and settings', async () => {
  const requests: string[] = []
  const provider = { id: 'TEST-provider', name: 'TEST Provider', activation: 'auto',
    settings: { apiKey: 'TEST-secret', url: 'TEST-private-endpoint' }, headers: { Authorization: 'TEST-secret' } }
  const model = { id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST Model', enabled: true,
    limit: { context: 8192, output: 512 }, capabilities: { tools: true, input: ['text', 'image'] },
    headers: { Authorization: 'TEST-secret' }, settings: { private: 'TEST-secret' } }
  const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async input => {
    const request = input as Request, url = new URL(request.url)
    requests.push(url.pathname)
    assert.equal(request.method, 'GET')
    assert.equal(url.searchParams.get('location[directory]'), baseline.directory)
    const data = url.pathname === '/api/provider' ? [provider] : url.pathname === '/api/model' ? [model] : model
    return json({ location: { directory: baseline.directory }, data })
  } })
  try {
    const catalog = await client.readCatalog('TEST-provider')
    assert.deepEqual(catalog, {
      provider: { id: 'TEST-provider', name: 'TEST Provider', activation: 'auto' },
      defaultModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
      models: [{ id: 'TEST-model', name: 'TEST Model', enabled: true, contextTokens: 8192,
        outputTokens: 512, supportsTools: true, inputModalities: ['text', 'image'] }],
    })
    assert.deepEqual(requests, ['/api/provider', '/api/model', '/api/model/default'])
    assert.equal(JSON.stringify(catalog).includes('TEST-secret'), false)
  } finally { await client.dispose() }
})

test('owned catalog rejects foreign locations, duplicates and malformed model metadata', async () => {
  const provider = { id: 'TEST-provider', name: 'TEST Provider', activation: 'enabled' }
  const model = { id: 'TEST-model', providerID: 'TEST-provider', name: 'TEST Model', enabled: true,
    limit: { context: 8192, output: 512 }, capabilities: { tools: false, input: ['text'] } }
  for (const mode of ['location', 'duplicate-provider', 'duplicate-model', 'activation', 'modalities', 'tools', 'default'] as const) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async input => {
      const route = new URL((input as Request).url).pathname
      let data: unknown = route === '/api/provider' ? [provider] : route === '/api/model' ? [model] : model
      if (mode === 'duplicate-provider' && route === '/api/provider') data = [provider, provider]
      if (mode === 'duplicate-model' && route === '/api/model') data = [model, model]
      if (mode === 'activation' && route === '/api/provider') data = [{ ...provider, activation: 'unknown' }]
      if (mode === 'modalities' && route === '/api/model') data = [{ ...model, capabilities: { input: [null] } }]
      if (mode === 'tools' && route === '/api/model') data = [{ ...model, capabilities: { input: ['text'] } }]
      if (mode === 'default' && route === '/api/model/default') data = { id: 'TEST-model' }
      return json({ location: { directory: mode === 'location' ? 'TEST-foreign' : baseline.directory }, data })
    } })
    try { await assert.rejects(client.readCatalog('TEST-provider'), /native_catalog/) }
    finally { await client.dispose() }
  }
})

test('owned plugin readback attests only active native builtins in the exact location', async () => {
  const builtin = { id: 'TEST-native', source: { type: 'builtin' }, state: { status: 'active' }, features: { server: true } }
  for (const [data, expected] of [
    [[], true],
    [[builtin], true],
    [[builtin, { ...builtin, id: 'TEST-external', source: { type: 'local', path: 'TEST-private' } }], false],
    [[{ ...builtin, source: { type: 'package', target: 'TEST-private' } }], false],
    [[{ ...builtin, source: { type: 'sdk' } }], false],
    [[{ ...builtin, state: { status: 'failed', error: 'TEST-private' } }], false],
  ] as const) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async input => {
      const request = input as Request, url = new URL(request.url)
      assert.equal(request.method, 'GET'); assert.equal(url.pathname, '/api/plugin')
      assert.equal(url.searchParams.get('location[directory]'), baseline.directory)
      return json({ location: { directory: baseline.directory }, data })
    } })
    try { assert.equal(await client.builtinPluginsOnly(), expected) }
    finally { await client.dispose() }
  }
  for (const value of [
    { location: { directory: 'TEST-foreign' }, data: [builtin] },
    { location: { directory: baseline.directory }, data: null },
    { location: { directory: baseline.directory }, data: [{ ...builtin, state: { status: 'unknown' } }] },
    { location: { directory: baseline.directory }, data: [{ ...builtin, source: null }] },
    { location: { directory: baseline.directory }, data: [{ ...builtin, features: { server: false } }] },
  ]) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async () => json(value) })
    try { await assert.rejects(client.builtinPluginsOnly(), /invalid_native_plugins/) }
    finally { await client.dispose() }
  }
})

test('owned saved grants attest only exact native empty list and expose no grant details', async () => {
  for (const data of [[], [{ id: 'psv_TEST', projectID: 'TEST-project', action: 'shell', resource: '*',
    time: { created: 1, updated: 2 } }]]) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async input => {
      assert.equal(new URL((input as Request).url).pathname, '/api/permission/saved')
      return json({ data })
    } })
    try { assert.equal(await client.savedPermissionsEmpty(), data.length === 0) }
    finally { await client.dispose() }
  }
  for (const malformed of [[], { data: null }, { data: [], extra: true }]) {
    const client = createOpenCodeV2OwnedSessionClient({ ...baseline, fetchImpl: async () => json(malformed) })
    try { await assert.rejects(client.savedPermissionsEmpty()) } finally { await client.dispose() }
  }
})

test('2.1.4 cold checkpoint survives endpoint change but fences native/config/account/graph identity', () => {
  const config: OpenCodeV2DriverConfig = { ...baseline, trustedBinding: 'TEST-stable-engine-graph-sha', accountBinding: 'TEST-account',
    binding: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-runtime', generation: 1 },
    configRevision: 'TEST-r1', limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 100_000, outputEvents: 100,
      pendingInteractions: 2, timeoutMs: 2000 }, probe: async () => true, confirmStopped: async () => true }
  const checkpoint = { version: 1, engine: 'opencode-v2', nativeSessionId: config.nativeSessionId, compatibility: driverCompatibility(config) }
  assert.equal(readOpenCodeV2CheckpointSessionId(checkpoint), config.nativeSessionId)
  assert.equal(checkDriverCheckpoint(checkpoint, { ...config, endpoint: 'http://127.0.0.1:54321',
    binding: { ...config.binding, generation: 2 } }), true)
  for (const different of [{ nativeSessionId: 'ses_TESTforeign' }, { configRevision: 'TEST-r2' },
    { trustedBinding: 'TEST-changed-engine-graph' }, { accountBinding: 'TEST-other-account' }]) {
    assert.equal(checkDriverCheckpoint(checkpoint, { ...config, ...different }), false)
  }
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const prior = { ...config, version }
    assert.notEqual(driverCompatibility(prior), driverCompatibility({ ...prior, endpoint: 'http://127.0.0.1:54321' }))
  }
  let getters = 0
  const accessor = { ...checkpoint }
  Object.defineProperty(accessor, 'nativeSessionId', { enumerable: true, get: () => { getters++; return checkpoint.nativeSessionId } })
  const proxy = new Proxy(checkpoint, { get: () => { getters++; throw new Error('TEST-private') } })
  for (const invalid of [accessor, proxy, Object.create(checkpoint), { ...checkpoint, hidden: true }, { ...checkpoint, compatibility: 'bad' }]) {
    assert.throws(() => readOpenCodeV2CheckpointSessionId(invalid), /checkpoint-incompatible/)
  }
  assert.equal(getters, 0)
})

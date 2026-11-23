import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createOpenCodeV2OwnedSessionClient, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'
import { ExecutionTransportFailure } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-failures.ts'
import type { OpenCodeV2TransportConfig } from '../../../../src/opencode.ts'

const provider = { id: 'TEST-provider', name: 'TEST-provider', activation: 'enabled' }
const model = { id: 'TEST-model', providerID: provider.id, name: 'TEST-model', enabled: true,
  limit: { context: 8192, output: 512 }, capabilities: { tools: true, input: ['text'] }, variants: [] }
const directory = resolve('TEST/catalog-activation')
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ location: { directory }, data }),
  { status, headers: { 'content-type': 'application/json' } })

function fixture(options: { signal?: AbortSignal; deadline?: number;
  beforeAdmission?: (ordinal: number, signal: AbortSignal) => void | Promise<void> } = {}) {
  const modelEntered = Promise.withResolvers<void>(), modelResponse = Promise.withResolvers<Response>()
  const requests: string[] = [], events: string[] = []
  const counts = { admissions: 0, acquired: 0, released: 0, credentials: 0, active: 0 }
  let activated = false
  const config: OpenCodeV2TransportConfig = {
    endpoint: 'http://127.0.0.1:14321', version: '2.1.4', directory, nativeSessionId: 'ses_TESTcatalog',
    deadline: options.deadline ?? Date.now() + 30_000, ...(options.signal ? { signal: options.signal } : {}),
    beforeRequest: async signal => {
      const ordinal = ++counts.admissions
      events.push(`admit:${ordinal}`)
      await options.beforeAdmission?.(ordinal, signal)
      assert.equal(counts.active, 0, 'Each original request must release before the next admission')
      counts.active++; counts.acquired++
      return () => {
        assert.equal(counts.active, 1)
        counts.active--; counts.released++; events.push(`release:${ordinal}`)
      }
    },
    readPassword: () => {
      assert.equal(counts.active, 1)
      counts.credentials++; events.push(`credential:${counts.credentials}`)
      return 'TEST-private'
    },
    fetchImpl: async input => {
      const request = input as Request, url = new URL(request.url)
      assert.equal(counts.active, 1)
      assert.equal(request.method, 'GET')
      assert.equal(url.origin, config.endpoint)
      assert.equal(url.searchParams.get('location[directory]'), directory)
      requests.push(url.pathname); events.push(`fetch:${url.pathname}`)
      // OpenCode 2.1.4 provider.list is nonblocking; model.list awaits plugin activation.
      // The upstream server provider/model tests specify these different read boundaries.
      if (url.pathname === '/api/provider') return envelope(activated ? [provider] : [])
      if (url.pathname === '/api/model') { modelEntered.resolve(); return modelResponse.promise }
      if (url.pathname === '/api/model/default') return envelope(model)
      if (url.pathname === '/api/integration') return envelope([{ id: provider.id, name: provider.name,
        methods: [{ type: 'key' }], connections: [] }])
      assert.fail('Unexpected native route')
    },
  }
  return { client: createOpenCodeV2OwnedSessionClient(config), modelEntered, requests, events, counts,
    releaseModel(status = 200) { activated = status === 200; modelResponse.resolve(envelope([model], status)) } }
}

function assertLeases(source: ReturnType<typeof fixture>, routes: string[]) {
  assert.deepEqual(source.requests, routes)
  assert.deepEqual(source.counts, { admissions: routes.length, acquired: routes.length,
    released: routes.length, credentials: routes.length, active: 0 })
  assert.deepEqual(source.events, routes.flatMap((route, index) => [
    `admit:${index + 1}`, `credential:${index + 1}`, `fetch:${route}`, `release:${index + 1}`,
  ]))
}

test('owned catalog waits for native model activation before capturing its provider snapshot', async t => {
  const source = fixture(), work = source.client.readCatalog(provider.id)
  t.after(async () => { source.releaseModel(); await work.catch(() => {}); await source.client.dispose() })
  await source.modelEntered.promise
  source.releaseModel()
  const catalog = await work
  assert.deepEqual(catalog.provider, provider, 'The first catalog must include the newly activated native provider')
  assert.deepEqual(catalog.models.map(row => row.id), [model.id])
  assert.deepEqual(catalog.defaultModel, { providerId: provider.id, modelId: model.id })
  assertLeases(source, ['/api/model', '/api/provider', '/api/model/default'])
})

test('owned directory shares the activation barrier without additional provider or model reads', async t => {
  const source = fixture(), work = source.client.readDirectory()
  t.after(async () => { source.releaseModel(); await work.catch(() => {}); await source.client.dispose() })
  await source.modelEntered.promise
  source.releaseModel()
  const inventory = await work
  assert.deepEqual(inventory.providers, [provider], 'The native directory must include the activated provider')
  assert.deepEqual(inventory.models.map(row => [row.providerId, row.id]), [[provider.id, model.id]])
  assert.deepEqual(inventory.integrations, [{ id: provider.id, name: provider.name, plainKey: true }])
  assertLeases(source, ['/api/model', '/api/provider', '/api/model/default', '/api/integration'])
})

test('native model activation 503 is refused without a provider fallback or retry', async t => {
  const source = fixture(), work = source.client.readCatalog(provider.id)
  const rejected = assert.rejects(work, error => {
    assert.ok(error instanceof ExecutionTransportFailure)
    assert.equal(error.code, 'invalid_response')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  t.after(async () => { source.releaseModel(503); await rejected; await source.client.dispose() })
  await source.modelEntered.promise
  source.releaseModel(503)
  await rejected
  assertLeases(source, ['/api/model'])
})

test('abort while the original model activation is pending keeps one request and releases its lease', async t => {
  const controller = new AbortController(), source = fixture({ signal: controller.signal })
  const work = source.client.readCatalog(provider.id)
  const rejected = assert.rejects(work, error => {
    assert.ok(error instanceof ExecutionTransportFailure)
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  t.after(async () => { controller.abort(); source.releaseModel(); await rejected; await source.client.dispose() })
  await source.modelEntered.promise
  controller.abort()
  source.releaseModel()
  await rejected
  await source.client.dispose()
  assertLeases(source, ['/api/model'])
})

test('provider read still requires fresh owner admission after model activation', async t => {
  let current = true
  const source = fixture({ beforeAdmission: () => { if (!current) throw new Error('TEST-stale-owner') } })
  const work = source.client.readCatalog(provider.id)
  const rejected = assert.rejects(work, error => {
    assert.ok(error instanceof ExecutionTransportFailure)
    assert.equal(error.code, 'transport_failure')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
    return true
  })
  t.after(async () => { source.releaseModel(); await rejected; await source.client.dispose() })
  await source.modelEntered.promise
  current = false
  source.releaseModel()
  await rejected
  assert.deepEqual(source.requests, ['/api/model'])
  assert.deepEqual(source.counts, { admissions: 2, acquired: 1, released: 1, credentials: 1, active: 0 })
})

test('the original owner deadline still fences the catalog after delayed model activation', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const deadline = now + 30_000, source = fixture({ deadline }), work = source.client.readCatalog(provider.id)
  const rejected = assert.rejects(work, error => {
    assert.ok(error instanceof ExecutionTransportFailure)
    assert.equal(error.code, 'deadline')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  t.after(async () => { source.releaseModel(); await rejected; await source.client.dispose() })
  await source.modelEntered.promise
  now = deadline
  source.releaseModel()
  await rejected
  assertLeases(source, ['/api/model'])
})

test('late model-request admission is released without credentials or native dispatch after abort', async t => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  const source = fixture({ signal: controller.signal, beforeAdmission: async () => { entered.resolve(); await ready.promise } })
  const work = source.client.readCatalog(provider.id), rejected = assert.rejects(work, ExecutionTransportFailure)
  t.after(async () => { controller.abort(); ready.resolve(); source.releaseModel(); await rejected; await source.client.dispose() })
  await entered.promise
  controller.abort()
  ready.resolve()
  await rejected
  await source.client.dispose()
  assert.deepEqual(source.requests, [])
  assert.deepEqual(source.counts, { admissions: 1, acquired: 1, released: 1, credentials: 0, active: 0 })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexAppServerClient, CodexProtocolError } from '../../../../src/codex.ts'
import { fixture } from './subprocess-fixture.ts'

const initialize = { clientInfo: { name: 'TEST-metadata', version: '0' } }
const code = (name: string) => (error: unknown) => error instanceof CodexProtocolError && error.code === name
const model = { id: 'TEST-model', model: 'TEST-model', displayName: 'TEST model', description: '', hidden: false,
  isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'discard' }],
  defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: false }

// A private response field leaking, a forced auth refresh or a conversation write makes this red.
test('finite metadata uses captured requests and allowlisted replies across the subprocess wire', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => assert.fail('no conversation event'),
    requestApproval: async () => { assert.fail('no approval'); } })
  t.after(() => client.close())
  await assert.rejects(client.readAccount(), code('codex.protocol.not-initialized'))
  assert.throws(() => client.getRuntimeIdentity(), code('codex.protocol.not-initialized'))
  assert.equal(native.writes.length, 0)
  await native.command({ kind: 'metadata', method: 'account/read', response: {
    account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'test', accessToken: 'TEST-secret' },
    requiresOpenaiAuth: true, refreshToken: 'TEST-secret',
  } })
  await native.command({ kind: 'metadata', method: 'model/list', response: {
    data: [{ ...model, private: 'TEST-secret' }], nextCursor: 'TEST-next', private: 'TEST-secret',
  } })
  await native.command({ kind: 'metadata', method: 'config/read', response: {
    config: { model: 'TEST-model', model_provider: 'test', model_reasoning_effort: 'medium', api_key: 'TEST-secret' },
    layers: [{ private: 'TEST-secret' }],
  } })
  const blocked = native.blockNextWrite()
  const ready = client.initialize(initialize)
  await blocked.started
  const input = { cursor: null as string | null, limit: 1, includeHidden: false }
  const config = { cwd: '/TEST-selected', profile: 'TEST-profile' }
  const page = client.listModels(input), selection = client.readModelConfiguration(config)
  input.cursor = 'mutated'; input.limit = 100; config.cwd = '/foreign'
  blocked.release()
  await ready
  const identity = client.getRuntimeIdentity()
  assert.match(identity.codexHome, /TEST-codex-rpc-/u)
  assert.deepEqual(Object.keys(identity).toSorted(), ['codexHome', 'platformFamily', 'platformOs'])
  assert.deepEqual(await client.readAccount(), { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'test' }, requiresOpenaiAuth: true })
  assert.deepEqual(await page, { data: [{ ...model, supportedReasoningEfforts: ['medium'] }], nextCursor: 'TEST-next' })
  assert.deepEqual(await selection, { model: 'TEST-model', modelProvider: 'test', reasoningEffort: 'medium' })
  assert.deepEqual(native.writes.find(row => row.method === 'model/list')?.params, { cursor: null, limit: 1, includeHidden: false })
  assert.deepEqual(native.writes.find(row => row.method === 'config/read')?.params, { cwd: '/TEST-selected', profile: 'TEST-profile' })
  assert.deepEqual(native.writes.find(row => row.method === 'account/read')?.params, { refreshToken: false })
  assert.deepEqual(new Set(native.writes.map(row => row.method)), new Set(['initialize', 'initialized', 'model/list', 'config/read', 'account/read']))
  client.close()
  const count = native.writes.length
  await assert.rejects(client.readAccount(), code('codex.protocol.closed'))
  assert.equal(native.writes.length, count)
})

// Bounded native reads must reject corruption and malformed requests without a fallback or unsafe replay.
test('metadata rejects malformed bounds, private response shapes and aborted writes', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async () => ({ kind: 'decision', decision: 'decline' }) })
  t.after(() => client.close())
  await native.command({ kind: 'metadata', method: 'initialize', response: { codexHome: '../bad', platformFamily: 'unix' } })
  await client.initialize(initialize)
  assert.throws(() => client.getRuntimeIdentity(), code('codex.protocol.invalid-metadata-response'))
  const before = native.writes.length
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: null }, { includeHidden: 'yes' }, { cursor: 'a\0b' }, { secret: true }]) {
    await assert.rejects(client.listModels(input as never), code('codex.protocol.invalid-metadata-request'))
  }
  await assert.rejects(client.readModelConfiguration({ cwd: '' }), code('codex.protocol.invalid-metadata-request'))
  await assert.rejects(client.readModelConfiguration({ apiKey: 'TEST-secret' } as never), code('codex.protocol.invalid-metadata-request'))
  const aborted = AbortSignal.abort()
  await assert.rejects(client.readAccount(aborted), code('codex.protocol.closed'))
  assert.equal(native.writes.length, before)
  for (const response of [{ account: { type: 'future' }, requiresOpenaiAuth: true }, { account: null }, { account: { type: 'apiKey' }, requiresOpenaiAuth: 'yes' }]) {
    await native.command({ kind: 'metadata', method: 'account/read', response })
    await assert.rejects(client.readAccount(), code('codex.protocol.invalid-metadata-response'))
  }
  for (const response of [{ data: [model, model] }, { data: 'bad' }, { data: [model], nextCursor: 123 }, { data: [{ ...model, hidden: 'no' }] }]) {
    await native.command({ kind: 'metadata', method: 'model/list', response })
    await assert.rejects(client.listModels({ limit: 1 }), code('codex.protocol.invalid-metadata-response'))
  }
  await native.command({ kind: 'metadata', method: 'config/read', response: { config: { model: 42 } } })
  await assert.rejects(client.readModelConfiguration(), code('codex.protocol.invalid-metadata-response'))
  assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/read', 'config/read', 'model/list'].includes(String(row.method))))
})


// Quota discovery must retain observed zero and nullable windows, while rejecting corrupt numeric data.
test('finite account quotas keep zero and safe summary fields without native bucket or credential leakage', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async () => ({ kind: 'decision', decision: 'decline' }) })
  t.after(() => client.close())
  await client.initialize(initialize)
  const rateLimits = { limitId: 'codex', limitName: null, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null }, planType: 'test' }
  await native.command({ kind: 'metadata', method: 'account/rateLimits/read', response: { rateLimits: { ...rateLimits, apiKey: 'TEST-secret' }, rateLimitsByLimitId: { private: 'TEST-secret' } } })
  assert.deepEqual(await client.readAccountRateLimits(), rateLimits)
  assert.equal(native.writes.find(row => row.method === 'account/rateLimits/read')?.params, undefined)
  for (const corrupt of [{ ...rateLimits, primary: { usedPercent: -1 } }, { ...rateLimits, credits: { hasCredits: 'yes', unlimited: false } }, { ...rateLimits, secondary: { usedPercent: 0, resetsAt: 1.5 } }]) {
    await native.command({ kind: 'metadata', method: 'account/rateLimits/read', response: { rateLimits: corrupt } })
    await assert.rejects(client.readAccountRateLimits(), code('codex.protocol.invalid-metadata-response'))
  }
  assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/rateLimits/read'].includes(String(row.method))))
})


// Explicit mutation is separate from ordinary reads. Unknown native acceptance is never retried.
test('account mutation methods use only explicit native refresh/logout and refuse malformed acknowledgments', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval: async () => ({ kind: 'decision', decision: 'decline' }) })
  t.after(() => client.close())
  await assert.rejects(client.refreshAccount(), code('codex.protocol.not-initialized'))
  await assert.rejects(client.logoutAccount(), code('codex.protocol.not-initialized'))
  assert.equal(native.writes.length, 0)
  await client.initialize(initialize)
  await native.command({ kind: 'metadata', method: 'account/read', response: { account: null, requiresOpenaiAuth: true, accessToken: 'TEST-secret' } })
  assert.deepEqual(await client.refreshAccount(), { account: null, requiresOpenaiAuth: true })
  await client.readAccount()
  assert.deepEqual(native.writes.filter(row => row.method === 'account/read').map(row => row.params), [{ refreshToken: true }, { refreshToken: false }])
  await client.logoutAccount()
  await native.command({ kind: 'metadata', method: 'account/logout', response: { unexpected: 'TEST-secret' } })
  await assert.rejects(client.logoutAccount(), code('codex.protocol.invalid-metadata-response'))
  client.close()
  const count = native.writes.length
  await assert.rejects(client.logoutAccount(), code('codex.protocol.closed'))
  assert.equal(native.writes.length, count)
  assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/read', 'account/logout'].includes(String(row.method))))
})

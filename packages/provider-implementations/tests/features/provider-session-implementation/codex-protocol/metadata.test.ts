import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexAppServerClient, CodexProtocolError } from '../../../../src/codex.ts'
import { fixture } from './subprocess-fixture.ts'
import { decodeCodexConnectionNotification } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/connection-notifications.ts'

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
  await native.command({ kind: 'notify', method: 'configWarning', params: {
    summary: 'TEST configuration warning', details: 'TEST-private-details', path: '/TEST-private/config.toml',
    range: { start: { line: 0, column: 0 }, end: { line: 1, column: 2 } },
  } })
  await native.command({ kind: 'notify', method: 'remoteControl/status/changed', params: {
    installationId: 'TEST-private-installation', serverName: 'TEST-private-server', status: 'disabled', environmentId: null,
  } })
  const identity = client.getRuntimeIdentity()
  assert.match(identity.codexHome, /TEST-codex-rpc-/u)
  assert.deepEqual(Object.keys(identity).toSorted(), ['codexHome', 'platformFamily', 'platformOs'])
  assert.deepEqual(await client.readAccount(), { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'test' }, requiresOpenaiAuth: true })
  await native.command({ kind: 'metadata', method: 'account/read', response: {
    account: { type: 'chatgpt', email: null, planType: 'sci_plus', workspaceName: 'TEST-private-workspace' },
    requiresOpenaiAuth: true, userId: 'TEST-private-user', refreshToken: 'TEST-secret',
  } })
  assert.deepEqual(await client.readAccount(), { account: { type: 'chatgpt', email: null, planType: 'sci_plus' }, requiresOpenaiAuth: true })
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
  const remote = { installationId: 'TEST-installation', serverName: 'TEST-server', status: 'disabled' }
  const position = { line: 0, column: 0 }, range = { start: position, end: { line: 1, column: 2 } }
  assert.deepEqual(decodeCodexConnectionNotification('configWarning', { summary: '', details: null, path: null, range: null }),
    { kind: 'config-warning', summary: '', details: null, path: null, range: null })
  const copied = decodeCodexConnectionNotification('configWarning', { summary: 'TEST warning', range })
  position.line = 9
  assert.equal(copied?.kind, 'config-warning')
  assert.equal(copied?.kind === 'config-warning' ? copied.range?.start.line : undefined, 0)
  assert.ok(Object.isFrozen(copied))
  assert.ok(copied?.kind === 'config-warning' && Object.isFrozen(copied.range) && Object.isFrozen(copied.range?.start))
  for (const status of ['disabled', 'connecting', 'connected', 'errored']) {
    assert.deepEqual(decodeCodexConnectionNotification('remoteControl/status/changed', { ...remote, status }),
      { kind: 'remote-control-status', ...remote, status })
  }
  assert.equal(decodeCodexConnectionNotification('warning', { message: 'TEST ordinary warning' }), undefined)
  const malformed: { method: string; params: unknown }[] = [
    ...[null, [], {}, { summary: null }, { summary: 1 }, { summary: 'a\0b' }, { summary: 'x'.repeat(8193) },
      { summary: 'TEST', details: false }, { summary: 'TEST', path: undefined }, { summary: 'TEST', path: 'x'.repeat(8193) },
      { summary: 'TEST', range: {} }, { summary: 'TEST', range: { start: {}, end: { line: 0, column: 0 } } },
      { summary: 'TEST', range: { start: { line: -1, column: 0 }, end: { line: 0, column: 0 } } },
      { summary: 'TEST', range: { start: { line: 0, column: 0.5 }, end: { line: 0, column: 0 } } },
      { summary: 'TEST', range: { start: { line: 0, column: 0 }, end: { line: Number.MAX_SAFE_INTEGER + 1, column: 0 } } },
      { summary: 'TEST', range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0, private: true } } },
      { summary: 'TEST', threadId: 'foreign' }, { summary: 'TEST', thread: null }, { summary: 'TEST', turnId: '' },
      { summary: 'TEST', turn: { id: 'foreign' } }, { summary: 'TEST', item: {} }, { summary: 'TEST', private: true },
    ].map(params => ({ method: 'configWarning', params })),
    ...[{}, { ...remote, installationId: undefined }, { ...remote, serverName: null }, { ...remote, status: 'future' },
      { ...remote, environmentId: false }, { ...remote, environmentId: 'x'.repeat(8193) }, { ...remote, turnId: 'foreign' },
    ].map(params => ({ method: 'remoteControl/status/changed', params })),
  ]
  for (const row of malformed) {
    assert.throws(() => decodeCodexConnectionNotification(row.method, row.params), code('codex.protocol.invalid-connection-notification'))
  }
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
  for (const response of [{ account: { type: 'future' }, requiresOpenaiAuth: true }, { account: null }, { account: { type: 'apiKey' }, requiresOpenaiAuth: 'yes' },
    { account: { type: 'chatgpt', planType: 'sci' }, requiresOpenaiAuth: true }, { account: { type: 'chatgpt', email: 42, planType: 'sci' }, requiresOpenaiAuth: true }]) {
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

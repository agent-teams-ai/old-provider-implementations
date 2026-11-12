import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexAppServerClient, CodexProtocolError } from '../../../../src/codex.ts'
import type { CodexAccountLoginCompleted, CodexAccountLoginType } from '../../../../src/codex.ts'
import { fixture } from './subprocess-fixture.ts'

const initialize = { clientInfo: { name: 'TEST-login', version: '0' } }
const code = (name: string) => (error: unknown) => error instanceof CodexProtocolError && error.code === name
const requestApproval = async (): Promise<never> => { assert.fail('account login cannot request a tool approval') }
const browser = { type: 'chatgpt', loginId: 'TEST-browser', authUrl: 'https://example.invalid/login?state=TEST' }
const device = { type: 'chatgptDeviceCode', loginId: 'TEST-device', verificationUrl: 'https://example.invalid/device', userCode: 'TEST-CODE' }

// Real disposable subprocess wire; it does not authenticate to a vendor or launch a real provider.
test('login modes retain early exact/null/foreign identities privately and cancel without logout', async t => {
  for (const response of [browser, device]) {
    await t.test(response.type, async t => {
      const native = await fixture(t), observed: CodexAccountLoginCompleted[] = [], order: string[] = []
      const client = new CodexAppServerClient({ transport: native.transport,
        onEvent: () => assert.fail('account completion cannot enter conversation events'),
        onAccountLoginCompleted: event => { observed.push(event); order.push('completion') },
        requestApproval })
      t.after(() => client.close())
      await native.command({ kind: 'account-login', response: { ...response, accessToken: 'TEST-secret' }, beforeReply: [
        { loginId: 'TEST-foreign', success: true, error: null },
        { loginId: null, success: true, error: null },
        { success: true, error: null },
        { loginId: response.loginId, success: true, error: null, accessToken: 'TEST-secret' },
      ] })
      await client.initialize(initialize)
      const started = await client.startAccountLogin(response.type as CodexAccountLoginType)
      order.push('reply')
      assert.deepEqual(started, response)
      assert.deepEqual(order, ['completion', 'completion', 'completion', 'completion', 'reply'])
      assert.deepEqual(observed.map(event => event.loginId), ['TEST-foreign', null, null, response.loginId])
      assert.equal(observed.filter(event => event.loginId === started.loginId).length, 1, 'only one fact can bind the original ID')
      assert.equal(JSON.stringify(observed).includes('TEST-secret'), false)
      for (const status of ['canceled', 'notFound'] as const) {
        await native.command({ kind: 'metadata', method: 'account/login/cancel', response: { status, refreshToken: 'TEST-secret' } })
        assert.deepEqual(await client.cancelAccountLogin(started.loginId), { status })
      }
      assert.deepEqual(native.writes.filter(row => row.method === 'account/login/cancel').map(row => row.params),
        [{ loginId: response.loginId }, { loginId: response.loginId }])
      assert.deepEqual(native.writes.find(row => row.method === 'account/login/start')?.params, { type: response.type })
      assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/login/start', 'account/login/cancel'].includes(String(row.method))))
      client.close()
      const writes = native.writes.length
      await assert.rejects(client.startAccountLogin('chatgpt'), code('codex.protocol.closed'))
      await assert.rejects(client.cancelAccountLogin(started.loginId), code('codex.protocol.closed'))
      assert.equal(native.writes.length, writes, 'close seals requests and the notification reader')
    })
  }
})

test('login requires an installed observer, initialized client and finite validated requests before effects', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {}, requestApproval })
  t.after(() => client.close())
  await assert.rejects(client.startAccountLogin('chatgpt'), code('codex.protocol.login-observer-required'))
  await assert.rejects(client.cancelAccountLogin('TEST-login'), code('codex.protocol.not-initialized'))
  assert.equal(native.writes.length, 0)
  for (const type of ['apiKey', 'chatgptAuthTokens', '', null, { type: 'chatgpt', token: 'TEST-secret' }]) {
    await assert.rejects(client.startAccountLogin(type as never), code('codex.protocol.invalid-login-request'))
  }
  for (const id of ['', ' ', 'TEST\0foreign', 'a'.repeat(2049), null]) {
    await assert.rejects(client.cancelAccountLogin(id as never), code('codex.protocol.invalid-login-request'))
  }
  assert.equal(native.writes.length, 0)
})

test('login rejects malformed response modes/presentation and cancel acknowledgments without fallback', async t => {
  const native = await fixture(t)
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => {},
    onAccountLoginCompleted: () => {}, requestApproval })
  t.after(() => client.close())
  await assert.rejects(client.startAccountLogin('chatgpt'), code('codex.protocol.not-initialized'))
  await client.initialize(initialize)
  const before = native.writes.length
  await assert.rejects(client.startAccountLogin('chatgpt', AbortSignal.abort()), (error: unknown) =>
    error instanceof CodexProtocolError && error.acceptance === 'not-sent')
  assert.equal(native.writes.length, before)
  for (const response of [device, { ...browser, loginId: null }, { ...browser, authUrl: 'http://example.invalid' },
    { ...browser, authUrl: 'https://user:TEST-secret@example.invalid/' }, { ...browser, authUrl: 'not a URL' }]) {
    await native.command({ kind: 'account-login', response })
    await assert.rejects(client.startAccountLogin('chatgpt'), code('codex.protocol.invalid-login-response'))
  }
  await native.command({ kind: 'account-login', response: { ...device, userCode: ' ' } })
  await assert.rejects(client.startAccountLogin('chatgptDeviceCode'), code('codex.protocol.invalid-login-response'))
  await native.command({ kind: 'metadata', method: 'account/login/cancel', response: { status: 'success' } })
  await assert.rejects(client.cancelAccountLogin('TEST-original'), code('codex.protocol.invalid-login-response'))
  assert.equal(native.writes.filter(row => row.method === 'account/login/start').length, 6, 'only the six explicit calls were sent')
  assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/login/start', 'account/login/cancel'].includes(String(row.method))))
})

test('lost login reply preserves unknown acceptance without replay or inferred completion', async t => {
  const native = await fixture(t), observed: CodexAccountLoginCompleted[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => assert.fail('private login event'),
    onAccountLoginCompleted: event => observed.push(event), requestApproval })
  t.after(() => client.close())
  await client.initialize(initialize)
  await native.command({ kind: 'account-login', response: browser, holdReply: true,
    beforeReply: [{ loginId: 'TEST-foreign', success: true, error: null }] })
  const abort = new AbortController(), pending = client.startAccountLogin('chatgpt', abort.signal)
  await native.waitFor(row => row.event === 'wire' && (row.message as { method?: string }).method === 'account/login/start')
  abort.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof CodexProtocolError &&
    error.code === 'codex.protocol.request-aborted' && error.acceptance === 'unknown')
  client.close()
  assert.equal(native.writes.filter(row => row.method === 'account/login/start').length, 1)
  assert.ok(observed.every(event => event.loginId !== browser.loginId))
  assert.ok(native.writes.every(row => ['initialize', 'initialized', 'account/login/start'].includes(String(row.method))))
})

test('malformed completion cannot masquerade as a successful typed native fact', async t => {
  const native = await fixture(t), observed: CodexAccountLoginCompleted[] = []
  const client = new CodexAppServerClient({ transport: native.transport, onEvent: () => assert.fail('private login event'),
    onAccountLoginCompleted: event => observed.push(event), requestApproval })
  t.after(() => client.close())
  await client.initialize(initialize)
  await native.command({ kind: 'account-login', response: browser,
    beforeReply: [{ loginId: browser.loginId, success: 'true', error: null }] })
  await assert.rejects(client.startAccountLogin('chatgpt'), code('codex.protocol.invalid-login-response'))
  assert.equal(client.isOpen(), false)
  assert.deepEqual(observed, [])
})

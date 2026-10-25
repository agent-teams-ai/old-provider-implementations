import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { createOpenCodeV1DriverFactory } from '../../../../src/opencode.ts'
import type { OpenCodeV1DriverConfig } from '../../../../src/opencode.ts'
import type { Event, OpenConfig, Session } from '@agent-teams/provider-session-contracts'
import type { OpenCodeMessage } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/types.ts'

const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-r1', requiredCapabilities: ['text'] }
const nativeSessionId = 'ses_TESTreset', directory = '/TEST/v1-reset'
const reset = () => new TypeError('TEST transport reset', { cause: { code: 'ECONNRESET' } })
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await turn() }; assert.fail('TEST bounded memory observation') }
function fixture(intercept?: (request: Request) => Promise<Response | undefined> | Response | undefined, timeoutMs = 3000) {
  const calls: { method: string; path: string }[] = [], messages: OpenCodeMessage[] = [], submitted: string[] = []
  const config: OpenCodeV1DriverConfig = {
    endpoint: 'http://127.0.0.1:1', workspacePath: directory, nativeSessionId, version: '1.19.4',
    binding: { tenantId: request.tenantId, projectId: request.projectId, sessionId: request.sessionId, generation: request.generation }, configRevision: request.configRevision,
    trustedBinding: 'TEST-host', accountBinding: 'TEST-account', profileBinding: 'TEST-profile', runBinding: 'TEST-run', model: { providerID: 'TEST-provider', modelID: 'TEST-model' },
    limits: { queuedInputs: 2, inputBytes: 4096, outputEvents: 100, outputBytes: 100_000, pendingInteractions: 2, timeoutMs }, probe: async () => true, confirmStopped: async () => true,
    fetchImpl: async (input, init) => {
      const incoming = new Request(input, init), path = new URL(incoming.url).pathname
      calls.push({ method: incoming.method, path })
      const supplied = await intercept?.(incoming)
      if (supplied !== undefined) return supplied
      let value: unknown
      if (incoming.method === 'GET') {
        value = path.endsWith('/message') ? messages : path === '/permission' || path === '/question' ? [] : path === '/session/status' ? {} : { id: nativeSessionId, directory }
      } else {
        assert.equal(incoming.method, 'POST'); assert.equal(path, '/session/' + nativeSessionId + '/prompt_async')
        const body = await incoming.json() as { messageID: string; parts: { type: string; text: string }[] }
        submitted.push(body.messageID)
        const assistant = body.messageID + 'TEST'
        messages.push({ info: { id: body.messageID, sessionID: nativeSessionId, role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_TESTuser', sessionID: nativeSessionId, messageID: body.messageID, type: 'text', text: body.parts[0]!.text }] },
          { info: { id: assistant, parentID: body.messageID, sessionID: nativeSessionId, role: 'assistant', providerID: 'TEST-provider', modelID: 'TEST-model', time: { created: 2, completed: 3 }, finish: 'stop' },
            parts: [{ id: 'prt_TESTreply', sessionID: nativeSessionId, messageID: assistant, type: 'text', text: 'TEST reply' }] })
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    },
  }
  return { calls, submitted, config, async open() {
    const { driver } = await createOpenCodeV1DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => config, readCheckpoint: async () => undefined }).open(request)
    const events: Event[] = []; const done = (async () => { for await (const event of driver.observe()) events.push(event) })()
    return { driver, events, async close() { await driver.close(); await done } }
  } }
}
const input = { inputId: 'TEST-input', operationRef: 'TEST-operation', content: 'TEST original input' }

test('public V1 retries one preflight GET reset and completes the original input with one POST', async () => {
  let resets = 0
  const f = fixture(incoming => { if (incoming.method === 'GET' && resets++ === 0) throw reset() })
  const opened = await f.open()
  try {
    assert.equal((await opened.driver.submit(input)).ok, true)
    await until(() => opened.events.some(event => event.kind === 'result'))
    assert.deepEqual(opened.events.filter(event => event.kind === 'result').map(event => [event.inputId, event.operationRef, event.outcome]), [[input.inputId, input.operationRef, 'succeeded']])
    assert.equal(f.submitted.length, 1); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
    assert.deepEqual(f.calls.slice(0, 2), [{ method: 'GET', path: '/session/' + nativeSessionId }, { method: 'GET', path: '/session/' + nativeSessionId }])
  } finally { await opened.close() }
})

test('public V1 never replays a POST reset after the native mutation may already have happened', async () => {
  let nativeEffects = 0
  const f = fixture(incoming => { if (incoming.method === 'POST') { nativeEffects++; throw reset() } })
  const opened = await f.open()
  try {
    assert.deepEqual(await opened.driver.submit(input), { ok: false, code: 'unknown' })
    await until(() => opened.events.some(event => event.kind === 'result'))
    assert.equal(nativeEffects, 1); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
    assert.ok(opened.events.some(event => event.kind === 'result' && event.outcome === 'unknown'))
  } finally { await opened.close() }
})

test('public V1 second GET reset preserves unknown after one accepted native input', async () => {
  let posted = false
  const f = fixture(incoming => { if (incoming.method === 'POST') posted = true; else if (posted) throw reset() })
  const opened = await f.open()
  try {
    assert.equal((await opened.driver.submit(input)).ok, true)
    await until(() => opened.events.some(event => event.kind === 'result'))
    assert.equal(f.submitted.length, 1)
    assert.equal(f.calls.filter(call => call.method === 'GET' && f.calls.indexOf(call) > f.calls.findIndex(item => item.method === 'POST')).length, 2)
    assert.ok(opened.events.some(event => event.kind === 'result' && event.outcome === 'unknown'))
  } finally { await opened.close() }
})

test('public V1 lifetime cancellation prevents a GET reset retry', async () => {
  let driver: Session | undefined, close: Promise<unknown> | undefined
  const f = fixture(() => { close = driver!.close(); throw reset() })
  const opened = await f.open(); driver = opened.driver
  try {
    assert.equal((await driver.submit(input)).ok, false)
    await close; assert.equal(f.calls.length, 1); assert.equal(f.submitted.length, 0)
  } finally { await opened.close() }
})

test('public V1 exhausted original operation deadline prevents a GET reset retry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 })
  const f = fixture(() => { t.mock.timers.setTime(Date.now() + 1001); throw reset() }, 1000)
  const opened = await f.open()
  try { assert.equal((await opened.driver.submit(input)).ok, false); assert.equal(f.calls.length, 1); assert.equal(f.submitted.length, 0) }
  finally { await opened.close() }
})

test('public V1 forwards endpoint abort before the longer wire budget and never retries its reset', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 })
  let endpointSignal: AbortSignal | undefined
  const f = fixture(incoming => {
    if (incoming.method === 'GET' && new URL(incoming.url).pathname === '/permission') {
      endpointSignal = incoming.signal
      return new Promise<Response>((_, reject) => incoming.signal.addEventListener('abort', () => reject(reset()), { once: true }))
    }
    return undefined
  }, 5000)
  const opened = await f.open()
  try {
    assert.equal((await opened.driver.submit(input)).ok, true)
    await until(() => endpointSignal !== undefined)
    assert.equal(endpointSignal!.aborted, false); t.mock.timers.tick(2500)
    assert.equal(endpointSignal!.aborted, true, '2500ms endpoint deadline must reach fetch before 5000ms wire deadline')
    await until(() => opened.events.some(event => event.kind === 'result'))
    assert.equal(f.calls.filter(call => call.path === '/permission').length, 1)
    assert.ok(opened.events.some(event => event.kind === 'result' && event.outcome === 'unknown'))
  } finally { await opened.close() }
})

for (const kind of ['timeout', 'body-reset', 'bad-media', 'invalid-json'] as const) {
  test('public V1 does not retry ' + kind + ' as a pre-response connection reset', async () => {
    const f = fixture(() => {
      if (kind === 'timeout') throw new DOMException('TEST timeout', 'TimeoutError')
      if (kind === 'body-reset') return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(reset()) } }), { headers: { 'content-type': 'application/json' } })
      return new Response('TEST invalid', { headers: { 'content-type': kind === 'bad-media' ? 'text/plain' : 'application/json' } })
    })
    const opened = await f.open()
    try { assert.equal((await opened.driver.submit(input)).ok, false); assert.equal(f.calls.length, 1); assert.equal(f.submitted.length, 0) }
    finally { await opened.close() }
  })
}

test('public V1 common client cannot add recovery after the one shared wire-use GET retry is spent', async () => {
  let gets = 0
  const f = fixture(incoming => { if (incoming.method === 'GET' && ++gets !== 2) throw reset() })
  const opened = await f.open()
  try {
    assert.deepEqual(await opened.driver.submit(input), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' })
    assert.equal(gets, 3, 'one session GET reset+retry, then history reset with no second recovery')
    assert.deepEqual(f.calls.map(call => call.path), ['/session/' + nativeSessionId, '/session/' + nativeSessionId, '/session/' + nativeSessionId + '/message'])
    assert.equal(f.submitted.length, 0)
  } finally { await opened.close() }
})

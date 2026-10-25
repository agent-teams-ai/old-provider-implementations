import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeClientFactory } from '../../../../src/opencode.ts'

const endpoint = 'http://127.0.0.1:1', id = 'ses_TESTreadiness'
const reset = () => new TypeError('TEST reset', { cause: { code: 'ECONNRESET' } })
const response = () => new Response(JSON.stringify({ id, directory: '/TEST-only' }), { headers: { 'content-type': 'application/json' } })

test('public client recovers exactly one pre-response readiness GET reset with unchanged request/controller', async () => {
  const urls: (RequestInfo | URL)[] = [], options: (RequestInit | undefined)[] = []
  const client = new OpenCodeClientFactory({ fetchImpl: async (url, init) => {
    urls.push(url); options.push(init)
    if (urls.length === 1) throw reset()
    return response()
  } }).create(endpoint)
  assert.deepEqual(await client.getSession(id), { id, directory: '/TEST-only' })
  assert.deepEqual(urls, [endpoint + '/session/' + id, endpoint + '/session/' + id])
  assert.equal(options[0], options[1], 'original endpoint timer/controller/options are shared, not restarted')
  assert.equal(options[0]!.signal, options[1]!.signal)
})
test('public client second GET reset is returned after two total attempts', async () => {
  let calls = 0
  const client = new OpenCodeClientFactory({ fetchImpl: async () => { calls++; throw reset() } }).create(endpoint)
  await assert.rejects(client.getSession(id)); assert.equal(calls, 2)
})
test('public client never repeats an uncertain permission POST', async () => {
  let calls = 0
  const client = new OpenCodeClientFactory({ fetchImpl: async (url, init) => {
    calls++; assert.equal(url, endpoint + '/permission/per_TEST/reply'); assert.equal(init?.method, 'POST'); throw reset()
  } }).create(endpoint)
  await assert.rejects(client.answerPermission({ requestId: 'per_TEST', sessionId: id, decision: 'allow' }))
  assert.equal(calls, 1)
})
test('public client caller cancellation prevents recovery after rejected GET', async () => {
  let calls = 0; const abort = new AbortController()
  const client = new OpenCodeClientFactory({ fetchImpl: async () => { calls++; abort.abort(); throw reset() } }).create(endpoint, { signal: abort.signal })
  await assert.rejects(client.getSession(id)); assert.equal(calls, 1)
})
for (const callerDeadline of [false, true]) {
  test('public client expired original ' + (callerDeadline ? 'caller' : 'endpoint') + ' deadline prevents recovery', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 }); let calls = 0
    const client = new OpenCodeClientFactory({ fetchImpl: async () => { calls++; t.mock.timers.setTime(callerDeadline ? 101_001 : 115_001); throw reset() } }).create(endpoint, callerDeadline ? { remainingMs: () => 101_000 - Date.now() } : {})
    await assert.rejects(client.getSession(id)); assert.equal(calls, 1)
  })
}
for (const kind of ['body-reset', 'timeout', 'invalid-json', 'http-error'] as const) {
  test('public client never retries ' + kind + ' as a rejected pre-response GET reset', async () => {
    let calls = 0
    const client = new OpenCodeClientFactory({ fetchImpl: async () => {
      calls++
      if (kind === 'timeout') throw new DOMException('TEST timeout', 'TimeoutError')
      if (kind === 'body-reset') return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(reset()) } }), { headers: { 'content-type': 'application/json' } })
      return new Response('TEST invalid', { status: kind === 'http-error' ? 503 : 200, headers: { 'content-type': 'application/json' } })
    } }).create(endpoint)
    await assert.rejects(client.getSession(id)); assert.equal(calls, 1)
  })
}

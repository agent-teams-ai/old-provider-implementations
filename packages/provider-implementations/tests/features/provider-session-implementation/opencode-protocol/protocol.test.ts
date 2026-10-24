import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  OpenCodeClientFactory, bindOpenCodeSession, readOpenCodeSseEndpoint,
  normalizeOpenCodeSseEvent, buildOpenCodeRuntimePromptMessageId,
  getGreatestCanonicalOpenCodeMessageId,
} from '../../../../src/opencode.ts'

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}

// A wrong abort target, host shutdown, duplicate mutation or cross-session grant fails this contract.
test('two sessions share a host while interrupt and permission effects stay scoped', async t => {
  const effects: string[] = []
  const messages = new Map<string, unknown[]>([['session_A', []], ['session_B', []]])
  const host = await fixture((req, res) => {
    res.setHeader('content-type', 'application/json')
    const url = new URL(req.url!, 'http://fixture')
    if (url.pathname === '/permission') {
      res.end(JSON.stringify([{ id: 'request_B', sessionID: 'session_B' }]))
      return
    }
    if (url.pathname === '/permission/request_B') {
      effects.push('permission_B')
      res.end('true')
      return
    }
    const [, , id, action] = url.pathname.split('/')
    if (!id || !messages.has(id)) { res.writeHead(404); res.end('{}'); return }
    if (action === 'abort') { effects.push(`abort:${id}`); res.end('true'); return }
    if (action === 'prompt_async') {
      req.resume()
      effects.push(`prompt:${id}`)
      messages.get(id)!.push({ info: { id: `reply_${effects.length}`, sessionID: id }, parts: [{ type: 'text', text: 'fixture reply' }] })
      res.writeHead(204); res.end(); return
    }
    if (action === 'message') { res.end(JSON.stringify(messages.get(id))); return }
    res.end(JSON.stringify({ id }))
  })
  t.after(host.close)
  const client = new OpenCodeClientFactory().create(host.endpoint)
  const a = bindOpenCodeSession(client, 'session_A'), b = bindOpenCodeSession(client, 'session_B')
  await a.read(); await b.read()
  await a.prompt({ messageID: 'input_A', parts: [{ type: 'text', text: 'A' }] })
  await b.prompt({ messageID: 'input_B', parts: [{ type: 'text', text: 'B' }] })
  assert.equal(await a.interrupt(), true)
  await assert.rejects(a.replyPermission('request_B', 'allow'), /another session/)
  await b.replyPermission('request_B', 'reject')
  await b.prompt({ messageID: 'input_B2', parts: [{ type: 'text', text: 'still alive' }] })
  assert.equal((await b.messages()).length, 2)
  assert.deepEqual(effects, ['prompt:session_A', 'prompt:session_B', 'abort:session_A', 'permission_B', 'prompt:session_B'])
  const event = normalizeOpenCodeSseEvent({ payload: { type: 'message.updated', properties: { info: { sessionID: 'session_B' } } } })!
  assert.equal(a.acceptsEvent(event), false)
  assert.equal(b.acceptsEvent(event), true)
  assert.equal(b.acceptsEvent(normalizeOpenCodeSseEvent({ type: 'unknown', properties: {} })!), false)
})

// Response loss must never turn a permission mutation into alternate-route replay.
test('failed permission POST is attempted once and diagnostics do not echo provider secrets', async t => {
  let attempts = 0
  const host = await fixture((req, res) => {
    attempts++
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"secret":"TEST_SECRET_DO_NOT_ECHO"}')
  })
  t.after(host.close)
  const client = new OpenCodeClientFactory().create(host.endpoint)
  await assert.rejects(client.answerPermission({ requestId: 'request_A', sessionId: 'session_A', decision: 'allow' }), error => {
    assert(error instanceof Error)
    assert.match(error.message, /503/)
    assert.doesNotMatch(error.message, /TEST_SECRET/)
    return true
  })
  assert.equal(attempts, 1)
})

test('bounded JSON reads reject large metadata, incomplete body deadlines and expired preflight', async t => {
  let requests = 0
  const host = await fixture((req, res) => {
    requests++
    res.setHeader('content-type', 'application/json')
    if (req.url === '/config') { res.end(JSON.stringify({ content: 'x'.repeat(1024 * 1024) })); return }
    res.write('[')
  })
  t.after(host.close)
  const client = new OpenCodeClientFactory().create(host.endpoint)
  await assert.rejects(client.getConfig(), /byte budget/)
  const expires = performance.now() + 50
  const timed = new OpenCodeClientFactory().create(host.endpoint, { remainingMs: () => expires - performance.now() })
  await assert.rejects(timed.getSessionMessages('session_A'), /deadline|timed out/)
  const before = requests
  await assert.rejects(new OpenCodeClientFactory().create(host.endpoint, { remainingMs: () => 0 }).abortSession('session_A'), /timed out/)
  assert.equal(requests, before)
})

test('SSE consumes chunked envelopes and malformed records without attributing unknown events', async t => {
  const host = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': ping\r\n\r\ndata: {invalid}\r\n\r\ndata: {"payload":{"type":"message.updated","properties":{"sessionID":"session_A"}}}\n\n')
    res.end('data: {"type":"future.event","properties":{}}\n\n')
  })
  t.after(host.close)
  const events: string[] = []
  const result = await readOpenCodeSseEndpoint({ baseUrl: host.endpoint, endpoint: '/event', onEvent: value => { events.push(value.type) } })
  assert.equal(result.connected, true)
  assert.equal(result.closedBeforeAbort, true)
  assert.equal(result.observedEventCount, 2)
  assert.deepEqual(events, ['message.updated', 'future.event'])
  assert.equal(result.diagnostics.length, 1)
})

test('SSE rejects an unbounded event and caps diagnostic retention', async t => {
  const host = await fixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (req.url === '/global/event') { res.end('data: {bad}\n\n'.repeat(64)); return }
    res.end('data: ' + JSON.stringify({ type: 'oversized', properties: { text: 'x'.repeat(1024 * 1024 + 1) } }))
  })
  t.after(host.close)
  const result = await readOpenCodeSseEndpoint({ baseUrl: host.endpoint, endpoint: '/event', onEvent: () => assert.fail('oversized event must not dispatch') })
  assert(result.diagnostics.some(value => value.includes('byte budget')))
  const malformed = await readOpenCodeSseEndpoint({ baseUrl: host.endpoint, endpoint: '/global/event', onEvent: () => assert.fail('malformed event') })
  assert.equal(malformed.diagnostics.length, 32)
})

test('native ID codec preserves ordering while runtime owns allocation', () => {
  const older = buildOpenCodeRuntimePromptMessageId({ timestampMs: 100, randomSuffix: '00000000000000' })
  const newer = buildOpenCodeRuntimePromptMessageId({ timestampMs: 101, randomSuffix: '11111111111111' })
  assert.equal(older, 'msg_00000006400000000000000000')
  assert.equal(getGreatestCanonicalOpenCodeMessageId([null, 'foreign', older, newer]), newer)
})

test('a scoped URL cannot legitimize another session message or identity', async t => {
  let mismatchedRead = false
  const host = await fixture((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/message?limit=50')) {
      res.end(JSON.stringify([{ info: { id: 'msg_A', sessionID: 'session_A' }, parts: [] }]))
      return
    }
    mismatchedRead = true
    res.end(JSON.stringify({ id: 'session_A' }))
  })
  t.after(host.close)
  const b = bindOpenCodeSession(new OpenCodeClientFactory().create(host.endpoint), 'session_B')
  await assert.rejects(b.messages(), /identity mismatch/)
  await assert.rejects(b.read(), /identity mismatch/)
  assert.equal(mismatchedRead, true)
})

test('mutation redirects are refused before the destination receives an effect', async t => {
  let destinationEffects = 0
  const destination = await fixture((_req, res) => { destinationEffects++; res.end('true') })
  const source = await fixture((_req, res) => {
    res.writeHead(307, { location: destination.endpoint + '/permission/request_A' }); res.end()
  })
  t.after(destination.close); t.after(source.close)
  const client = new OpenCodeClientFactory().create(source.endpoint)
  await assert.rejects(client.answerPermission({ requestId: 'request_A', sessionId: 'session_A', decision: 'allow' }))
  assert.equal(destinationEffects, 0)
})

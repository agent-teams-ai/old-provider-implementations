import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, isOpenCodeV2SessionMissing, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'

async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) } }
}
const config = (endpoint: string, version: '2.0.0' | '2.0.21' = '2.0.21') => ({
  endpoint, version, directory: '/TEST/original', readPassword: () => 'TEST_PRIVATE_PASSWORD', deadline: Date.now() + 10_000,
})
const prompt = { id: 'msg_original', text: 'TEST input', delivery: 'queue', resume: false }
async function captureFailure(work: Promise<unknown>): Promise<unknown> {
  try { await work } catch (error) { return error }
  assert.fail('expected failure')
}

test('V2 effect then lost receipt is unknown and original input is recovered by readonly lookup without replay', async t => {
  let effects = 0
  const host = await peer((req, res) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:TEST_PRIVATE_PASSWORD').toString('base64'))
    if (req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk })
      req.on('end', () => { assert.equal(JSON.parse(body).id, 'msg_original'); effects++; req.socket.destroy() })
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([{ id: 'msg_original', sessionID: 'session_A', delivery: 'queue' }]))
    }
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  t.after(() => transport.dispose())
  const failure = await captureFailure(transport.fetch(host.endpoint + '/api/session/session_A/prompt', {
    method: 'POST', body: JSON.stringify(prompt),
  }))
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  assert.equal(effects, 1)
  assert(failure instanceof Error); assert.doesNotMatch(failure.message, /TEST_PRIVATE_PASSWORD|TEST input/)
  const recovered = await transport.fetch(host.endpoint + '/api/session/session_A/inbox')
  assert.deepEqual(await recovered.json(), [{ id: 'msg_original', sessionID: 'session_A', delivery: 'queue' }])
  assert.equal(effects, 1)
})

test('V2 missing session evidence requires exact native error and original endpoint/workspace/version/session', async t => {
  const host = await peer((req, res) => {
    const id = req.url!.split('/').at(-1)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(id === 'session_A'
      ? { _tag: 'SessionNotFoundError', sessionID: id, message: 'TEST private native detail' }
      : { _tag: 'SessionNotFoundError', sessionID: 'foreign', message: 'TEST private detail' }))
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => transport.dispose())
  const binding = { endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21' as const, sessionId: 'session_A' }
  const error = await captureFailure(transport.fetch(host.endpoint + '/api/session/session_A'))
  assert.equal(isOpenCodeV2SessionMissing(error, binding), true)
  for (const changed of [{ directory: '/TEST/other' }, { sessionId: 'session_B' },
    { endpoint: 'http://127.0.0.1:1' }, { version: '2.0.0' as const }]) {
    assert.equal(isOpenCodeV2SessionMissing(error, { ...binding, ...changed }), false)
  }
  assert.equal(isOpenCodeV2SessionMissing(Object.assign(new Error('session_missing'), { disposition: 'unknown' }), binding), false)
  assert.equal(wasOpenCodeV2InputNotSubmitted({ code: 'deadline', disposition: 'not_submitted' }), false)
  const wrongNativeError = await captureFailure(transport.fetch(host.endpoint + '/api/session/session_B'))
  assert.equal(isOpenCodeV2SessionMissing(wrongNativeError, { ...binding, sessionId: 'session_B' }), false)
  assert(error instanceof Error); assert.doesNotMatch(error.message, /private/)
})

test('V2 unsupported route, workspace and create binding reject before native fetch', async t => {
  let requests = 0
  const host = await peer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end('{}') })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => transport.dispose())
  for (const [route, init] of [
    ['/api/session/session_A/interrupt', { method: 'POST' }],
    ['/api/location?location[directory]=/TEST/other', undefined],
    ['/api/session', { method: 'POST', body: JSON.stringify({ location: { directory: '/TEST/other' } }) }],
    ['/api/session/session_A/prompt', { method: 'POST', body: JSON.stringify({ ...prompt, delivery: 'steer' }) }],
  ] as const) {
    const error = await captureFailure(transport.fetch(host.endpoint + route, init))
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
  }
  assert.equal(requests, 0)
  assert.throws(() => createOpenCodeV2ExecutionTransport({ ...config(host.endpoint), version: 'future' as '2.0.21' }), /unqualified_version/)
})

test('V2 transport cleanup cancels only its requests on a shared host; neighboring transport remains usable', async t => {
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const host = await peer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/session/session_A') { res.write('{'); signalStarted(); return }
    res.end('{"id":"session_B"}')
  })
  t.after(host.close)
  const a = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  const b = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => b.dispose())
  const pending = captureFailure(a.fetch(host.endpoint + '/api/session/session_A'))
  await started
  await a.dispose()
  const failure = await pending
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  const response = await b.fetch(host.endpoint + '/api/session/session_B')
  assert.deepEqual(await response.json(), { id: 'session_B' })
  assert.equal(wasOpenCodeV2InputNotSubmitted(await captureFailure(a.fetch(host.endpoint + '/api/session/session_A'))), true)
})

test('V2 finite log enforces complete frames and media type; exact floor activation remains supported', async t => {
  const host = await peer((req, res) => {
    if (req.url!.startsWith('/api/plugin/await-activation')) { res.writeHead(204); res.end(); return }
    res.setHeader('content-type', 'text/event-stream')
    res.end(req.url!.includes('incomplete')
      ? 'data: {"type":"log.synced"}' : 'data: {"type":"log.synced","aggregateID":"session_A"}\n\n')
  })
  t.after(host.close)
  const current = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => current.dispose())
  const complete = await current.fetch(host.endpoint + '/api/experimental/session/session_A/log?follow=false')
  assert.match(await complete.text(), /log.synced/)
  const incomplete = await captureFailure(current.fetch(host.endpoint + '/api/experimental/session/incomplete/log?follow=false'))
  assert.equal(wasOpenCodeV2InputNotSubmitted(incomplete), false)
  const floor = createOpenCodeV2ExecutionTransport(config(host.endpoint, '2.0.0')); t.after(() => floor.dispose())
  const activation = await floor.fetch(host.endpoint + '/api/plugin/await-activation?location[directory]=/TEST/original', { method: 'POST' })
  assert.equal(activation.status, 204)
})

test('V2 mutation redirect never forwards credentials or effects to another endpoint', async t => {
  let sourceEffects = 0, destinationEffects = 0
  const destination = await peer((_req, res) => { destinationEffects++; res.setHeader('content-type', 'application/json'); res.end('{}') })
  const source = await peer((req, res) => {
    req.resume(); sourceEffects++
    res.writeHead(307, { location: destination.endpoint + '/api/session/session_A/prompt' }); res.end()
  })
  t.after(destination.close); t.after(source.close)
  const transport = createOpenCodeV2ExecutionTransport(config(source.endpoint)); t.after(() => transport.dispose())
  const error = await captureFailure(transport.fetch(source.endpoint + '/api/session/session_A/prompt', {
    method: 'POST', body: JSON.stringify(prompt),
  }))
  assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
  assert.equal(sourceEffects, 1)
  assert.equal(destinationEffects, 0)
})

test('V2 interrupted request-body validation releases its reader before any native invocation', async t => {
  let nativeCalls = 0, canceled = false, bodyStarted!: () => void
  const reading = new Promise<void>(resolve => { bodyStarted = resolve })
  const host = await peer((_req, res) => { nativeCalls++; res.end('{}') }); t.after(host.close)
  const signal = new AbortController()
  const transport = createOpenCodeV2ExecutionTransport({ ...config(host.endpoint), signal: signal.signal })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    pull() { bodyStarted() }, cancel() { canceled = true },
  })
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
  const request = new Request(host.endpoint + '/api/session/session_A/prompt', init)
  const pending = captureFailure(transport.fetch(request))
  await reading
  signal.abort()
  const error = await pending
  await transport.dispose()
  assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
  assert.equal(canceled, true)
  assert.equal(nativeCalls, 0)
})

test('V2 credential callback cannot reopen execution after synchronously aborting or closing transport', async t => {
  let nativeCalls = 0
  const host = await peer((_req, res) => { nativeCalls++; res.setHeader('content-type', 'application/json'); res.end('{}') })
  t.after(host.close)
  for (const action of ['abort', 'close']) {
    const abort = new AbortController()
    let closing: Promise<void> | undefined
    let transport: ReturnType<typeof createOpenCodeV2ExecutionTransport>
    transport = createOpenCodeV2ExecutionTransport({ ...config(host.endpoint), signal: abort.signal,
      readPassword: () => {
        if (action === 'abort') {abort.abort()}
        else {closing = transport.dispose()}
        return 'TEST_PRIVATE_PASSWORD'
      },
    })
    const error = await captureFailure(transport.fetch(host.endpoint + '/api/session/session_A'))
    await closing
    await transport.dispose()
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
  }
  assert.equal(nativeCalls, 0)
})

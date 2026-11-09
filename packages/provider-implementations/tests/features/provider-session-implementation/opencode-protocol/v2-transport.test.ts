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
const config = (endpoint: string, version: '2.0.0' | '2.0.21' = '2.0.21',
  nativeSessionId = 'ses_A') => ({
  endpoint, version, nativeSessionId, directory: '/TEST/original',
  readPassword: () => 'TEST_PRIVATE_PASSWORD', deadline: Date.now() + 10_000,
})
const prompt = { id: 'msg_original', text: 'TEST input', delivery: 'queue', resume: false }
async function captureFailure(work: Promise<unknown>): Promise<unknown> {
  try { await work } catch (error) { return error }
  assert.fail('expected failure')
}

test('V2 execution transport never forwards caller headers with native credentials', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const endpoint = 'http://127.0.0.1:12345'
    const seen: string[][] = []
    const wire = createOpenCodeV2ExecutionTransport({
      ...config(endpoint, version),
      fetchImpl: async (nativeRequest, init) => {
        assert(nativeRequest instanceof Request)
        const headers = new Headers(init?.headers)
        seen.push([...headers.keys()].sort())
        assert.deepEqual([...nativeRequest.headers.keys()].sort(), [...headers.keys()].sort())
        assert.equal(nativeRequest.credentials, 'omit')
        assert.equal(nativeRequest.redirect, 'error')
        assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from('opencode:TEST_PRIVATE_PASSWORD').toString('base64'))
        for (const untrusted of ['cookie', 'x-forwarded-host', 'x-test-secret']) {
          assert.equal(headers.get(untrusted), null)
        }
        return new Response('{"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    t.after(() => wire.dispose())
    const injected = { authorization: 'Bearer TEST_UNTRUSTED', cookie: 'TEST_COOKIE',
      'x-forwarded-host': 'TEST-foreign.invalid', 'x-test-secret': 'TEST_SENTINEL', 'content-type': 'text/plain' }
    await wire.fetch(endpoint + '/api/session/ses_A', { headers: injected, credentials: 'include', redirect: 'follow' })
    await wire.fetch(endpoint + '/api/session/ses_A/prompt', {
      method: 'POST', headers: injected, credentials: 'include', redirect: 'follow', body: JSON.stringify(prompt),
    })
    assert.deepEqual(seen, [['authorization'], ['authorization', 'content-type']])
  }
})

test('V2 raw prompt rejects unqualified attachments before credentials or native HTTP', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    let credentialReads = 0
    let nativeCalls = 0
    const endpoint = 'http://127.0.0.1:12345'
    const wire = createOpenCodeV2ExecutionTransport({
      ...config(endpoint, version),
      readPassword: () => { credentialReads++; return 'TEST_PRIVATE_PASSWORD' },
      fetchImpl: async () => { nativeCalls++; throw new Error('native_must_not_be_called') },
    })
    t.after(() => wire.dispose())
    for (const attachments of [
      { files: [{ uri: 'file:///TEST/foreign/private' }] },
      { agents: [{ name: 'unqualified_agent' }] },
      { skills: [{ id: 'unqualified_skill' }] },
      { files: [] },
    ]) {
      const error = await captureFailure(wire.fetch(endpoint + '/api/session/ses_A/prompt', {
        method: 'POST', body: JSON.stringify({ ...prompt, ...attachments }),
      }))
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      assert(error instanceof Error)
      assert.doesNotMatch(error.message, /TEST_PRIVATE_PASSWORD|foreign\/private|unqualified_/)
    }
    assert.equal(credentialReads, 0)
    assert.equal(nativeCalls, 0)
  }
})

test('V2 effect then lost receipt is unknown and original input is recovered by readonly lookup without replay', async t => {
  let effects = 0
  const host = await peer((req, res) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:TEST_PRIVATE_PASSWORD').toString('base64'))
    if (req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk })
      req.on('end', () => { assert.equal(JSON.parse(body).id, 'msg_original'); effects++; req.socket.destroy() })
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([{ id: 'msg_original', sessionID: 'ses_A', delivery: 'queue' }]))
    }
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  t.after(() => transport.dispose())
  const failure = await captureFailure(transport.fetch(host.endpoint + '/api/session/ses_A/prompt', {
    method: 'POST', body: JSON.stringify(prompt),
  }))
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  assert.equal(effects, 1)
  assert(failure instanceof Error); assert.doesNotMatch(failure.message, /TEST_PRIVATE_PASSWORD|TEST input/)
  const recovered = await transport.fetch(host.endpoint + '/api/session/ses_A/inbox')
  assert.deepEqual(await recovered.json(), [{ id: 'msg_original', sessionID: 'ses_A', delivery: 'queue' }])
  assert.equal(effects, 1)
})

test('V2 missing session evidence requires exact native error and original endpoint/workspace/version/session', async t => {
  const host = await peer((req, res) => {
    const id = req.url!.split('/').at(-1)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(id === 'ses_A'
      ? { _tag: 'SessionNotFoundError', sessionID: id, message: 'TEST private native detail' }
      : { _tag: 'SessionNotFoundError', sessionID: 'foreign', message: 'TEST private detail' }))
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => transport.dispose())
  const binding = { endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21' as const, sessionId: 'ses_A' }
  const error = await captureFailure(transport.fetch(host.endpoint + '/api/session/ses_A'))
  assert.equal(isOpenCodeV2SessionMissing(error, binding), true)
  for (const changed of [{ directory: '/TEST/other' }, { sessionId: 'ses_B' },
    { endpoint: 'http://127.0.0.1:1' }, { version: '2.0.0' as const }]) {
    assert.equal(isOpenCodeV2SessionMissing(error, { ...binding, ...changed }), false)
  }
  assert.equal(isOpenCodeV2SessionMissing(Object.assign(new Error('session_missing'), { disposition: 'unknown' }), binding), false)
  assert.equal(wasOpenCodeV2InputNotSubmitted({ code: 'deadline', disposition: 'not_submitted' }), false)
  const wrongNativeError = await captureFailure(transport.fetch(host.endpoint + '/api/session/ses_B'))
  assert.equal(isOpenCodeV2SessionMissing(wrongNativeError, { ...binding, sessionId: 'ses_B' }), false)
  assert(error instanceof Error); assert.doesNotMatch(error.message, /private/)
})

test('V2 unsupported route, workspace and create binding reject before native fetch', async t => {
  let requests = 0
  const host = await peer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end('{}') })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => transport.dispose())
  for (const [route, init] of [
    ['/api/session/ses_A/interrupt', { method: 'POST' }],
    ['/api/location?location[directory]=/TEST/other', undefined],
    ['/api/session', { method: 'POST', body: JSON.stringify({ location: { directory: '/TEST/other' } }) }],
    ['/api/session/ses_A/prompt', { method: 'POST', body: JSON.stringify({ ...prompt, delivery: 'steer' }) }],
  ] as const) {
    const error = await captureFailure(transport.fetch(host.endpoint + route, init))
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
  }
  assert.equal(requests, 0)
  assert.throws(() => createOpenCodeV2ExecutionTransport({ ...config(host.endpoint), version: 'future' as '2.0.21' }), /unqualified_version/)
  // A raw transport must not accept a one-element JSON array as a URL just
  // because RegExp.test() would coerce it to a matching string.
  assert.throws(() => createOpenCodeV2ExecutionTransport({
    ...config(host.endpoint), endpoint: [host.endpoint],
  } as unknown as ReturnType<typeof config>), /authority_mismatch/)
})

test('V2 read-only query budgets refuse unbounded pagination and log offsets before credentials', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const endpoint = 'http://127.0.0.1:12345'
    let credentials = 0, nativeRequests = 0
    const transport = createOpenCodeV2ExecutionTransport({
      ...config(endpoint, version),
      readPassword: () => { credentials++; return 'TEST_PRIVATE_PASSWORD' },
      fetchImpl: async () => {
        nativeRequests++
        return new Response(JSON.stringify({ data: [], cursor: { previous: null, next: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    t.after(() => transport.dispose())
    for (const path of [
      '/api/session/ses_A/message?limit=0',
      '/api/session/ses_A/message?limit=201',
      '/api/session/ses_A/message?limit=999999999',
      '/api/session/ses_A/message?limit=0001',
      '/api/session/ses_A/message?cursor=',
      '/api/session/ses_A/message?cursor=' + 'x'.repeat(4097),
      '/api/experimental/session/ses_A/log?follow=false&after=-1',
      '/api/experimental/session/ses_A/log?follow=false&after=1e9',
      '/api/experimental/session/ses_A/log?follow=false&after=9007199254740992',
    ]) {
      const failure = await captureFailure(transport.fetch(endpoint + path))
      assert.equal(wasOpenCodeV2InputNotSubmitted(failure), true, path)
    }
    assert.equal(credentials, 0, 'rejected native reads must not project credentials')
    assert.equal(nativeRequests, 0, 'rejected native reads must not access the engine')
    const response = await transport.fetch(endpoint + '/api/session/ses_A/message?limit=200&cursor=TEST-cursor')
    assert.equal(response.status, 200)
    assert.equal(credentials, 1)
    assert.equal(nativeRequests, 1)
  }
})

test('V2 direct execution wire rejects overflow and noncanonical loopback ports before credentials or fetch', () => {
  let credentials = 0, fetches = 0
  for (const endpoint of [
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:123456',
    'http://127.0.0.1:00001',
    'http://127.0.0.1:0',
  ]) {
    assert.throws(() => createOpenCodeV2ExecutionTransport({
      ...config(endpoint),
      readPassword: () => { credentials++; return 'TEST_PRIVATE_PASSWORD' },
      fetchImpl: async () => { fetches++; return new Response('{}') },
    }), /authority_mismatch/, endpoint)
  }
  assert.equal(credentials, 0)
  assert.equal(fetches, 0)
})

test('V2 transport cleanup cancels only its requests on a shared host; neighboring transport remains usable', async t => {
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const host = await peer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/session/ses_A') { res.write('{'); signalStarted(); return }
    res.end('{"id":"ses_B"}')
  })
  t.after(host.close)
  const a = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  const b = createOpenCodeV2ExecutionTransport(config(host.endpoint, '2.0.21', 'ses_B')); t.after(() => b.dispose())
  const pending = captureFailure(a.fetch(host.endpoint + '/api/session/ses_A'))
  await started
  await a.dispose()
  const failure = await pending
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  const response = await b.fetch(host.endpoint + '/api/session/ses_B')
  assert.deepEqual(await response.json(), { id: 'ses_B' })
  assert.equal(wasOpenCodeV2InputNotSubmitted(await captureFailure(a.fetch(host.endpoint + '/api/session/ses_A'))), true)
})

test('V2 finite log enforces complete frames and media type; exact floor activation remains supported', async t => {
  let reads = 0
  const host = await peer((req, res) => {
    if (req.url!.startsWith('/api/plugin/await-activation')) { res.writeHead(204); res.end(); return }
    res.setHeader('content-type', 'text/event-stream')
    res.end(++reads === 2
      ? 'data: {"type":"log.synced"}' : 'data: {"type":"log.synced","aggregateID":"ses_A"}\n\n')
  })
  t.after(host.close)
  const current = createOpenCodeV2ExecutionTransport(config(host.endpoint)); t.after(() => current.dispose())
  const complete = await current.fetch(host.endpoint + '/api/experimental/session/ses_A/log?follow=false')
  assert.match(await complete.text(), /log.synced/)
  const incomplete = await captureFailure(current.fetch(host.endpoint + '/api/experimental/session/ses_A/log?follow=false'))
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
    res.writeHead(307, { location: destination.endpoint + '/api/session/ses_A/prompt' }); res.end()
  })
  t.after(destination.close); t.after(source.close)
  const transport = createOpenCodeV2ExecutionTransport(config(source.endpoint)); t.after(() => transport.dispose())
  const error = await captureFailure(transport.fetch(source.endpoint + '/api/session/ses_A/prompt', {
    method: 'POST', body: JSON.stringify(prompt),
  }))
  assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
  assert.equal(sourceEffects, 1)
  assert.equal(destinationEffects, 0)
})

test('V2 transport denies foreign session GET/POST/SSE before credentials or HTTP', async t => {
  const requested: string[] = []
  const host = await peer((req, res) => {
    requested.push(req.method + ' ' + req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  t.after(() => transport.dispose())
  for (const [path, init] of [
    ['/api/session/ses_B', undefined],
    ['/api/session/ses_B/inbox', undefined],
    ['/api/session/ses_B/message?limit=200', undefined],
    ['/api/experimental/session/ses_B/log?follow=false', undefined],
    ['/api/session/ses_B/prompt', { method: 'POST', body: JSON.stringify(prompt) }],
    ['/api/session/ses_A%2fother', undefined],
  ] as const) {
    const fail = await captureFailure(transport.fetch(host.endpoint + path, init))
    assert.equal(wasOpenCodeV2InputNotSubmitted(fail), true, path)
  }
  assert.deepEqual(requested, [])
  const own = await transport.fetch(host.endpoint + '/api/session/ses_A')
  assert.equal(own.status, 200)
  assert.deepEqual(requested, ['GET /api/session/ses_A'])
})

test('V2 execution wire bounds tiny native response chunks before memory fanout', async t => {
  let reads = 0, cancelled = 0, invoked = 0
  const reader = {
    async read() {
      reads++
      return reads <= 9000 ? { done: false, value: Uint8Array.of(65) } : { done: true, value: undefined }
    },
    async cancel() { cancelled++ },
    releaseLock() {},
  }
  const endpoint = 'http://127.0.0.1:12345'
  const transport = createOpenCodeV2ExecutionTransport({ ...config(endpoint),
    fetchImpl: async () => {
      invoked++
      return { status: 200, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  })
  t.after(() => transport.dispose())
  const failure = await captureFailure(transport.fetch(endpoint + '/api/session/ses_A'))
  assert(failure instanceof Error)
  assert.equal((failure as { code?: string }).code, 'body_limit')
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  assert.equal(invoked, 1)
  assert.equal(reads, 8193)
  assert.equal(cancelled, 1)
})

test('V2 outgoing prompt body bounds tiny and empty stream chunks before credentials or native fetch', async t => {
  const endpoint = 'http://127.0.0.1:12345'
  for (const chunk of [Uint8Array.of(123), new Uint8Array(0)]) {
    let pulls = 0, cancelled = 0, credentials = 0, fetches = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(chunk) },
      cancel() { cancelled++ },
    })
    const transport = createOpenCodeV2ExecutionTransport({
      ...config(endpoint),
      readPassword: () => { credentials++; return 'TEST_PRIVATE_PASSWORD' },
      fetchImpl: async () => { fetches++; return new Response('{}') },
    })
    t.after(() => transport.dispose())
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
    const failure = await captureFailure(transport.fetch(endpoint + '/api/session/ses_A/prompt', init))
    assert(failure instanceof Error)
    assert.equal((failure as { code?: string }).code, 'body_limit')
    assert.equal(wasOpenCodeV2InputNotSubmitted(failure), true)
    assert(pulls >= 8193, 'must exercise actual stream chunk fanout')
    assert.equal(cancelled, 1)
    assert.equal(credentials, 0)
    assert.equal(fetches, 0)
    await transport.dispose()
  }
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
  const request = new Request(host.endpoint + '/api/session/ses_A/prompt', init)
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
    const error = await captureFailure(transport.fetch(host.endpoint + '/api/session/ses_A'))
    await closing
    await transport.dispose()
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
  }
  assert.equal(nativeCalls, 0)
})

test('V2 Session SPI refuses all direct native creates until Host proves effective permissions', async t => {
  let nativeCalls = 0
  const host = await peer((_req, res) => {
    nativeCalls++
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end('{"data":{"id":"ses_unsafe"}}')
  })
  t.after(host.close)
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint, version))
    t.after(() => transport.dispose())
    // V2 defaults external_directory to allow. Even an apparently restrictive
    // payload is insufficient without captured Host policy and native custody.
    for (const body of [
      { location: { directory: '/TEST/original' } },
      { location: { directory: '/TEST/original' },
        permissions: [{ action: 'external_directory', resource: '*', effect: 'allow' }] },
      { location: { directory: '/TEST/original' },
        permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' }] },
      { location: { directory: '/TEST/original' },
        permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' },
          { action: 'external_directory', resource: '*', effect: 'ask' }] },
      { location: { directory: '/TEST/original' }, plugins: ['V1-plugin'] },
    ]) {
      const error = await captureFailure(transport.fetch(host.endpoint + '/api/session', {
        method: 'POST', body: JSON.stringify(body),
      }))
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true, JSON.stringify(body))
    }
  }
  assert.equal(nativeCalls, 0)
})

test('V2 execution response does not expose native private response headers', async t => {
  const host = await peer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-private-path': 'TEST_PRIVATE_NATIVE_PATH',
      'set-cookie': 'TEST_PRIVATE_SESSION_COOKIE',
    })
    res.end('{"data":{"id":"ses_A"}}')
  })
  t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport(config(host.endpoint))
  t.after(() => transport.dispose())
  const response = await transport.fetch(host.endpoint + '/api/session/ses_A')
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('x-private-path'), null)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(await response.json(), { data: { id: 'ses_A' } })
})

test('V2 execution wire rejects unconfirmed outgoing reader cleanup before native HTTP', async t => {
  const endpoint = 'http://127.0.0.1:12345'
  let pulls = 0, cancellations = 0, credentials = 0, fetches = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(Uint8Array.of(123)) },
    cancel() { cancellations++; throw new Error('TEST_PRIVATE_REQUEST_CANCEL') },
  })
  const transport = createOpenCodeV2ExecutionTransport({
    ...config(endpoint),
    readPassword: () => { credentials++; return 'TEST_PRIVATE_PASSWORD' },
    fetchImpl: async () => { fetches++; return new Response('{}') },
  })
  t.after(() => transport.dispose())
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
  const failure = await captureFailure(transport.fetch(endpoint + '/api/session/ses_A/prompt', init))
  assert(failure instanceof Error)
  assert.equal((failure as { code?: string }).code, 'cleanup_unknown')
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  assert.doesNotMatch(failure.message, /TEST_PRIVATE_REQUEST_CANCEL/)
  assert(pulls >= 8193)
  assert.equal(cancellations, 1)
  assert.equal(credentials, 0)
  assert.equal(fetches, 0)
})

test('V2 execution wire refuses a native response reader whose cancel rejects', async t => {
  const endpoint = 'http://127.0.0.1:12345'
  let reads = 0, cancellations = 0, fetches = 0
  const transport = createOpenCodeV2ExecutionTransport({
    ...config(endpoint),
    fetchImpl: async () => {
      fetches++
      return {
        status: 200, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => ({
          async read() { reads++; return { done: false, value: Uint8Array.of(65) } },
          async cancel() { cancellations++; throw new Error('TEST_PRIVATE_RESPONSE_CANCEL') },
          releaseLock() {},
        }) },
      } as unknown as Response
    },
  })
  t.after(() => transport.dispose())
  const failure = await captureFailure(transport.fetch(endpoint + '/api/session/ses_A'))
  assert(failure instanceof Error)
  assert.equal((failure as { code?: string }).code, 'cleanup_unknown')
  assert.equal(wasOpenCodeV2InputNotSubmitted(failure), false)
  assert.doesNotMatch(failure.message, /TEST_PRIVATE_RESPONSE_CANCEL/)
  assert.equal(fetches, 1)
  assert.equal(reads, 8193)
  assert.equal(cancellations, 1)
})

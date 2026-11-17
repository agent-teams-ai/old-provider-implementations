import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createDriverNative } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-native.ts'
import { readOpenCodeV2NativeCut } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-cut.ts'
import type { OpenCodeV2DriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'

const sessionID = 'ses_TESToriginal', inputID = 'msg_TESToriginal'
const directory = resolve('TEST/v2-read-cut-settlement')
const original = { nativeInputID: inputID, beforeCursor: null, text: 'TEST original read' }

test('a failed final HTTP sibling drains its original aborted fetch before native driver disposal', { timeout: 15_000 }, async t => {
  const sockets = new Set<Socket>(), exits: Promise<void>[] = [], failures: unknown[] = []
  const requests: string[] = []
  let sessionReads = 0, logReads = 0, closedRequests = 0
  let finalSession: ServerResponse | undefined, finalLog: ServerResponse | undefined
  let closeFinal!: () => void
  const finalClosed = new Promise<void>(resolveClose => { closeFinal = resolveClose })
  const failPair = () => { if (finalSession && finalLog) finalLog.destroy() }
  const server = createServer((request, response) => {
    try {
      assert.equal(request.method, 'GET')
      assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('opencode:TEST-password').toString('base64'))
      assert.ok(request.url && requests.length < 5)
      requests.push(request.url)
      request.once('close', () => { closedRequests++ })
      if (request.url === '/api/session/' + sessionID) {
        if (++sessionReads === 2) {
          finalSession = response
          request.once('close', closeFinal)
          failPair()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: { id: sessionID, location: { directory }, agent: 'build',
          model: { providerID: 'TEST-local', id: 'TEST-model' }, time: { created: 1 } } }))
      } else if (request.url === '/api/experimental/session/' + sessionID + '/log?follow=false') {
        if (++logReads === 2) { finalLog = response; failPair(); return }
        response.setHeader('content-type', 'text/event-stream')
        response.end('data: ' + JSON.stringify({ type: 'log.synced', aggregateID: sessionID, seq: 0 }) + '\n\n')
      } else {
        assert.equal(request.url, '/api/session/' + sessionID + '/message?limit=200&order=asc')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }))
      }
    } catch (error) { failures.push(error); response.destroy() }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    exits.push(new Promise<void>(resolveExit => socket.once('close', () => { sockets.delete(socket); resolveExit() })))
  })
  t.after(async () => {
    const closed = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    server.closeAllConnections()
    await closed
    await Promise.all(exits)
    assert.equal(sockets.size, 0)
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done() })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const config: OpenCodeV2DriverConfig = {
    binding: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1 },
    configRevision: 'TEST-revision', trustedBinding: 'TEST-binding', accountBinding: 'TEST-account',
    endpoint: 'http://127.0.0.1:' + address.port, directory, nativeSessionId: sessionID, version: '2.1.4',
    readPassword: () => 'TEST-password', probe: async () => true, confirmStopped: async () => false,
    limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 32768, outputEvents: 128, pendingInteractions: 1, timeoutMs: 5000 },
  }
  const native = createDriverNative(config, new AbortController().signal)
  const failure = await native.read(original).then(() => { assert.fail('A failed cut cannot become successful') }, error => error as unknown)
  assert.ok(failure instanceof Error)
  await assert.doesNotReject(native.dispose(), 'the original fetch rejection must settle before classifying cleanup')
  assert.equal(failure.message, 'invalid_native_read_response')
  await finalClosed
  assert.deepEqual(failures, [])
  assert.equal(closedRequests, 5)
  assert.deepEqual(requests.slice(0, 3), ['/api/session/' + sessionID,
    '/api/experimental/session/' + sessionID + '/log?follow=false',
    '/api/session/' + sessionID + '/message?limit=200&order=asc'])
  assert.deepEqual(requests.slice(3).sort(), ['/api/session/' + sessionID,
    '/api/experimental/session/' + sessionID + '/log?follow=false'].sort())
})

for (const mode of ['settled', 'unknown', 'at-deadline'] as const) test(
  `aborted native read retains ${mode} deferred rejection without another request`, async t => {
    const controller = new AbortController()
    let requested = 0, aborted = 0, rejected = 0, now = 0
    let settling: Promise<void> | undefined
    t.after(async () => { await settling })
    t.mock.method(Date, 'now', () => now)
    const transport = {
      signal: controller.signal,
      check() {},
      fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        requested++
        const signal = init?.signal
        assert.ok(signal && !signal.aborted)
        queueMicrotask(() => controller.abort())
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted++
            // Real fetch rejection can settle after its abort event and the bounded wait.
            settling = new Promise<void>(done => setImmediate(() => {
              if (mode === 'at-deadline') now = 1000
              rejected++
              reject(new Error(mode === 'unknown' ? 'native_read_cleanup_unknown' : 'TEST_PRIVATE_FETCH_FAILURE'))
              done()
            }))
          }, { once: true })
        })
      },
    }
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.1.4' }, original),
    (error: unknown) => error instanceof Error && error.message ===
      (mode === 'settled' ? 'invalid_native_read_response' : 'native_read_cleanup_unknown'))
    // Include callbacks before leaving this original fixture even when the old implementation fails early.
    await new Promise<void>(done => setImmediate(done))
    assert.deepEqual({ requested, aborted, rejected }, { requested: 1, aborted: 1, rejected: 1 })
  }
)

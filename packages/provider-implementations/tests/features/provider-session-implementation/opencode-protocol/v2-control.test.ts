import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, createOpenCodeV2SessionControl, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'
import { createV2ControlWire } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-control-transport.ts'

async function peer() {
  const effects: Array<{ path: string; body: unknown }> = []
  let foreign = false, loseReceipt = false, flatPermissions = false, flatInstructions = false, invalidPermissionId = false, malformedPermissionSource = false, validPermissionSource = false, calls = 0
  const server = createServer((req, res) => {
    calls++
    const url = new URL(req.url!, 'http://TEST.invalid')
    const sessionID = url.pathname.includes('ses_A') ? 'ses_A' : 'ses_B'
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      const permission = { id: (invalidPermissionId ? 'request_' : 'per_') + sessionID, sessionID: foreign ? 'ses_foreign' : sessionID, action: 'TEST.tool', resources: ['TEST-resource'],
        ...(malformedPermissionSource ? { source: { type: 'tool', messageID: 'msg_BAD%2froute', id: 'TEST-tool-call' } }
          : validPermissionSource ? { source: { type: 'tool', messageID: 'msg_TESTowned', id: 'TEST-tool-call' } } : {}) }
      if (url.pathname.endsWith('/permission')) {res.end(JSON.stringify(flatPermissions ? [permission] : { data: [permission] }))}
      else if (url.pathname.includes('/permission/')) {res.end(JSON.stringify(flatPermissions ? permission : { data: permission }))}
      else {res.end(JSON.stringify(flatInstructions ? [] : { data: [] }))}
      return
    }
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      if (text) {assert.equal(req.headers['content-type'], 'application/json')}
      effects.push({ path: req.url!, body: text ? JSON.parse(text) : null })
      if (loseReceipt) { req.socket.destroy(); return }
      if (url.pathname.endsWith('/interrupt')) {res.end('{"interrupted":true}')}
      else { res.writeHead(204); res.end() }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, effects,
    setForeign: () => { foreign = true }, loseReceipt: () => { loseReceipt = true }, flatPermissions: () => { flatPermissions = true }, flatInstructions: () => { flatInstructions = true }, invalidPermissionId: () => { invalidPermissionId = true },
    malformedPermissionSource: () => { malformedPermissionSource = true },
    validPermissionSource: () => { validPermissionSource = true }, calls: () => calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}

test('V2 raw control wire never forwards caller headers with native credentials', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const endpoint = 'http://127.0.0.1:12345'
    const seen: string[][] = []
    const wire = createV2ControlWire({
      endpoint, directory: '/TEST/original', version, nativeSessionId: 'ses_A',
      deadline: Date.now() + 10_000, readPassword: () => 'TEST-private',
      fetchImpl: async (nativeRequest, init) => {
        assert(nativeRequest instanceof Request)
        const headers = new Headers(init?.headers)
        seen.push([...headers.keys()].sort())
        assert.deepEqual([...nativeRequest.headers.keys()].sort(), [...headers.keys()].sort())
        assert.equal(nativeRequest.credentials, 'omit')
        assert.equal(nativeRequest.redirect, 'error')
        assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from('opencode:TEST-private').toString('base64'))
        for (const untrusted of ['cookie', 'x-forwarded-host', 'x-test-secret']) {
          assert.equal(headers.get(untrusted), null)
        }
        return seen.length === 1
          ? new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(null, { status: 204 })
      },
    })
    t.after(wire.dispose)
    const injected = { authorization: 'Bearer TEST_UNTRUSTED', cookie: 'TEST_COOKIE',
      'x-forwarded-host': 'TEST-foreign.invalid', 'x-test-secret': 'TEST_SENTINEL', 'content-type': 'text/plain' }
    await wire.request('/api/session/ses_A/permission', { headers: injected, credentials: 'include', redirect: 'follow' })
    await wire.request('/api/session/ses_A/permission/per_TEST/reply', {
      method: 'POST', headers: injected, credentials: 'include', redirect: 'follow',
      body: JSON.stringify(version === '2.0.0' ? { reply: 'reject' } : { decision: 'reject' }),
    })
    assert.deepEqual(seen, [['authorization'], ['authorization', 'content-type']])
  }
})


test('raw V2 credential-bearing wires reject noncanonical workspace bindings before native access', () => {
  // Public factories can be called without the private DriverConfig snapshot.
  // A malformed directory must not bind a credential to an unverified workspace.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    let credentials = 0, nativeCalls = 0
    const options = {
      endpoint: 'http://127.0.0.1:12345', version, nativeSessionId: 'ses_A',
      deadline: Date.now() + 10_000,
      readPassword: () => { credentials++; return 'TEST-private' },
      fetchImpl: async () => { nativeCalls++; return new Response('{}') },
    }
    for (const directory of [
      '', '/TEST/owner/../neighbor', '/TEST/owner/', ['/TEST/owner'],
    ] as unknown[]) {
      const config = { ...options, directory: directory as string }
      assert.throws(() => createV2ControlWire(config), /authority_mismatch/)
      assert.throws(() => createOpenCodeV2SessionControl(config), /authority_mismatch/)
      assert.throws(() => createOpenCodeV2ExecutionTransport(config), /authority_mismatch/)
    }
    assert.equal(credentials, 0)
    assert.equal(nativeCalls, 0)
  }
})

test('bound native control translates both dialects without touching neighboring session or host', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    const a = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    const b = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_B', readPassword: () => 'TEST-private' })
    t.after(a.dispose); t.after(b.dispose)
    assert.deepEqual(await a.interrupt(), { interrupted: true })
    await a.replyPermission('per_ses_A', 'reject')
    await a.cancelInbox('msg_original')
    await a.putInstruction('test.role', { role: 'TEST' })
    assert.equal((await b.pendingPermissions())[0]?.sessionId, 'ses_B')
    assert.deepEqual(await a.instructions(), [])
    assert.deepEqual(host.effects, [
      { path: `/api/session/ses_A/interrupt?${version === '2.0.0' ? 'continue' : 'resume'}=false`, body: null },
      { path: '/api/session/ses_A/permission/per_ses_A/reply', body: { [version === '2.0.0' ? 'reply' : 'decision']: 'reject' } },
      { path: '/api/session/ses_A/inbox/msg_original', body: null },
      { path: `${version === '2.0.0' ? '/api/session' : '/api/experimental/session'}/ses_A/instructions/entries/test.role`, body: { value: { role: 'TEST' } } },
    ])
    host.setForeign()
    await assert.rejects(a.replyPermission('per_ses_A', 'once'), error => { assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true })
    assert.equal(host.effects.length, 4)
  }
})

test('V2 control uses the same bounded session ID alphabet as its native driver', async t => {
  const host = await peer(); t.after(host.close)
  for (const nativeSessionId of ['ses_A-1', 'ses_A_1']) {
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original',
      version: '2.0.21', deadline: Date.now() + 10_000, nativeSessionId,
      readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    assert.deepEqual(await control.interrupt(), { interrupted: true })
    assert.equal(host.effects.at(-1)?.path, '/api/session/' + nativeSessionId + '/interrupt?resume=false')
  }
  const before = host.calls()
  for (const nativeSessionId of ['ses_A/foreign', 'ses_A%2Fforeign', 'ses_' + 'x'.repeat(257)]) {
    assert.throws(() => createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version: '2.0.21', deadline: Date.now() + 10_000,
      nativeSessionId, readPassword: () => 'TEST-private' }))
  }
  assert.equal(host.calls(), before)
})

test('raw V2 control rejects coerced or unqualified loopback endpoints before any native activity', async t => {
  // The control wire can be constructed without the private DriverConfig
  // snapshot. A JSON array must never be accepted by RegExp coercion.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentials = 0
    const options = {
      directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentials++; return 'TEST-private' },
    }
    const invalidEndpoints: unknown[] = [
      [host.endpoint],
      'http://127.0.0.1:65536',
      'http://127.0.0.1:100000',
      'http://127.0.0.1:00080',
      'http://localhost:14321',
    ]
    for (const endpoint of invalidEndpoints) {
      assert.throws(() => createV2ControlWire({
        ...options, endpoint: endpoint as string,
      }), /authority_mismatch/, JSON.stringify(endpoint))
      assert.throws(() => createOpenCodeV2SessionControl({
        ...options, endpoint: endpoint as string,
      }), /authority_mismatch/, JSON.stringify(endpoint))
    }
    assert.equal(credentials, 0)
    assert.equal(host.calls(), 0)
    assert.deepEqual(host.effects, [])
  }
})

test('native permission effect with lost response remains unknown and is not replayed', async t => {
  const host = await peer(); t.after(host.close); host.loseReceipt()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  assert.equal(host.effects.length, 1)
})

test('control credential callback revocation is checked before native invocation', async t => {
  const host = await peer(); t.after(host.close)
  const abort = new AbortController()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', signal: abort.signal,
    readPassword: () => { abort.abort(); return 'TEST-private' } })
  await assert.rejects(control.interrupt(), error => { assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true })
  await control.dispose()
  assert.equal(host.calls(), 0)
})


test('raw V2 control rechecks the deadline after reading a mutation body before credentials', async t => {
  // Simulate the deadline expiring after the initial admission and both
  // native Request body reads. The fifth clock read is the required pre-
  // credential recheck; without it readPassword() would be called.
  const baseline = Date.now()
  let clockReads = 0, credentialReads = 0, nativeFetches = 0
  t.mock.method(Date, 'now', () => ++clockReads <= 4 ? baseline : baseline + 20_000)
  const raw = createV2ControlWire({
    endpoint: 'http://127.0.0.1:12345', directory: '/TEST/original',
    version: '2.0.21', deadline: baseline + 10_000, nativeSessionId: 'ses_A',
    readPassword: () => { credentialReads++; return 'TEST-private' },
    fetchImpl: async () => { nativeFetches++; return new Response('{}') },
  })
  t.after(raw.dispose)
  await assert.rejects(raw.request('/api/session/ses_A/permission/per_ses_A/reply', {
    method: 'POST', body: JSON.stringify({ decision: 'reject' }),
  }), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
    return true
  })
  assert.equal(credentialReads, 0, 'expired request must not project Host credentials')
  assert.equal(nativeFetches, 0, 'expired request must not invoke native HTTP')
})

test('V2 durable always-approval is refused even via raw control wire without native reads or writes', async t => {
  // Native V2 "always" persists a project-scoped allow rule. Host has not yet
  // qualified control of those durable approvals or effective permission order.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    const options = { endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' }
    const control = createOpenCodeV2SessionControl(options)
    const raw = createV2ControlWire(options)
    t.after(control.dispose); t.after(raw.dispose)

    await assert.rejects(control.replyPermission('per_ses_A', 'always'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })

    const key = version === '2.0.0' ? 'reply' : 'decision'
    await assert.rejects(raw.request('/api/session/ses_A/permission/per_ses_A/reply', {
      method: 'POST', body: JSON.stringify({ [key]: 'always' }),
    }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })
    assert.equal(host.calls(), 0, 'no native GET or mutation before Host approval custody')
    assert.deepEqual(host.effects, [])
  }
})

test('raw V2 instruction PUT enforces the durable value byte budget before credentials or native effects', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentials = 0
    const raw = createV2ControlWire({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentials++; return 'TEST-private' } })
    t.after(raw.dispose)
    const entries = version === '2.0.0' ? '/api/session/ses_A/instructions/entries'
      : '/api/experimental/session/ses_A/instructions/entries'
    await assert.rejects(raw.request(entries + '/test.role', {
      method: 'PUT', body: JSON.stringify({ value: 'X'.repeat(256 * 1024 + 1) }),
    }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      return true
    })
    assert.equal(credentials, 0)
    assert.equal(host.calls(), 0)
    assert.deepEqual(host.effects, [])
  }
})

test('typed V2 instruction preflight is not-submitted for over-budget and non-JSON values', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentialReads = 0
    const control = createOpenCodeV2SessionControl({
      endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentialReads++; return 'TEST-private' },
    })
    t.after(control.dispose)
    for (const value of ['X'.repeat(256 * 1024 + 1), undefined, Number.POSITIVE_INFINITY]) {
      await assert.rejects(control.putInstruction('test.role', value), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
        return true
      })
    }
    assert.equal(credentialReads, 0)
    assert.equal(host.calls(), 0)
    assert.deepEqual(host.effects, [])
  }
})

test('invalid untyped permission decision is refused before any native read or mutation', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('per_ses_A', 'unqualified' as 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(host.calls(), 0)
})

test('legacy flat V1-style permission responses cannot issue a native V2 grant', async t => {
  const host = await peer(); t.after(host.close); host.flatPermissions()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.pendingPermissions(), /invalid_native_envelope/)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.deepEqual(host.effects, [])
})

test('V2 instructions list requires the pinned data envelope', async t => {
  const host = await peer(); t.after(host.close); host.flatInstructions()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.instructions(), /invalid_native_envelope/)
  assert.deepEqual(host.effects, [])
})

test('pinned V2 permission IDs reject old-format input and malformed native replies before grant', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('request_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(host.calls(), 0)
  host.invalidPermissionId()
  await assert.rejects(control.pendingPermissions(), /invalid_native_permission_id/)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.deepEqual(host.effects, [])
})

test('malformed V2 control identifiers cannot reach a native route or mutate another session', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original',
    version: '2.0.21', deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
    readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  for (const requestId of ['per', 'request_ses_A', 'per/foreign', 'per?decision=always']) {
    await assert.rejects(control.replyPermission(requestId, 'once'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, requestId)
  }
  for (const inboxId of ['', 'msg_', 'msg_A/../other', '..', 'msg_A%2Fother', 'ses_foreign']) {
    await assert.rejects(control.cancelInbox(inboxId), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, inboxId)
  }
  for (const key of ['', '.', '..', '../permission', 'foreign/key', '%2E%2E', 'A', 'valid?bad']) {
    await assert.rejects(control.putInstruction(key, { value: 'TEST' }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, key)
  }
  // Runtime JS callers can bypass TypeScript: RegExp.test and URL encoding
  // otherwise coerce a one-element array into a valid native mutation route.
  for (const untyped of [
    ['per_ses_A'], { toString: () => 'per_ses_A' },
  ]) {
    await assert.rejects(control.replyPermission(untyped as unknown as string, 'once'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })
  }
  for (const untyped of [
    ['test.role'], { toString: () => 'test.role' },
  ]) {
    await assert.rejects(control.putInstruction(untyped as unknown as string, { value: 'TEST' }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })
  }
  assert.equal(host.calls(), 0)
  assert.deepEqual(host.effects, [])
})


test('malformed native permission source message ID never permits a control grant', async t => {
  // Tool-origin permissions must carry a real bounded V2 msg_ ID, not a URL
  // escape that could be confused with another resource or an old V1 ID.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close); host.malformedPermissionSource()
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version, deadline: Date.now() + 10_000,
      nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    await assert.rejects(control.pendingPermissions(), /invalid_native_permission_source/)
    await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      return true
    })
    assert.deepEqual(host.effects, [], 'malformed source cannot produce a native POST')
  }
})


test('raw V2 control refuses untyped native response chunks with confirmed cleanup', async t => {
  // A malicious/injected ReadableStream can yield strings despite TS body types.
  // byteLength would be undefined, turning the byte budget into NaN.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    let nativeCalls = 0, cancellations = 0
    const raw = createV2ControlWire({
      endpoint: 'http://127.0.0.1:12345', directory: '/TEST/original',
      version, nativeSessionId: 'ses_A', deadline: Date.now() + 10_000,
      readPassword: () => 'TEST-private',
      fetchImpl: async () => {
        nativeCalls++
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue('TEST_PRIVATE_NATIVE_PAYLOAD') },
          cancel() { cancellations++ },
        }), { headers: { 'content-type': 'application/json' } })
      },
    })
    t.after(raw.dispose)
    await assert.rejects(raw.request('/api/session/ses_A/permission'), (error: unknown) => {
      assert(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'invalid_response')
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      assert.doesNotMatch(error.message, /TEST_PRIVATE_NATIVE_PAYLOAD/)
      return true
    })
    assert.equal(nativeCalls, 1)
    assert.equal(cancellations, 1)
  }
})

test('V2 control wire bounds tiny native response chunks before memory fanout', async t => {
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
  const raw = createV2ControlWire({ endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private',
    fetchImpl: async () => {
      invoked++
      return { status: 200, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  })
  t.after(raw.dispose)
  await assert.rejects(raw.request('/api/session/ses_A/permission'), error => {
    assert(error instanceof Error)
    assert.equal((error as { code?: string }).code, 'body_limit')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  assert.equal(invoked, 1)
  assert.equal(reads, 8193)
  assert.equal(cancelled, 1)
})

test('session-bound control denies global MCP mutation and discovery before credentials', async t => {
  // MCP in V2 belongs to the trusted Host/project configuration boundary.
  // A session permission or interrupt capability must not turn into access
  // to the global MCP registry, even on the same authenticated loopback.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentials = 0
    const raw = createV2ControlWire({
      endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentials++; return 'TEST-private' },
    })
    t.after(raw.dispose)
    for (const [path, method] of [
      ['/api/mcp', 'GET'],
      ['/api/mcp/resource', 'GET'],
      ['/api/experimental/mcp/TEST-foreign', 'PUT'],
      ['/api/experimental/mcp/TEST-foreign/connect', 'POST'],
      ['/api/experimental/mcp/TEST-foreign/disconnect', 'POST'],
      ['/api/experimental/mcp/TEST-foreign', 'DELETE'],
    ] as const) {
      await assert.rejects(raw.request(path, { method }), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
        return true
      }, path)
    }
    assert.equal(credentials, 0, 'global MCP routes cannot request Host credentials')
    assert.equal(host.calls(), 0, 'no global MCP HTTP effects')
    assert.deepEqual(host.effects, [])
  }
})

test('native V2 tool-origin permission keeps valid message lineage and allows only explicit once', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close); host.validPermissionSource()
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version, deadline: Date.now() + 10_000,
      nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    const permissions = await control.pendingPermissions()
    assert.deepEqual(permissions[0]?.source,
      { type: 'tool', messageID: 'msg_TESTowned', id: 'TEST-tool-call' })
    await control.replyPermission('per_ses_A', 'once')
    assert.deepEqual(host.effects, [{ path: '/api/session/ses_A/permission/per_ses_A/reply',
      body: { [version === '2.0.0' ? 'reply' : 'decision']: 'once' } }])
  }
})

test('V2 typed permission preflight preserves unknown native reader cleanup without granting', async t => {
  // The permission GET is a read, but an unconfirmed reader cancellation means
  // its native IO custody is UNKNOWN. It must not become a clean not-submitted
  // grant result when the typed API wraps its preflight failure.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    let nativeCalls = 0
    const control = createOpenCodeV2SessionControl({
      endpoint: 'http://127.0.0.1:12345', directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => 'TEST-private',
      fetchImpl: async () => {
        nativeCalls++
        return new Response(new ReadableStream({
          start(controller) { controller.error(new Error('TEST_PRIVATE_PRECHECK_READ')) },
        }), { headers: { 'content-type': 'application/json' } })
      },
    })
    t.after(control.dispose)
    await assert.rejects(control.replyPermission('per_ses_A', 'once'), (error: unknown) => {
      assert(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'cleanup_unknown')
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      assert.doesNotMatch(error.message, /TEST_PRIVATE_PRECHECK_READ/)
      return true
    })
    assert.equal(nativeCalls, 1, 'preflight GET must not be followed by a permission mutation')
  }
})

test('V2 raw control wire refuses to mask a rejected native reader cancellation', async t => {
  const endpoint = 'http://127.0.0.1:12345'
  let reads = 0, cancellations = 0
  const raw = createV2ControlWire({
    endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
    readPassword: () => 'TEST-private',
    fetchImpl: async () => ({
      status: 200, redirected: false, url: '',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        async read() { reads++; return { done: false, value: Uint8Array.of(65) } },
        async cancel() { cancellations++; throw new Error('TEST_PRIVATE_CANCEL_DETAIL') },
        releaseLock() {},
      }) },
    }) as unknown as Response,
  })
  t.after(raw.dispose)
  await assert.rejects(raw.request('/api/session/ses_A/permission'), (error: unknown) => {
    assert(error instanceof Error)
    assert.equal((error as { code?: string }).code, 'cleanup_unknown')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    assert.doesNotMatch(error.message, /TEST_PRIVATE_CANCEL_DETAIL/)
    return true
  })
  assert.equal(reads, 8193)
  assert.equal(cancellations, 1)
})

test('V2 raw control does not relay native diagnostic headers', async t => {
  const endpoint = 'http://127.0.0.1:12345'
  const raw = createV2ControlWire({
    endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
    readPassword: () => 'TEST-private',
    fetchImpl: async () => new Response('{"data":[]}', {
      headers: {
        'content-type': 'application/json',
        'x-private-path': 'TEST_PRIVATE_NATIVE_PATH',
        'set-cookie': 'TEST_PRIVATE_SESSION_COOKIE',
      },
    }),
  })
  t.after(raw.dispose)
  const result = await raw.request('/api/session/ses_A/permission')
  assert.equal(result.headers.get('content-type'), 'application/json')
  assert.equal(result.headers.get('x-private-path'), null)
  assert.equal(result.headers.get('set-cookie'), null)
  assert.deepEqual(await result.json(), { data: [] })
})
